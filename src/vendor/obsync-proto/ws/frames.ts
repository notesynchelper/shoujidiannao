/**
 * WebSocket frame type schema for the Init handshake + connection-level
 * traffic (heartbeat, generic op envelope, close codes).
 *
 * Source: doc/03-websocket-protocol.md §2.1-§2.4. Field naming follows
 * the desktop client wire format VERBATIM (snake_case where applicable,
 * no camelCase rewrap).
 *
 * P3 implements: init / ping / pong + heartbeat + close-code enum +
 * serial request-queue skeleton. File-transfer ops (push / pull /
 * deleted / history / restore / usernames / purge / size) and the
 * `{op:"ready"}` / `{op:"push"}` server-push frames are NOT in scope
 * here — P4 will introduce those in the same module.
 */

// ---------------------------------------------------------------------------
// Init handshake — client → server
// ---------------------------------------------------------------------------

/**
 * `op:"init"` — first JSON text frame sent by the client immediately
 * after the WebSocket `onopen` event fires. Carries the bearer token
 * (in the body, not a header) and identifies the vault.
 *
 * Spec ref: doc/03 §2.1.
 *
 * Note on `version` vs `encryption_version`:
 *   - `version`           — hard-coded `0` per spec §2.1; this is the
 *                           "client local known max vault version" the
 *                           desktop client sends. We always send 0
 *                           (server treats it as informational; first
 *                           real version is bumped by ready/push frames).
 *   - `encryption_version` — the vault's encryption mode (0 / 2 / 3).
 *                           Server validates this matches vault row.
 */
export interface InitFrame {
  op: 'init';
  token: string;
  /** Vault id (uuid string). */
  id: string;
  /** Hex-encoded keyhash (per @obsync/crypto `passwordToKeyHash`). */
  keyhash: string;
  /** Spec-defined: literal 0 on every init. NOT encryption_version. */
  version: 0;
  /** True on the first connect of a session; client expects a full
   *  vault state push from the server (P4 behaviour). */
  initial: boolean;
  /** Free-form device label (UI only — not validated server-side). */
  device: string;
  /** Vault's encryption mode. Must match the vault row. */
  encryption_version: 0 | 2 | 3;
}

// ---------------------------------------------------------------------------
// Init handshake — server → client
// ---------------------------------------------------------------------------

/**
 * Successful Init response. Spec doc/03 §2.2.
 *
 * `userId` is an INTEGER per the spec wire schema, NOT the uuid that
 * lives in `users.id`. We expose `users.int_id` (BIGSERIAL UNIQUE) from
 * migration 002 specifically to satisfy this constraint without
 * leaking the internal uuid.
 */
export interface InitResponseOk {
  res: 'ok';
  /** Bytes; per-file max upload size. Spec default 208666624 (~199 MiB). */
  perFileMax: number;
  /** Integer userId derived from users.int_id (see migration 002). */
  userId: number;
}

/**
 * Init failure shapes. Spec doc/03 §2.3 — desktop client accepts EITHER
 * `res:"err"` or `status:"err"`. We always emit `res:"err"` (canonical)
 * but the union encodes both so a stricter client wouldn't reject.
 */
export type InitResponseErr =
  | { res: 'err'; msg: string }
  | { status: 'err'; msg: string };

export type InitResponse = InitResponseOk | InitResponseErr;

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export interface PingFrame {
  op: 'ping';
}
export interface PongFrame {
  op: 'pong';
}

// ---------------------------------------------------------------------------
// Generic op envelope (P3 stub for "unknown op" response shape)
// ---------------------------------------------------------------------------

/**
 * Catch-all "client sent an op we don't recognize yet" response. The
 * desktop client checks `result.err` truthy to throw at request() callers
 * (spec §3.6) — but P3 also reuses the Init `{res:"err"}` shape for
 * "unknown op" because no real op routes exist yet. Either is harmless
 * pre-P4. We document both here so P4 implementers don't reinvent.
 */
export interface UnknownOpResponse {
  res: 'err';
  msg: string;
}

// ---------------------------------------------------------------------------
// Close codes — Z9 table from doc/03 §2.4 + application-range additions
// ---------------------------------------------------------------------------

/**
 * WebSocket close codes used by the obsync protocol.
 *
 * 1000-1015 entries: RFC 6455 standard / Z9 table (doc/03 §2.4). Listed
 * here so server-side close() calls and client-side `getCloseReason()`
 * share one source of truth.
 *
 * 4000-4999 entries: application-defined per RFC 6455 §7.4.2. We pick
 * close codes that line up with our Init validation steps so a sync log
 * reader can tell at a glance why a connection died.
 *
 * IMPORTANT: the desktop client's `Z9` table only maps 1000..1015 to
 * named reasons — application-range codes (4xxx) will render as
 * `(For applications)` in the UI per spec §2.4. That's fine; our
 * server-side logs still know what each code means.
 */
export enum CloseCode {
  // ---- RFC 6455 standard / Z9 ----
  NORMAL = 1000,
  GOING_AWAY = 1001,
  PROTOCOL_ERROR = 1002,
  UNSUPPORTED_DATA = 1003,
  // 1004 reserved (For future)
  NO_STATUS_RECEIVED = 1005,
  ABNORMAL_CLOSURE = 1006,
  INVALID_FRAME_PAYLOAD = 1007,
  POLICY_VIOLATION = 1008,
  MESSAGE_TOO_BIG = 1009,
  MISSING_EXTENSION = 1010,
  INTERNAL_ERROR = 1011,
  SERVICE_RESTART = 1012,
  TRY_AGAIN_LATER = 1013,
  BAD_GATEWAY = 1014,
  TLS_HANDSHAKE = 1015,

  // ---- application range (RFC 6455 §7.4.2) ----
  /** Init: token missing / invalid / revoked / expired. */
  INVALID_TOKEN = 4001,
  /** Init: vault id missing / not owned by user / soft-deleted. */
  INVALID_VAULT = 4002,
  /** Init: client keyhash != vault.keyhash (case-insensitive compare). */
  KEYHASH_MISMATCH = 4003,
  /** Init: client encryption_version != vault.encryption_version. */
  ENCRYPTION_VERSION_MISMATCH = 4004,
  /** Init: malformed JSON / missing required fields / wrong op. */
  INIT_PROTOCOL_VIOLATION = 4005,
  /** READY: client sent a binary frame before P4 wires push/pull. */
  PROTOCOL_VIOLATION = 4010,
  /** Heartbeat: 120s of total silence. */
  IDLE_TIMEOUT = 4008,
}

/**
 * Human-readable reason strings for our application close codes. The
 * desktop client doesn't read these (Z9 only maps 1000..1015), but the
 * RFC 6455 close-frame payload carries a UTF-8 reason string up to 123
 * bytes, and we want server-side logs / dev-tools network tab to show
 * something meaningful.
 */
export const CLOSE_REASONS: Readonly<Record<number, string>> = Object.freeze({
  [CloseCode.NORMAL]: 'Disconnected',
  [CloseCode.GOING_AWAY]: 'Going Away',
  [CloseCode.INTERNAL_ERROR]: 'Internal Error',
  [CloseCode.INVALID_TOKEN]: 'invalid token',
  [CloseCode.INVALID_VAULT]: 'invalid vault',
  [CloseCode.KEYHASH_MISMATCH]: 'keyhash mismatch',
  [CloseCode.ENCRYPTION_VERSION_MISMATCH]: 'encryption_version mismatch',
  [CloseCode.INIT_PROTOCOL_VIOLATION]: 'init protocol violation',
  [CloseCode.PROTOCOL_VIOLATION]: 'protocol violation',
  [CloseCode.IDLE_TIMEOUT]: 'idle timeout',
});

/**
 * Translate any close code into a human-readable reason. Mirrors the
 * desktop client's `getCloseReason()` semantics (spec doc/03 §2.4):
 *
 *   0..999     → "(Unused)"
 *   1006       → "Disconnected"   (special: spec §3.10 maps to that)
 *   1000..1015 → table lookup
 *   1016..1999 → "(For WebSocket standard)"
 *   2000..2999 → "(For WebSocket extensions)"
 *   3000..3999 → "(For libraries and frameworks)"
 *   4000..4999 → table lookup if known, else "(For applications)"
 *   else       → "(Unknown)"
 */
export function getCloseReason(code: number): string {
  if (code >= 0 && code < 1000) return '(Unused)';
  if (code === 1006) return 'Disconnected';
  if (CLOSE_REASONS[code]) return CLOSE_REASONS[code];
  if (code >= 1000 && code <= 1015) {
    // 1004, 1005 etc — known standard codes without an entry in our table.
    return '(For WebSocket standard)';
  }
  if (code >= 1016 && code <= 1999) return '(For WebSocket standard)';
  if (code >= 2000 && code <= 2999) return '(For WebSocket extensions)';
  if (code >= 3000 && code <= 3999) return '(For libraries and frameworks)';
  if (code >= 4000 && code <= 4999) return '(For applications)';
  return '(Unknown)';
}

// ---------------------------------------------------------------------------
// Heartbeat timing constants
// ---------------------------------------------------------------------------

/**
 * Spec doc/03 §2 (table row "心跳轮询间隔"). Client-side heartbeat tick
 * cadence — i.e., the `setInterval` period that drives ping emission.
 *
 * Note this DIFFERS from `HEARTBEAT_PROBE_AFTER_MS`: the client wakes
 * every 20s and only sends `{op:"ping"}` if the last-seen window has
 * exceeded the probe threshold.
 */
export const HEARTBEAT_PING_INTERVAL_MS = 20_000;

/**
 * Spec doc/03 §2 (table row "心跳 ping 阈值"). Both client and server
 * check `now - lastSeenAt > HEARTBEAT_PROBE_AFTER_MS` on each sweep and
 * proactively emit `{op:"ping"}` to keep `lastSeenAt` fresh on the peer.
 *
 * Server-side sweep cadence is faster than the client's (5s vs 20s) so
 * we don't undershoot on the probe; the spec only constrains thresholds,
 * not sweep periods.
 */
export const HEARTBEAT_PROBE_AFTER_MS = 10_000;

/**
 * Spec doc/03 §2 (table row "心跳断开阈值"). Total idle window. After
 * this many ms of no inbound frames at all, either side closes the
 * connection with `CloseCode.IDLE_TIMEOUT` (4008).
 */
export const HEARTBEAT_TIMEOUT_MS = 120_000;

/**
 * Server-side heartbeat sweep cadence. NOT in the spec (spec only
 * defines the 10s/120s thresholds); we pick 5s as a compromise between
 * timely probe emission and timer overhead.
 */
export const SERVER_HEARTBEAT_SWEEP_MS = 5_000;

// ---------------------------------------------------------------------------
// P4: push / pull / chunk / onServerPush
// ---------------------------------------------------------------------------

/**
 * `op:"push"` — client → server file upload control frame. Spec doc/04
 * §3.1–§3.3. The control frame is followed by `pieces` binary frames
 * UNLESS the server replies with a dedupe-hit ack (`{res:"ok"}` for a
 * pre-existing `(vault_id, hash)` row) OR `pieces === 0` (folder /
 * deleted / rename).
 *
 * Field policy:
 *   - `path`, `hash`     — ciphertext hex (AES-SIV deterministic).
 *                          Server treats as opaque bytes; equality is
 *                          byte-exact (no normalize).
 *   - `size`             — CIPHERTEXT bytes (AES-GCM output incl.
 *                          IV+tag), NOT plaintext.
 *   - `pieces`           — `ceil(size / CHUNK_SIZE)`. Forced to 0 when
 *                          `folder || deleted || relatedpath` (no body).
 *   - `relatedpath`      — old ciphertext path on rename; empty/absent
 *                          for non-rename. Spec doc/04 §3.12.
 *   - `ctime` / `mtime`  — plaintext ms epoch from the client (forced
 *                          to 0 in folder/delete branches per spec
 *                          §3.2 / §3.8).
 */
export interface PushControlFrame {
  op: 'push';
  path: string;
  hash: string;
  size: number;
  ctime: number;
  mtime: number;
  folder: boolean;
  deleted: boolean;
  pieces: number;
  relatedpath?: string;
}

/**
 * Server response to a push control frame.
 *
 *   - `{res:"ok", uid?}`            — accept. If `uid` is present and the
 *                                     control frame had `pieces > 0`,
 *                                     this is the dedupe-hit path —
 *                                     client MUST NOT send binary
 *                                     frames (spec §3.3).
 *   - `{res:"ok"}` per chunk        — used inside the chunk loop to ack
 *                                     each binary frame (spec §3.5).
 *   - `{res:"err", msg}`            — push rejected; client throws.
 *
 * Note: spec doc/04 §S2 says the wire test is strictly
 * `response.res === "ok"`; client does NOT read the rest of the
 * payload. We keep the `uid` field for completeness so the broadcast
 * path can echo it back to other vault clients.
 */
export type PushAckFrame =
  | { res: 'ok'; uid?: number }
  | { res: 'err'; msg: string };

/**
 * `op:"pull"` — client → server file download request. Spec doc/04
 * §3.5 / §3.13.
 */
export interface PullControlFrame {
  op: 'pull';
  uid: number;
}

/**
 * First server response after a pull request: meta. Carries the
 * ciphertext byte length plus the number of binary frames the server
 * will send next. `pieces === 0` means there is NO binary follow-up
 * (folder / deleted row / empty file).
 */
export interface PullMetaFrame {
  size: number;
  pieces: number;
}

/**
 * Server → all-clients-on-vault broadcast frame fired after a successful
 * push (incl. dedupe-hit and rename). Spec doc/04 §3.14 + ROADMAP §4.2.
 *
 * IMPORTANT: the original pushing client receives the broadcast too —
 * justPushed dedupe is a client-side concern (spec §3.7). The server
 * MUST forward the same ciphertext bytes back so the 5-tuple match on
 * the client succeeds (path / hash / mtime / folder / deleted).
 */
export interface ServerPushFrame {
  op: 'push';
  path: string;
  hash: string;
  size: number;
  ctime: number;
  mtime: number;
  folder: boolean;
  deleted: boolean;
  uid: number;
  device: string;
  user: number;
}
