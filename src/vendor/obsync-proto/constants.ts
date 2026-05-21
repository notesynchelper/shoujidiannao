/**
 * Wire-level constants shared between obsync-client and obsync-server.
 *
 * NOTE: these are wire protocol constants. Do not change without bumping
 * the protocol version — values must match doc/01-rest-api.md and
 * doc/03-websocket-protocol.md exactly.
 */

/** WebSocket binary chunk size (2 MiB). doc/04 §3.x. */
export const CHUNK_SIZE = 2_097_152;

/** Default per-file max upload size (server-enforced quota baseline). doc/04 §3.x. */
export const PER_FILE_MAX_DEFAULT = 208_666_624;

/** WS heartbeat ping interval (ms). doc/03 §4.x. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** WS request timeout (ms). doc/03 §4.x. */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Literal token-invalid sentinel string.
 *
 * The desktop client matches `err.message === "Not logged in"` (exact
 * string compare, case-sensitive, including trailing punctuation). Any
 * other string is surfaced as a generic error to the UI.
 *
 * Source: doc/01-rest-api.md §3.7 / §3.8, S4 / S26.
 */
export const NOT_LOGGED_IN_LITERAL = 'Not logged in';

/** Default vault size quota in bytes (1 GiB). Server config knob, not on wire. */
export const DEFAULT_SIZE_QUOTA = 1_073_741_824;
