/**
 * HKDF-SHA256 per doc/02a-key-derivation.md §3.6 / §3.7.
 *
 * Four info labels are recognised by Obsidian Sync; each derives a
 * sub-key from the 32-byte master key.
 *
 * IMPORTANT — HKDF salt semantics:
 *   - For the three SIV / keyHash sub-keys, the desktop client passes
 *     `utf8Encode(salt_string)` as HKDF salt (i.e. the 32-byte ASCII of
 *     the hex string, NOT the 16-byte decoded salt).
 *   - For the AES-GCM content sub-key, the desktop client passes a
 *     ZERO-LENGTH Uint8Array — see encryption-provider.js:L168.
 *
 * Source mirror:
 *   - analysis/desktop/modules/crypto/encryption-provider.js:L42-L58
 *   - analysis/desktop/modules/crypto/encryption-provider.js:L141-L176
 *   - analysis/desktop/app.readable.js:L46717-L46732
 */

import { hkdfSync } from 'node:crypto';

// Four info labels, exported for shared use across the package and the
// upcoming `obsync-client` derivations.
export const INFO_KEY_HASH = 'ObsidianKeyHash';
export const INFO_SIV_MAC = 'ObsidianAesSivMac';
export const INFO_SIV_ENC = 'ObsidianAesSivEnc';
export const INFO_GCM = 'ObsidianAesGcm';

/**
 * Derive a `len`-byte sub-key from `masterKey` using HKDF-SHA256.
 *
 * @param masterKey 32-byte IKM (scrypt output).
 * @param info      ASCII info label — usually one of the four constants
 *                  above.
 * @param salt      HKDF salt. For the three SIV/keyHash sub-keys this
 *                  should be `utf8Encode(saltHexString)`; for the GCM
 *                  content sub-key it should be an empty Uint8Array.
 * @param len       Output length in bytes. Defaults to 32 (AES-256).
 */
export function hkdfDerive(
  masterKey: Uint8Array,
  info: string,
  salt: Uint8Array,
  len = 32,
): Uint8Array {
  // Node's hkdfSync returns ArrayBuffer; we wrap it as a Uint8Array view
  // backed by a fresh copy so the caller may freely mutate / zero it.
  const ab = hkdfSync(
    'sha256',
    masterKey,
    salt,
    new TextEncoder().encode(info),
    len,
  );
  const u8 = new Uint8Array(len);
  u8.set(new Uint8Array(ab));
  return u8;
}
