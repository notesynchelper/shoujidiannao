/**
 * Client-managed vault key generation (ROADMAP §1.5 / §2.6).
 *
 * In the "WeChat-only / no password" SKU, obsync-server NEVER holds the
 * raw masterKey for a vault: at vault-create time the plugin generates
 * a fresh random 32-byte masterKey + 16-byte salt locally, computes the
 * v3 keyhash from those values, and uploads only the keyhash. The
 * masterKey lives in IndexedDB and (later) is wrapped via the pair
 * protocol for cross-device handoff.
 *
 * The v3 keyhash formula is the same HKDF used by the password path
 * (`generateKeyHash` case 2/3) — the only difference is the IKM:
 *
 *   password path: masterKey = scrypt(password, salt)
 *   client  path:  masterKey = crypto.randomBytes(32)
 *
 * HKDF parameters (matching encryption-provider.js / doc/02a §3.6):
 *   IKM   = masterKey                              (32 B)
 *   salt  = utf8(saltHex)                          (32 B ASCII, NOT decoded hex)
 *   info  = "ObsidianKeyHash"
 *   L     = 32 B → hex(64 chars) is the keyhash
 *
 * Source mirror:
 *   - packages/obsync-crypto/src/password-keyhash.ts (the password twin)
 *   - analysis/desktop/modules/crypto/encryption-provider.js:L42-L58
 */

import { randomBytes } from '@noble/hashes/utils';
import { hkdfDerive, INFO_KEY_HASH } from './hkdf.js';
import { bytesToHex, utf8Encode } from './utils.js';

export interface ClientVaultKey {
  /** 32-byte random master key. NEVER persisted to obsync-server. */
  masterKey: Uint8Array;
  /** 16-byte random salt, encoded as 32-char lowercase hex. */
  saltHex: string;
}

/**
 * Generate a fresh client-managed vault key. Call exactly once per new
 * vault — re-generation would re-key the existing data.
 *
 * Caller is responsible for:
 *   - persisting `masterKey` to IndexedDB (encrypted-at-rest by browser)
 *   - uploading `saltHex` + the computed keyhash to obsync-server
 *   - zeroing `masterKey` after the IndexedDB write completes
 */
export function generateClientVaultKey(): ClientVaultKey {
  // `randomBytes` (@noble/hashes) wraps `crypto.getRandomValues` with
  // platform detection — mobile-safe, returns fresh Uint8Arrays.
  const masterKey = randomBytes(32);
  const saltHex = bytesToHex(randomBytes(16));
  return { masterKey, saltHex };
}

/**
 * Compute the v3 keyhash from a raw masterKey + saltHex pair. Output is
 * 64-char lowercase hex — the value uploaded to obsync-server as
 * `keyhash` on `/vault/create`.
 *
 * Async signature is preserved for API symmetry with the rest of the
 * pair-derive helpers (which use SubtleCrypto). The underlying HKDF
 * here is synchronous Node hkdf for parity with `password-keyhash.ts`.
 */
export async function computeKeyHashV3(
  masterKey: Uint8Array,
  saltHex: string,
): Promise<string> {
  if (masterKey.byteLength !== 32) {
    throw new Error('computeKeyHashV3: masterKey must be 32 bytes');
  }
  if (!/^[0-9a-f]{32}$/.test(saltHex)) {
    throw new Error(
      'computeKeyHashV3: saltHex must be 32 lowercase hex chars (16 bytes)',
    );
  }
  // HKDF salt is the UTF-8 bytes of the saltHex STRING, not the
  // decoded raw bytes. Same convention as password-keyhash.ts:L89.
  const hkdfSalt = utf8Encode(saltHex);
  const out = hkdfDerive(masterKey, INFO_KEY_HASH, hkdfSalt, 32);
  return bytesToHex(out);
}
