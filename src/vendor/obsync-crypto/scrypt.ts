/**
 * Scrypt key derivation per doc/02a-key-derivation.md §3.1 - §3.2.
 *
 * Fixed parameters (must NOT be changed — they are the wire protocol):
 *   N = 131072 (2^17), r = 8, p = 1, dkLen = 32, maxmem = 268435456 (256 MiB).
 *
 * NOTE on the N=2^17 value: the Obsidian desktop client ships N=2^15 (32768).
 * We deliberately raised the scrypt cost parameter to the OWASP-current
 * recommendation (N=2^17, ~4× CPU/memory) to harden the offline-attack
 * resistance of stolen `keyHash` records. This is the single point at which
 * our implementation diverges from the reverse-engineered Obsidian Sync
 * spec; vault互通 with the official Obsidian desktop client is therefore
 * NOT supported (same password → different masterKey).
 *
 * The FIRST step is NFKC double normalisation of both password and salt;
 * the resulting strings are then UTF-8 encoded and fed to scrypt.
 *
 * Source mirror:
 *   - analysis/desktop/modules/crypto/key-derivation.js:L33-L69
 *   - analysis/desktop/app.readable.js:L46660-L46680 (function `aw`)
 */

import { scrypt } from '@noble/hashes/scrypt';
import { utf8Encode } from './utils.js';

export const SCRYPT_N = 131072;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_DK_LEN = 32;
export const SCRYPT_MAXMEM = 268435456;

/**
 * Derive a 32-byte master key from (password, salt).
 *
 * The salt parameter is the raw salt STRING (32 lowercase hex chars in
 * production) — NOT a decoded 16-byte buffer. The desktop client UTF-8
 * encodes the hex string itself before passing it to scrypt (see
 * `key-derivation.js:L39-L57`). We replicate that behaviour exactly so
 * the keyHash on the wire matches the desktop client.
 *
 * @throws if scrypt rejects the parameters.
 */
export function scryptDerive(password: string, salt: string): Uint8Array {
  // Step 1: NFKC normalise both inputs. The desktop client does this
  // unconditionally for cross-platform consistency (see §3.1 — Unicode
  // NFKC folds full-width / half-width and various compatibility forms
  // into a single canonical form).
  const pwNorm = password.normalize('NFKC');
  const saltNorm = salt.normalize('NFKC');

  // Step 2: UTF-8 encode. `utf8Encode` already yields a Uint8Array — no
  // `Buffer` wrap so this stays mobile-safe (no `node:buffer`).
  const pwBuf = utf8Encode(pwNorm);
  const saltBuf = utf8Encode(saltNorm);

  // Step 3: Run scrypt with the fixed parameters via `@noble/hashes` —
  // pure JS, so it runs on Obsidian Mobile (no `node:crypto`) and is
  // byte-identical to Node's `scryptSync`. `noble` returns a fresh
  // `dkLen`-byte Uint8Array the caller fully owns. Node's `maxmem` guard
  // is unnecessary — noble allocates exactly the scrypt working set.
  return scrypt(pwBuf, saltBuf, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_DK_LEN,
  });
}
