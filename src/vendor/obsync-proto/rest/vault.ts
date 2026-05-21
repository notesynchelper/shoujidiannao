/**
 * /vault/* wire types. Source: doc/01-rest-api.md §3.10 - §3.15, §3.11
 * with the client-managed-key override from ROADMAP §1.5 + §2.6.
 *
 * IMPORTANT (override of spec §S13): the spec defines two wire forms for
 * /vault/create — (a) user-managed `keyhash=<hex>+salt=<hex>` and
 * (b) server-managed `keyhash=null`. **This repo only accepts (a)**:
 * client generates `masterKey = getRandomValues(32)` locally and uploads
 * `keyhash + salt` it derived itself. `keyhash=null` form is rejected
 * with `{error: SERVER_MANAGED_NOT_SUPPORTED}` (VAULT_ERROR_STRINGS).
 *
 * Field discipline (this repo override):
 *   - VaultCreateBody.keyhash: REQUIRED non-empty `[0-9a-f]{64}` hex
 *   - VaultCreateBody.salt:    REQUIRED non-empty `[0-9a-f]{32}` hex
 *   - VaultMeta.password:      SERVER NEVER SETS IT in any response
 *   - encryption_version:      only `3` is accepted; other values rejected
 */

import type { VaultMeta } from './common.js';

/** /vault/list request. Client always sends supported_encryption_version=3. */
export interface VaultListBody {
  token: string;
  supported_encryption_version: 3;
}

/**
 * /vault/list response. Both arrays MUST exist (client forEach-s them
 * unconditionally; missing keys cause TypeError).
 *
 * Server NEVER fills `password` on contained VaultMeta entries.
 */
export interface VaultListOk {
  limit: number;
  vaults: VaultMeta[];
  shared: VaultMeta[];
}

/**
 * /vault/create request — client-managed mode only (this repo override).
 *
 * `keyhash` and `salt` are **required** hex strings produced by the
 * client from its random `masterKey`. `keyhash=null` is rejected.
 */
export interface VaultCreateBody {
  token: string;
  name: string;
  region: string;
  encryption_version: 3;
  /** Non-empty lowercase hex, exactly 64 chars. */
  keyhash: string;
  /** Non-empty lowercase hex, exactly 32 chars. */
  salt: string;
}

/** /vault/create response — server echoes vault row; NEVER includes `password`. */
export type VaultCreateOk = VaultMeta;

/** /vault/access request. */
export interface VaultAccessBody {
  token: string;
  vault_uid: string;
  /** Client-computed keyhash; server compares against stored row. */
  keyhash: string;
  host?: string;
  encryption_version: 3;
}

/** /vault/access response — vault metadata; NEVER includes `password`. */
export type VaultAccessOk = VaultMeta;

/** /vault/delete request. */
export interface VaultDeleteBody {
  token: string;
  vault_uid: string;
}

export type VaultDeleteOk = Record<string, never>;

/** /vault/rename request. */
export interface VaultRenameBody {
  token: string;
  vault_uid: string;
  name: string;
}

export type VaultRenameOk = Record<string, never>;

/** /vault/regions request. `host` may be undefined → field dropped on wire. */
export interface VaultRegionsBody {
  token: string;
  host?: string;
}

export interface VaultRegion {
  value: string;
  name: string;
}

export interface VaultRegionsOk {
  regions: VaultRegion[];
}

/**
 * /vault/migrate request. Stub-rejected at first launch:
 *   server responds `{error: VAULT_ERROR_STRINGS.MIGRATE_NOT_AVAILABLE}`.
 *
 * Schema is retained for future re-enablement; client-managed mode only.
 */
export interface VaultMigrateBody {
  token: string;
  vault_uid: string;
  region: string;
  encryption_version: 3;
  keyhash: string;
  salt: string;
}

export type VaultMigrateOk = VaultMeta;

/**
 * Wire-level error literals returned by the server for /vault/*.
 *
 * Exported as runtime strings so both server (to emit) and client
 * (to dispatch on) can reference the same constants. The textual
 * content matches doc/01-rest-api.md inline §S12-§S17 overrides.
 */
export const VAULT_ERROR_STRINGS = {
  /** /vault/create with keyhash=null or missing salt. */
  SERVER_MANAGED_NOT_SUPPORTED:
    'server-managed password not supported, use client-managed keyhash',
  /** /vault/create / /vault/access encryption_version ≠ 3. */
  UNSUPPORTED_ENCRYPTION_VERSION: 'unsupported encryption_version',
  /** /vault/migrate any body. */
  MIGRATE_NOT_AVAILABLE: 'vault migration not yet available',
  /** /vault/access / /vault/delete / /vault/rename when row absent. */
  NOT_FOUND: 'vault not found',
  /** /vault/access keyhash differs from stored row. */
  BAD_KEYHASH: 'keyhash mismatch',
  /** /vault/create body validation failures. */
  KEYHASH_FORMAT: 'keyhash must be lowercase hex (64 chars)',
  SALT_FORMAT: 'salt must be lowercase hex (32 chars)',
  NAME_REQUIRED: 'vault name required',
  REGION_REQUIRED: 'region required',
} as const;
