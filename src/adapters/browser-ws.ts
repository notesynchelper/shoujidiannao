/**
 * `BrowserWsAdapter` — wraps a W3C WebSocket so it speaks the small
 * subset of the `ws` library's Node EventEmitter API that `SyncServer`
 * needs.
 *
 * Why this exists: esbuild bundles the obsync plugin with
 * `platform: 'browser'`, which resolves the `ws` package to its
 * `browser.js` entry — a single-function stub that throws. Inside
 * Obsidian (Electron renderer) we MUST use the renderer's native
 * `WebSocket` global, but `SyncServer` is written against `ws`'s
 * `on('open', cb)` / `off(...)` / `binaryType = 'arraybuffer'` shape.
 * Rather than refactor SyncServer (and risk regressing its 32-test
 * coverage), we hand it a duck-typed wrapper that emits the same
 * events from the W3C event listeners.
 *
 * Scope: only the methods/properties SyncServer touches are
 * implemented; anything else is a runtime no-op. If we ever extend
 * SyncServer's wire-level API, this adapter must grow alongside it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

type WsEventName = 'open' | 'message' | 'close' | 'error';

type Listener = (...args: any[]) => void;

/**
 * Public surface compatible with `ws.WebSocket` for the few methods +
 * properties `SyncServer` reads. `binaryType` setter is honoured so
 * the W3C socket switches to `ArrayBuffer` delivery. `readyState` /
 * `OPEN` mirror the W3C constants.
 */
export interface NodeWsLike {
  binaryType: 'arraybuffer' | 'nodebuffer' | 'fragments';
  readonly readyState: number;
  readonly OPEN: number;
  on(event: WsEventName, listener: Listener): NodeWsLike;
  off(event: WsEventName, listener: Listener): NodeWsLike;
  once(event: WsEventName, listener: Listener): NodeWsLike;
  send(data: string | ArrayBufferView | ArrayBuffer, opts?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
}

export class BrowserWsAdapter implements NodeWsLike {
  private readonly ws: WebSocket;
  private readonly listeners: Map<WsEventName, Listener[]> = new Map();
  /**
   * Buffer for events that fire BEFORE SyncServer's `.on(...)` calls
   * land. The native WebSocket can transition to OPEN synchronously
   * fast enough that the listener-attach is racy; we replay buffered
   * events on first registration of the matching event name.
   */
  private readonly buffered: Map<WsEventName, unknown[][]> = new Map();
  /** Once SyncServer flips to ready it stops needing buffering. */
  private replayed: Set<WsEventName> = new Set();

  constructor(url: string) {
    // Use renderer-provided WebSocket (Electron / browser).
    const W = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (typeof W !== 'function') {
      throw new Error('BrowserWsAdapter: no native WebSocket in globalThis');
    }
    this.ws = new W(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('open', () => this.fire('open'));
    this.ws.addEventListener('error', (ev: Event) => {
      this.fire('error', ev instanceof ErrorEvent ? new Error(ev.message || 'ws error') : new Error('ws error'));
    });
    this.ws.addEventListener('close', (ev: CloseEvent) => {
      // ws.on('close', (code, reasonBuffer)) — sync-server reads .toString() on the reason.
      const reasonBuf = {
        toString: () => ev.reason || '',
      };
      this.fire('close', ev.code, reasonBuf);
    });
    this.ws.addEventListener('message', (ev: MessageEvent) => {
      // sync-server's `(raw, isBinary)` cb: raw is Buffer | ArrayBuffer.
      const data: unknown = ev.data;
      const isBinary = typeof data !== 'string';
      // SyncServer converts ArrayBuffer to a Uint8Array via `toArrayBuffer`
      // for binary frames; for text frames it calls `raw.toString()`. Wrap
      // string data in a small shim so `raw.toString()` works for both.
      let payload: unknown;
      if (isBinary) {
        payload = data; // ArrayBuffer goes through unchanged
      } else {
        const s = data as string;
        payload = {
          toString: () => s,
        };
      }
      this.fire('message', payload, isBinary);
    });
  }

  get binaryType(): 'arraybuffer' | 'nodebuffer' | 'fragments' {
    // W3C only supports 'blob' or 'arraybuffer'; we force 'arraybuffer'.
    return 'arraybuffer';
  }
  set binaryType(_v: 'arraybuffer' | 'nodebuffer' | 'fragments') {
    // SyncServer pins this to 'arraybuffer' in the constructor; we
    // ignore other values because the native socket has been forced to
    // 'arraybuffer' already.
    this.ws.binaryType = 'arraybuffer';
  }

  get readyState(): number {
    return this.ws.readyState;
  }
  get OPEN(): number {
    return WebSocket.OPEN;
  }

  on(event: WsEventName, listener: Listener): this {
    let arr = this.listeners.get(event);
    if (!arr) {
      arr = [];
      this.listeners.set(event, arr);
    }
    arr.push(listener);
    // Replay any events that fired before this listener attached.
    // Only the first registration consumes the buffer — subsequent
    // listeners just receive future events.
    if (!this.replayed.has(event)) {
      this.replayed.add(event);
      const queued = this.buffered.get(event);
      if (queued && queued.length > 0) {
        for (const args of queued.splice(0)) {
          try { listener(...args); } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[BrowserWsAdapter]', event, 'replay listener threw', e);
          }
        }
      }
    }
    // For the 'open' event, if the underlying socket is already open
    // when the listener registers (the constructor's addEventListener
    // may have missed the synchronous transition on some runtimes),
    // dispatch now so SyncServer's Init handshake can proceed.
    if (event === 'open' && this.ws.readyState === WebSocket.OPEN) {
      try { listener(); } catch { /* noop */ }
    }
    return this;
  }

  off(event: WsEventName, listener: Listener): this {
    const arr = this.listeners.get(event);
    if (!arr) return this;
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
    return this;
  }

  once(event: WsEventName, listener: Listener): this {
    const wrap = (...args: any[]): void => {
      this.off(event, wrap);
      listener(...args);
    };
    return this.on(event, wrap);
  }

  send(data: string | ArrayBufferView | ArrayBuffer, _opts?: { binary?: boolean }): void {
    this.ws.send(data as any);
  }

  close(code?: number, reason?: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      // ignore
    }
  }

  private fire(event: WsEventName, ...args: unknown[]): void {
    const arr = this.listeners.get(event);
    if (!arr || arr.length === 0) {
      // Buffer for the first listener to consume on registration.
      let q = this.buffered.get(event);
      if (!q) {
        q = [];
        this.buffered.set(event, q);
      }
      q.push(args);
      return;
    }
    // Copy so an off() during dispatch doesn't perturb iteration.
    for (const cb of arr.slice()) {
      try { cb(...args); } catch (e) {
        // Best-effort: surface listener errors through `error`.
        // eslint-disable-next-line no-console
        console.error('[BrowserWsAdapter]', event, 'listener threw', e);
      }
    }
  }
}
