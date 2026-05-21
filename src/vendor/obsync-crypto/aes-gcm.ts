/**
 * AES-GCM-256 file content encryption per doc/02c-aes-gcm.md.
 *
 *   IV  = 12 random bytes (crypto.randomBytes(12))
 *   tag = 16 bytes (WebCrypto default tagLength=128)
 *   layout = [IV(12) ‖ ciphertext ‖ tag(16)]
 *
 * Empty plaintext is a SPECIAL CASE per §3.5 / S6: the client skips
 * encryption entirely and uploads zero bytes (no IV, no tag). Our
 * `gcmEncrypt` mirrors that by returning an empty Uint8Array.
 *
 * Source mirror:
 *   - analysis/desktop/modules/crypto/aes-gcm.js:L18-L60
 *   - analysis/desktop/app.readable.js:L46614-L46651
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;
const GCM_KEY_LEN = 32; // AES-256

/**
 * Encrypt content bytes with AES-GCM-256.
 *
 * Per spec, the empty-plaintext case returns an empty buffer — the
 * caller (push pipeline) MUST guard with `content.byteLength > 0`
 * before calling this. We replicate that semantic here defensively.
 *
 * @param key       32-byte AES-GCM key.
 * @param plaintext Content bytes to encrypt.
 * @param iv        Optional explicit IV (12 bytes). Defaults to a fresh
 *                  random IV — tests use this for deterministic vectors.
 */
export function gcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  iv?: Uint8Array,
): Uint8Array {
  if (key.byteLength !== GCM_KEY_LEN) {
    throw new Error(`gcmEncrypt: key must be ${GCM_KEY_LEN} bytes`);
  }

  // Empty-plaintext shortcut — return empty buffer (push path's S6
  // semantic). The aes-gcm primitive in the desktop code does NOT have
  // this shortcut; it's enforced at the SyncServer.push layer. We bake
  // it in here for safety because the only legitimate empty-encrypt
  // call site is the push pipeline.
  if (plaintext.byteLength === 0) {
    return new Uint8Array(0);
  }

  const useIv = iv ?? randomBytes(GCM_IV_LEN);
  if (useIv.byteLength !== GCM_IV_LEN) {
    throw new Error(`gcmEncrypt: IV must be ${GCM_IV_LEN} bytes`);
  }

  const cipher = createCipheriv('aes-256-gcm', key, useIv);
  const ct1 = cipher.update(plaintext);
  const ct2 = cipher.final();
  const tag = cipher.getAuthTag();

  const out = new Uint8Array(GCM_IV_LEN + ct1.byteLength + ct2.byteLength + tag.byteLength);
  let offset = 0;
  out.set(useIv, offset);
  offset += GCM_IV_LEN;
  out.set(Uint8Array.from(ct1), offset);
  offset += ct1.byteLength;
  out.set(Uint8Array.from(ct2), offset);
  offset += ct2.byteLength;
  out.set(Uint8Array.from(tag), offset);
  return out;
}

/**
 * Decrypt the [IV ‖ ct ‖ tag] layout.
 *
 * Per spec, byteLength === 12 returns empty (IV-only tolerance — see
 * §3.3) but byteLength === 0 ALSO returns empty (the push-path zero-
 * length sentinel — see S6). byteLength < 12 throws "Encrypted data is
 * bad". byteLength in (12, 28) propagates the WebCrypto OperationError
 * via Node's GCM tag failure path.
 */
export function gcmDecrypt(key: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (key.byteLength !== GCM_KEY_LEN) {
    throw new Error(`gcmDecrypt: key must be ${GCM_KEY_LEN} bytes`);
  }
  // Zero-length sentinel from the push path (S6): empty in, empty out.
  if (sealed.byteLength === 0) {
    return new Uint8Array(0);
  }
  if (sealed.byteLength < GCM_IV_LEN) {
    throw new Error('Encrypted data is bad');
  }
  // IV-only tolerance branch — mirrors aes-gcm.js:L52-L54.
  if (sealed.byteLength === GCM_IV_LEN) {
    return new Uint8Array(0);
  }
  if (sealed.byteLength < GCM_IV_LEN + GCM_TAG_LEN) {
    // < 28 bytes: there's some "ciphertext+tag" but not even a full tag.
    // Let Node's GCM tag check produce the eventual error rather than
    // pre-rejecting — this matches the desktop behaviour of "step 5
    // delegates the error to subtle.decrypt".
    // We still need to slice out a tag to call setAuthTag; do the
    // straightforward thing and let it fail naturally.
  }

  const iv = sealed.subarray(0, GCM_IV_LEN);
  const tagStart = sealed.byteLength - GCM_TAG_LEN;
  if (tagStart <= GCM_IV_LEN - 1) {
    // Should not happen given the prior length checks but keeps the
    // subarray indices honest.
    throw new Error('Encrypted data is bad');
  }
  const ct = sealed.subarray(GCM_IV_LEN, tagStart);
  const tag = sealed.subarray(tagStart);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const a = decipher.update(ct);
  const b = decipher.final(); // throws on auth failure
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(Uint8Array.from(a), 0);
  out.set(Uint8Array.from(b), a.byteLength);
  return out;
}

export const GCM_CONSTANTS = {
  IV_LEN: GCM_IV_LEN,
  TAG_LEN: GCM_TAG_LEN,
  KEY_LEN: GCM_KEY_LEN,
} as const;
