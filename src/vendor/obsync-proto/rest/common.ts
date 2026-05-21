/**
 * Common REST envelope types for obsidian-compatible API.
 *
 * Source: doc/01-rest-api.md §2.3 / §2.4 / §2.5.
 *
 * Naming rule (do NOT violate): field names match the desktop client's
 * wire format verbatim — snake_case where the desktop client uses
 * snake_case (`vault_uid`, `encryption_version`, `keyhash`, etc.). No
 * camelCase rewriting.
 */

/**
 * Error response shape. The desktop client distinguishes success vs error
 * **purely by the presence of the `error` key** — HTTP status and
 * `response.ok` are not consulted. The string in `error` is also used as
 * `Error.message` and rendered in UI toasts directly.
 *
 * Use the literal `NOT_LOGGED_IN_LITERAL` from `../constants` for
 * token-invalid signaling.
 */
export interface ApiError {
  error: string;
}

/**
 * Account snapshot. Mirrors the 5 persisted fields written to
 * localStorage under `obsidian-account`. Server-side we never persist
 * this exact shape — we just produce it as part of /user/info responses.
 */
export interface AccountSnapshot {
  email: string | null;
  name: string | null;
  token: string | null;
  license: string | null;
  /** Enterprise license key — independent of regular sync token. */
  key: string | null;
}

/**
 * Vault metadata as appears in /vault/list, /vault/create, /vault/access,
 * /vault/migrate responses. The exact field set is determined by what
 * the desktop client consumes (see doc/01 §2.5).
 *
 * Field semantics:
 *   - `id`        : vault_uid; primary key for all subsequent writes
 *   - `name`      : human-readable
 *   - `host`      : "wss://sync-xx.example/"; clients strip wss?:// for /vault/regions
 *   - `size`      : bytes (UI only)
 *   - `created`   : ms since epoch (UI only — moment().fromNow())
 *   - `region`    : free-form region identifier
 *   - `password`  : **DEPRECATED — this repo never emits it.** Spec
 *                   defined this for server-managed (basic) vaults to
 *                   tell the client "skip the password prompt and
 *                   auto-unlock". This repo runs client-managed-key
 *                   E2E only (ROADMAP §1.5), so the server NEVER
 *                   populates this field. Type kept `optional` for
 *                   compatibility but always absent in our responses.
 *   - `salt`      : 16-byte hex (32 chars); HKDF + SAS salt; required.
 *                   Generated client-side at vault creation.
 *   - `encryption_version`: 0..3; ensureEncryptionVersion() fills 0 only
 *                   for literal undefined — null/0/"0" pass through.
 */
export interface VaultMeta {
  id: string;
  name: string;
  host: string;
  size?: number;
  created?: number;
  region?: string;
  password?: string;
  salt: string;
  keyhash?: string;
  encryption_version: number;
  size_quota?: number;
}
