/**
 * SyncServer — client-side WebSocket wrapper. Implements spec doc/03
 * §3.x: Init handshake, heartbeat, serial request queue.
 *
 * State machine:
 *   disconnected ──connect()──▶ connecting ──init ok──▶ ready
 *                                          ──init err──▶ disconnected
 *   ready        ──disconnect()──▶ closing ──onclose──▶ disconnected
 *
 * Heartbeat (spec §3.4):
 *   - setInterval(HEARTBEAT_PING_INTERVAL_MS) — every 20s, check idle.
 *   - elapsed > HEARTBEAT_PROBE_AFTER_MS (10s) → send {op:"ping"}.
 *   - elapsed > HEARTBEAT_TIMEOUT_MS (120s)   → disconnect("idle timeout").
 *
 * request() — spec §3.6:
 *   - Send JSON via socket; await next text frame (FIFO match, no op
 *     correlation per spec §3.7 "顺序就是身份").
 *   - timeoutMs (default REQUEST_TIMEOUT_MS = 60s) → disconnect + throw
 *     Error("Timeout").
 *
 * Binary frames: forced binaryType = "arraybuffer". Spec §2 — Obsidian's
 * default Blob deserialization corrupts byte streams; we pin this in
 * the constructor and again before each connect.
 */

import { WebSocket } from 'ws';
import {
  CHUNK_SIZE,
  CloseCode,
  getCloseReason,
  HEARTBEAT_PING_INTERVAL_MS,
  HEARTBEAT_PROBE_AFTER_MS,
  HEARTBEAT_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  type InitFrame,
  type InitResponseOk,
  type PushControlFrame,
  type PullMetaFrame,
} from '@obsync/proto';

export type ClientState = 'disconnected' | 'connecting' | 'ready' | 'closing';

export interface SyncServerOptions {
  /**
   * Heartbeat sweep interval override (ms). Defaults to spec
   * HEARTBEAT_PING_INTERVAL_MS (20s); tests use a much smaller value to
   * exercise probe/idle-timeout paths without faketimer plumbing.
   */
  heartbeatSweepMs?: number;
  /** Override probe threshold for tests. */
  probeAfterMs?: number;
  /** Override hard-idle threshold for tests. */
  idleTimeoutMs?: number;
  /** Default per-request timeout. Spec §3.6 → 60s. */
  defaultRequestTimeoutMs?: number;
  /**
   * Optional callback invoked when the connection transitions to
   * `disconnected` (either spontaneously or via disconnect()). Carries
   * the close code + reason for log/UI purposes.
   */
  onClose?: (info: { code: number; reason: string }) => void;
  /**
   * Optional "any inbound frame" listener — called BEFORE the internal
   * dispatch (pending request resolution, pong handling). Useful for
   * tests; not used by production code.
   */
  onMessage?: (msg: unknown) => void;
  /**
   * Server-push (`{op:"push", uid, ...}`) callback. Invoked on every
   * unsolicited push frame from the server — spec doc/04 §3.7. The
   * raw frame is forwarded as-is (ciphertext paths/hashes); decoding
   * and `justPushed` 5-tuple dedupe live in the sync-plugin layer
   * (P5), not here.
   */
  onServerPush?: (frame: unknown) => void;
  /**
   * Optional `{op:"initial-done"}` callback. The server emits this once
   * the post-init replay stream has been fully written. Until the
   * client receives it, `_sync.pushOrphans()` refuses to push deletes
   * (see spec 05b §3.6 / `doc/edge-tests/00-候选清单-Claude侧.md` A9).
   */
  onInitialDone?: (frame: unknown) => void;
  /**
   * Optional WebSocket factory; defaults to `new WebSocket(url)`. Tests
   * inject a fake to avoid real sockets.
   */
  wsFactory?: (url: string) => WebSocket;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  op: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingBinary {
  resolve: (buf: ArrayBuffer) => void;
  reject: (e: Error) => void;
}

export class SyncServer {
  private ws: WebSocket | null = null;
  private _state: ClientState = 'disconnected';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pending: PendingRequest[] = [];
  private pendingBinary: PendingBinary[] = [];
  /**
   * Buffered binary frames that arrived before a `responseBinary()`
   * waiter was registered. The server may send multiple binary frames
   * back-to-back after the pull meta frame, faster than the client's
   * `await` cycles. We queue them and drain via responseBinary().
   */
  private binaryBuf: ArrayBuffer[] = [];
  private lastSeenAt = 0;
  private closeInfo: { code: number; reason: string } | null = null;

  private readonly heartbeatSweepMs: number;
  private readonly probeAfterMs: number;
  private readonly idleTimeoutMs: number;
  private readonly defaultRequestTimeoutMs: number;
  private readonly onCloseCb: ((info: { code: number; reason: string }) => void) | undefined;
  private readonly onMessageCb: ((msg: unknown) => void) | undefined;
  private readonly onServerPushCb: ((frame: unknown) => void) | undefined;
  private readonly onInitialDoneCb: ((frame: unknown) => void) | undefined;
  private readonly wsFactory: (url: string) => WebSocket;

  constructor(
    public readonly url: string,
    opts: SyncServerOptions = {},
  ) {
    this.heartbeatSweepMs = opts.heartbeatSweepMs ?? HEARTBEAT_PING_INTERVAL_MS;
    this.probeAfterMs = opts.probeAfterMs ?? HEARTBEAT_PROBE_AFTER_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.defaultRequestTimeoutMs = opts.defaultRequestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.onCloseCb = opts.onClose;
    this.onMessageCb = opts.onMessage;
    this.onServerPushCb = opts.onServerPush;
    this.onInitialDoneCb = opts.onInitialDone;
    this.wsFactory = opts.wsFactory ?? ((u) => new WebSocket(u));
  }

  get state(): ClientState {
    return this._state;
  }

  /**
   * Open the socket and run Init. Resolves with InitResponseOk; rejects
   * on any failure path (network, close, init err shape).
   */
  async connect(frame: InitFrame): Promise<InitResponseOk> {
    if (this._state !== 'disconnected') {
      throw new Error(`connect() called in state ${this._state}`);
    }
    this._state = 'connecting';
    this.closeInfo = null;

    const ws = this.wsFactory(this.url);
    this.ws = ws;
    // Spec §2 — must be arraybuffer for binary chunks.
    ws.binaryType = 'arraybuffer';

    return new Promise<InitResponseOk>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      const onOpen = (): void => {
        this.lastSeenAt = Date.now();
        try {
          ws.send(JSON.stringify(frame));
        } catch (err) {
          settle(() => reject(err as Error));
          this.disconnect();
          return;
        }
        // Start heartbeat as soon as socket is open (spec §3.3 step 7).
        this.startHeartbeat();
      };

      const onInitMsg = (raw: WebSocket.RawData, isBinary: boolean): void => {
        this.lastSeenAt = Date.now();
        // Spec §3.10 — binary in Init phase is fatal.
        if (isBinary) {
          settle(() => reject(new Error('Server returned binary')));
          this.disconnect();
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          settle(() => reject(new Error(`Server JSON failed to parse: ${raw.toString()}`)));
          this.disconnect();
          return;
        }
        // Pre-Init pong allowed (spec §3.3 step 8 pong branch).
        if (isPongMsg(msg)) return;
        if (isErrMsg(msg)) {
          const err = msg as { msg?: string };
          settle(() => reject(new Error(`Failed to authenticate: ${err.msg ?? ''}`)));
          this.disconnect();
          return;
        }
        if (!isInitOk(msg)) {
          settle(() => reject(new Error(`Did not respond to login request: ${raw.toString()}`)));
          this.disconnect();
          return;
        }
        // Init success — flip to ready, rebind onmessage to dispatch.
        this._state = 'ready';
        ws.off('message', onInitMsg);
        ws.on('message', this.onMessageBound);
        settle(() => resolve(msg));
      };

      const onClose = (code: number, reasonBuf: Buffer): void => {
        // RFC 6455: code may be 1006 if the close was abnormal.
        const reason = getCloseReason(code);
        this.closeInfo = { code, reason: reasonBuf?.toString() || reason };
        // Drain heartbeat + any pending requests.
        this.cleanupAfterClose();
        // If Init never settled, the rejection wins.
        settle(() => {
          if (code === CloseCode.ABNORMAL_CLOSURE) {
            reject(new Error('Unable to connect to server.'));
          } else {
            reject(new Error(`Disconnected. Code: ${code} ${reason}`));
          }
        });
        if (this.onCloseCb) this.onCloseCb(this.closeInfo);
      };

      const onError = (err: Error): void => {
        // `ws` emits 'error' then 'close'; we let onClose finalize.
        settle(() => reject(err));
      };

      ws.on('open', onOpen);
      ws.on('message', onInitMsg);
      ws.on('close', onClose);
      ws.on('error', onError);
    });
  }

  /**
   * Idempotent disconnect. Spec §3.9 — close socket, stop heartbeat,
   * reject pending requests with Error("Disconnected").
   */
  disconnect(reason?: string): void {
    if (this._state === 'disconnected') return;
    this._state = 'closing';
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const err = new Error(reason ?? 'Disconnected');
    for (const p of this.pending.splice(0)) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    for (const b of this.pendingBinary.splice(0)) {
      b.reject(err);
    }
    this.binaryBuf.length = 0;
    this._state = 'disconnected';
  }

  /**
   * Send a JSON request and await the next text frame.
   *
   * FIFO matching (spec §3.7 "顺序就是身份") — no op tag correlation.
   * Concurrent callers are queued client-side too; each waits for its
   * predecessor's response before being sent.
   */
  async request(
    op: string,
    payload: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this._state !== 'ready') {
      throw new Error(`request() called in state ${this._state}`);
    }
    const ws = this.ws;
    if (!ws) throw new Error('socket gone');

    const body = { op, ...payload };
    try {
      ws.send(JSON.stringify(body));
    } catch (err) {
      throw err as Error;
    }

    const timeoutMs = opts.timeoutMs ?? this.defaultRequestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((p) => p === entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        // Spec §3.6: timeout triggers disconnect().
        this.disconnect('Timeout');
        reject(new Error('Timeout'));
      }, timeoutMs);
      const entry: PendingRequest = { resolve, reject, op, timer };
      this.pending.push(entry);
    });
  }

  /**
   * Await the next response frame WITHOUT sending anything. Used by
   * push/pull loops (P4) that want to consume server acks. No timeout
   * per spec §3.7.
   */
  async response(): Promise<unknown> {
    if (this._state !== 'ready') {
      throw new Error(`response() called in state ${this._state}`);
    }
    return new Promise<unknown>((resolve, reject) => {
      this.pending.push({ resolve, reject, op: '<response>', timer: null });
    });
  }

  /**
   * Await the next BINARY frame (ArrayBuffer). Used by pull() for the
   * chunk loop. No timeout (spec §3.7) — relies on the heartbeat path
   * to detect dead connections.
   */
  async responseBinary(): Promise<ArrayBuffer> {
    if (this._state !== 'ready') {
      throw new Error(`responseBinary() called in state ${this._state}`);
    }
    // Drain any pre-buffered frame first (see binaryBuf docstring).
    if (this.binaryBuf.length > 0) {
      const next = this.binaryBuf.shift()!;
      return Promise.resolve(next);
    }
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pendingBinary.push({ resolve, reject });
    });
  }

  /**
   * Push a file. `ciphertext` is the AES-GCM-encrypted body; size is
   * implied by `meta.size`. Per spec doc/04 §3.3:
   *
   *   - Send control frame; await one ack.
   *   - If `ack.res === "ok"` (dedupe-hit) OR `meta.pieces === 0` →
   *     stop. (Folder / deleted / rename / empty file follow the same
   *     "no binaries" path.)
   *   - Otherwise send `pieces` binary frames sliced to CHUNK_SIZE,
   *     awaiting one ack between each. The chunk loop trusts FIFO
   *     order; binary frames are NOT mixed with text awaits.
   *
   * Returns the server-assigned uid when the ack carries one (dedupe-
   * hit or control-only). For full uploads, the uid is delivered via
   * the onServerPush broadcast — we return 0 here as a sentinel so
   * callers don't accidentally rely on it.
   */
  async push(meta: PushControlFrame, ciphertext: Uint8Array): Promise<number> {
    if (this._state !== 'ready') {
      throw new Error(`push() called in state ${this._state}`);
    }
    const ws = this.ws;
    if (!ws) throw new Error('socket gone');

    // Send the control frame and await the first ack via the FIFO
    // pending queue — we use the same internal slot type request()
    // uses, but without the 60s timeout (push body upload can take
    // longer than a single request window).
    ws.send(JSON.stringify(meta));
    const firstAck = (await this.response()) as
      | { res?: string; uid?: number; err?: string; msg?: string }
      | null;
    if (firstAck && typeof firstAck === 'object') {
      if (firstAck.err) throw new Error(firstAck.err);
      if (firstAck.res === 'err') throw new Error(firstAck.msg ?? 'push failed');
      if (firstAck.res === 'ok') {
        // Dedupe-hit OR control-only branch — skip binaries.
        return firstAck.uid ?? 0;
      }
    }

    // Empty file: pieces === 0 means no binaries to send. The server
    // still acked above (it took Branch C in our handler), so we're
    // done. Should be unreachable in current server because empty
    // files go through the "no binaries" ack with `res:"ok"`, but
    // keep the guard for protocol resilience.
    if (meta.pieces === 0 || ciphertext.byteLength === 0) {
      return 0;
    }

    for (let i = 0; i < meta.pieces; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, ciphertext.byteLength);
      ws.send(ciphertext.subarray(start, end));
      const chunkAck = (await this.response()) as
        | { res?: string; err?: string; msg?: string }
        | null;
      if (chunkAck && typeof chunkAck === 'object') {
        if (chunkAck.err) throw new Error(chunkAck.err);
        if (chunkAck.res === 'err') {
          throw new Error(chunkAck.msg ?? 'push chunk failed');
        }
      }
    }
    return 0;
  }

  /**
   * Pull a file by uid. Spec doc/04 §3.5:
   *
   *   1. Send `{op:"pull", uid}`; await one meta frame `{size, pieces}`.
   *   2. If `pieces === 0` → return empty.
   *   3. Else await `pieces` binary frames and concat them.
   *
   * Returns the raw ciphertext bytes (AES-GCM decryption is the
   * caller's responsibility — sync-plugin in P5).
   */
  async pull(uid: number): Promise<{ size: number; pieces: number; data: Uint8Array }> {
    if (this._state !== 'ready') {
      throw new Error(`pull() called in state ${this._state}`);
    }
    const ws = this.ws;
    if (!ws) throw new Error('socket gone');

    ws.send(JSON.stringify({ op: 'pull', uid }));
    const meta = (await this.response()) as
      | (PullMetaFrame & { err?: string; res?: string; msg?: string })
      | null;
    if (!meta || typeof meta !== 'object') {
      throw new Error('pull: missing meta');
    }
    if (meta.err) throw new Error(meta.err);
    if (meta.res === 'err') throw new Error(meta.msg ?? 'pull failed');
    const size = typeof meta.size === 'number' ? meta.size : 0;
    const pieces = typeof meta.pieces === 'number' ? meta.pieces : 0;
    if (pieces === 0 || size === 0) {
      return { size: 0, pieces: 0, data: new Uint8Array(0) };
    }
    const out = new Uint8Array(size);
    let cursor = 0;
    for (let i = 0; i < pieces; i++) {
      const chunk = await this.responseBinary();
      const view = new Uint8Array(chunk);
      out.set(view, cursor);
      cursor += view.byteLength;
    }
    return { size, pieces, data: out };
  }

  /** Translate a close code via the proto helper. */
  getCloseReason(code: number): string {
    return getCloseReason(code);
  }

  /** Inspect the most recent close (if any). */
  get lastClose(): { code: number; reason: string } | null {
    return this.closeInfo;
  }

  // ---- internals -------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => this.heartbeatSweep(), this.heartbeatSweepMs);
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  private heartbeatSweep(): void {
    if (this._state !== 'ready' && this._state !== 'connecting') return;
    const idle = Date.now() - this.lastSeenAt;
    if (idle > this.idleTimeoutMs) {
      this.disconnect('idle timeout');
      return;
    }
    if (idle > this.probeAfterMs && this.ws?.readyState === this.ws?.OPEN) {
      try {
        this.ws!.send(JSON.stringify({ op: 'ping' }));
      } catch {
        // ignore — disconnect will follow via the ws error/close events.
      }
    }
  }

  private onMessageBound = (raw: WebSocket.RawData, isBinary: boolean): void => {
    // Spec §3.8 — refresh lastSeenAt on EVERY inbound frame (binary
    // included), regardless of op.
    this.lastSeenAt = Date.now();

    if (isBinary) {
      // P4: deliver to the oldest pendingBinary waiter, or buffer if
      // none is registered yet (the pull meta frame frequently arrives
      // immediately followed by binaries, faster than the await cycle
      // can register the next waiter). Spec §3.8's "drop on dataPromise
      // null" fallthrough is correct ONLY when we're certain no caller
      // wants the bytes — but pull() always wants `pieces` of them.
      const ab = toArrayBuffer(raw);
      const waiter = this.pendingBinary.shift();
      if (waiter) {
        waiter.resolve(ab);
      } else {
        this.binaryBuf.push(ab);
      }
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      // Spec §3.8 — invalid JSON → disconnect.
      this.disconnect('invalid JSON from server');
      return;
    }

    if (this.onMessageCb) this.onMessageCb(msg);

    if (isPongMsg(msg)) {
      // Pong consumed; no further dispatch (already refreshed lastSeenAt).
      return;
    }

    if (isPingMsg(msg)) {
      // Server probed us — respond with pong. Don't consume a pending slot.
      try {
        this.ws?.send(JSON.stringify({ op: 'pong' }));
      } catch {
        // ignore
      }
      return;
    }

    // Server-push: spec doc/04 §3.7. `{op:"push", uid, ...}` arrives
    // outside the request/response cycle. Forward to the application
    // callback (if any) WITHOUT consuming a pending slot.
    if (isServerPushMsg(msg)) {
      if (this.onServerPushCb) this.onServerPushCb(msg);
      return;
    }

    // Initial-replay-complete marker (spec 05b §3.6). Doesn't consume a
    // request slot; the sync plugin uses it to flip `initialReplayDone`
    // and unblock Phase 3.
    if (isInitialDoneMsg(msg)) {
      if (this.onInitialDoneCb) this.onInitialDoneCb(msg);
      return;
    }

    // Pop FIFO pending request.
    const entry = this.pending.shift();
    if (!entry) {
      // No request in-flight — drop per spec §3.8.
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(msg);
  };

  private cleanupAfterClose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const err = new Error('Disconnected');
    for (const p of this.pending.splice(0)) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    for (const b of this.pendingBinary.splice(0)) {
      b.reject(err);
    }
    this.binaryBuf.length = 0;
    this._state = 'disconnected';
    this.ws = null;
  }
}

function isPongMsg(x: unknown): boolean {
  return typeof x === 'object' && x !== null && (x as { op?: unknown }).op === 'pong';
}
function isPingMsg(x: unknown): boolean {
  return typeof x === 'object' && x !== null && (x as { op?: unknown }).op === 'ping';
}
function isErrMsg(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as { res?: unknown; status?: unknown };
  return o.res === 'err' || o.status === 'err';
}
function isInitOk(x: unknown): x is InitResponseOk {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as { res?: unknown; perFileMax?: unknown; userId?: unknown };
  return o.res === 'ok' && typeof o.perFileMax === 'number' && typeof o.userId === 'number';
}
/**
 * Server-push detection. A `{op:"push", ...}` frame on a connection
 * that has finished Init MUST be the server-broadcast push (spec
 * doc/04 §3.7). Client never sends back-to-back `op:"push"` so there's
 * no risk of swallowing a legitimate ack.
 *
 * Note: this MUST be evaluated AFTER pong/ping filters but BEFORE the
 * FIFO `pending` shift — server-push is unsolicited and should not
 * consume a request slot.
 */
function isServerPushMsg(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as { op?: unknown; uid?: unknown };
  return o.op === 'push' && typeof o.uid === 'number';
}

/**
 * `{op:"initial-done"}` — emitted by the server after the post-init
 * replay stream completes. The client uses it as the Phase 3 gate
 * (see `_sync.ts` and `doc/edge-tests/00-候选清单-Claude侧.md` A9).
 */
function isInitialDoneMsg(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as { op?: unknown };
  return o.op === 'initial-done';
}

/**
 * Normalize an inbound binary frame to a standalone ArrayBuffer.
 *
 * On the desktop Electron path the `ws` library's RawData is
 * `Buffer | ArrayBuffer | Buffer[]`. On the Obsidian Mobile WebView
 * path `BrowserWsAdapter` has already forced `binaryType='arraybuffer'`
 * AND there is no Node `Buffer` global — so we must guard every
 * `Buffer.*` access behind `globalThis.Buffer`.
 *
 * The `.buffer` of a Buffer is sometimes typed as
 * `ArrayBuffer | SharedArrayBuffer` upstream; we copy bytes into a
 * fresh ArrayBuffer to dodge that union and own the lifetime.
 */
function toArrayBuffer(raw: WebSocket.RawData): ArrayBuffer {
  if (raw instanceof ArrayBuffer) return raw;

  // ArrayBufferView (Uint8Array / DataView / typed array) — works on all
  // platforms. Cover this before the Buffer branch because a Node Buffer
  // *is also* a Uint8Array, so the view path is a correct superset.
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    const ab = new ArrayBuffer(view.byteLength);
    new Uint8Array(ab).set(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
    return ab;
  }

  // Node-only: Buffer[] from `ws` when frames arrive fragmented. Guarded
  // so the module can still be evaluated on mobile (no global Buffer).
  const B = (globalThis as { Buffer?: typeof globalThis.Buffer }).Buffer;
  if (B && Array.isArray(raw)) {
    const merged = B.concat(raw as Buffer[]);
    const ab = new ArrayBuffer(merged.byteLength);
    new Uint8Array(ab).set(merged);
    return ab;
  }

  throw new Error(`toArrayBuffer: unsupported raw type ${Object.prototype.toString.call(raw)}`);
}
