/**
 * passwordToKeyHash — the only crypto output that ever leaves the
 * client. Implements the three protocol variants v0 / v2 / v3.
 *
 * - v0:   hex(SHA-256(masterKey)). No HKDF, no salt input to the hash.
 * - v2/3: hex(HKDF(masterKey, info="ObsidianKeyHash", salt=utf8(saltStr))).
 *         v2 and v3 collapse to the SAME branch in the desktop switch
 *         (`generateKeyHash` case 2/3 fall-through, see
 *         analysis/desktop/app.readable.js:L46699-L46738).
 *
 * Source mirror:
 *   - analysis/desktop/modules/crypto/key-derivation.js:L103-L107
 *   - analysis/desktop/modules/crypto/encryption-provider.js:L34-L63
 *   - analysis/desktop/app.readable.js:L48493-L48505 (`yk`)
 */

// eslint-disable-next-line import/no-nodejs-modules -- vendored crypto snapshot; the released main.js bundles the pure-JS @noble equivalents, so the mobile runtime never loads node:crypto.
import { createHash } from 'node:crypto';
import { scryptDerive } from './scrypt.js';
import { hkdfDerive, INFO_KEY_HASH } from './hkdf.js';
import { bytesToHex, utf8Encode } from './utils.js';
import type { KeyHashVersion } from './types.js';

/**
 * High-level convenience: password + salt → keyHash hex string.
 *
 * The salt string is fed verbatim into BOTH scrypt (after NFKC) and
 * HKDF (as UTF-8 bytes, no NFKC pass). Do not pre-decode hex.
 */
export function passwordToKeyHash(
  password: string,
  salt: string,
  version: KeyHashVersion,
): string {
  const masterKey = scryptDerive(password, salt);
  return generateKeyHash(masterKey, salt, version);
}

/**
 * Lower-level helper: an already-derived masterKey → keyHash hex.
 *
 * Useful when callers want to keep the masterKey for subsequent
 * SIV/GCM derivation without paying the scrypt cost twice.
 */
export function generateKeyHash(
  masterKey: Uint8Array,
  salt: string,
  version: KeyHashVersion,
): string {
  if (masterKey.byteLength !== 32) {
    // Matches the desktop client's invariant at
    // encryption-provider.js:L78-L79 / L130-L131.
    throw new Error('Invalid encryption key');
  }

  switch (version) {
    case 0:
      return keyHashV0(masterKey);
    case 2:
    case 3:
      return keyHashV2V3(masterKey, salt);
    default: {
      // Unreachable given the type, but mirror the desktop throw.
      const _exhaust: never = version;
      throw new Error(`Encryption version not supported: ${String(_exhaust)}`);
    }
  }
}

/**
 * v0: SHA-256 of the 32-byte master key, hex-encoded.
 *
 * Per §3.5: NO salt is mixed in here. The salt influence is baked into
 * the master key via scrypt; v0 simply hashes that out.
 */
function keyHashV0(masterKey: Uint8Array): string {
  const digest = createHash('sha256').update(masterKey).digest();
  return bytesToHex(new Uint8Array(digest));
}

/**
 * v2 / v3: HKDF(masterKey, info="ObsidianKeyHash", salt=utf8(saltStr))
 * returning the 32-byte derived key as lowercase hex.
 *
 * Note: the desktop client wraps this in `AES-CBC + exportKey("raw")`,
 * but that round-trip is just a WebCrypto extractability gimmick — the
 * raw 32 bytes ARE the HKDF output. We skip the WebCrypto round-trip.
 */
function keyHashV2V3(masterKey: Uint8Array, salt: string): string {
  const hkdfSalt = utf8Encode(salt); // §3.6: HKDF salt = utf8(salt string)
  const out = hkdfDerive(masterKey, INFO_KEY_HASH, hkdfSalt, 32);
  return bytesToHex(out);
}
