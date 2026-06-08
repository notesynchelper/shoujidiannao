/**
 * AES-SIV deterministic encryption per doc/02b-aes-siv.md.
 *
 * Implements:
 *   - Block.dbl: GF(2^128) doubling with R = 0x87 (RFC 5297 §2.3).
 *   - AES-CMAC (RFC 4493) built from raw AES-128/256-ECB single-block encrypt.
 *   - S2V with N=0 additional data — single-input only, matching the
 *     desktop client which never passes AD.
 *   - clearSivBits: zero bits 31 and 63 of the 16-byte SIV tag before
 *     using it as the CTR counter (see aes-siv.js:L320-L323).
 *   - sivEncrypt / sivDecrypt: full RFC 5297 seal/open with constant-
 *     time tag compare and zeroOut on failure.
 *   - sivEncryptV0 / sivDecryptV0: the v0 pseudo-deterministic AES-GCM
 *     path with IV = SHA-256(plaintext)[0:12]. Kept as a SEPARATE
 *     function so it can never be confused with the real AES-SIV path.
 *
 * Source mirror:
 *   - analysis/desktop/modules/crypto/aes-siv.js (entire file)
 *   - analysis/desktop/app.readable.js:L46347-L46609
 */

// eslint-disable-next-line import/no-nodejs-modules -- vendored crypto snapshot; the released main.js bundles the pure-JS @noble equivalents, so the mobile runtime never loads node:crypto.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constantTimeEqual, utf8Encode, utf8Decode, bytesToHex, hexToBytes, zeroOut } from './utils.js';
import type { SivKeySet } from './types.js';

const BLOCK_SIZE = 16;
const R_POLY = 0x87; // GF(2^128) reduction polynomial constant — RFC 5297 §2.3.

// =====================================================================
//  AES single-block ECB encryption (the building block for CMAC).
//
//  RFC 4493 / 5297 are defined in terms of "AES single block encrypt".
//  In Node we get that by AES-CBC with an all-zero IV, single block of
//  input, then taking the first 16 bytes of the output. We need to
//  disable PKCS#7 padding by setting `setAutoPadding(false)` so the
//  cipher actually emits exactly 16 bytes for a 16-byte input.
// =====================================================================

function aesEcbBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  if (block.byteLength !== BLOCK_SIZE) {
    throw new Error('aesEcbBlock: block must be exactly 16 bytes');
  }
  // Pick the cipher name based on key length (16/24/32 → 128/192/256).
  const alg = pickAesCbcAlg(key.byteLength);
  const iv = new Uint8Array(BLOCK_SIZE); // all-zero IV → AES-CBC degenerates
  // to a single-block ECB encrypt for one block of input.
  const cipher = createCipheriv(alg, key, iv);
  cipher.setAutoPadding(false);
  const out1 = cipher.update(block);
  const out2 = cipher.final();
  // With setAutoPadding(false) and exactly one input block, update()
  // emits the 16 ciphertext bytes and final() emits 0 bytes.
  if (out1.byteLength + out2.byteLength !== BLOCK_SIZE) {
    throw new Error('aesEcbBlock: unexpected output length');
  }
  const out = new Uint8Array(BLOCK_SIZE);
  // Buffer's underlying ArrayBufferLike is incompatible with Uint8Array's
  // generic in TS 5.x strict mode — wrap via Uint8Array.from to coerce.
  out.set(Uint8Array.from(out1), 0);
  out.set(Uint8Array.from(out2), out1.byteLength);
  return out;
}

function pickAesCbcAlg(keyLen: number): 'aes-128-cbc' | 'aes-192-cbc' | 'aes-256-cbc' {
  switch (keyLen) {
    case 16:
      return 'aes-128-cbc';
    case 24:
      return 'aes-192-cbc';
    case 32:
      return 'aes-256-cbc';
    default:
      throw new Error(`AES key length must be 16/24/32 bytes, got ${keyLen}`);
  }
}

// =====================================================================
//  GF(2^128) doubling (Block.dbl)
// =====================================================================

/**
 * Multiply X (a 16-byte big-endian GF(2^128) element) by 2 modulo the
 * polynomial x^128 + x^7 + x^2 + x + 1. Returns a new buffer.
 *
 * Mirrors aes-siv.js:L56-L66. We make this branch-free at the XOR step
 * but use a plain branch for the carry shift (Node's V8 will compile
 * that to constant-time integer code; the security risk is far smaller
 * than wrong implementation risk).
 */
export function dbl(x: Uint8Array): Uint8Array {
  if (x.byteLength !== BLOCK_SIZE) {
    throw new Error('dbl: input must be 16 bytes');
  }
  const out = new Uint8Array(BLOCK_SIZE);
  let carry = 0;
  for (let i = BLOCK_SIZE - 1; i >= 0; i--) {
    const v = x[i] ?? 0;
    const newCarry = (v >> 7) & 1;
    out[i] = ((v << 1) | carry) & 0xff;
    carry = newCarry;
  }
  if (carry === 1) {
    // XOR the reduction constant into the low byte (big-endian last byte).
    out[BLOCK_SIZE - 1] = (out[BLOCK_SIZE - 1] ?? 0) ^ R_POLY;
  }
  return out;
}

// =====================================================================
//  AES-CMAC (RFC 4493)
// =====================================================================

function cmacSubkeys(key: Uint8Array): { k1: Uint8Array; k2: Uint8Array } {
  const kZero = aesEcbBlock(key, new Uint8Array(BLOCK_SIZE));
  const k1 = dbl(kZero);
  const k2 = dbl(k1);
  return { k1, k2 };
}

/**
 * Compute AES-CMAC over `msg` with the given AES key.
 *
 * Mirrors aes-siv.js:L148-L220 ("Cmac.importKey/update/finish") but
 * here we operate on a single bytes input rather than streamed chunks
 * because the only caller (S2V) already buffers the message.
 */
export function cmac(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const { k1, k2 } = cmacSubkeys(key);

  // Number of complete + partial blocks. Special-case empty input below.
  const msgLen = msg.byteLength;

  // Determine the last block. If msgLen is a positive multiple of 16,
  // the last block is the trailing 16 bytes XOR K1. Otherwise the last
  // block is (msg ‖ 0x80 ‖ 0x00…) XOR K2 — i.e. CMAC's 10* padding.
  const isComplete = msgLen > 0 && msgLen % BLOCK_SIZE === 0;
  const numBlocks = isComplete
    ? msgLen / BLOCK_SIZE
    : Math.floor(msgLen / BLOCK_SIZE) + 1;

  // CBC-MAC across all blocks with the last-block adjustment.
  let mac: Uint8Array = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < numBlocks; i++) {
    const block = new Uint8Array(BLOCK_SIZE);
    if (i < numBlocks - 1) {
      // Full middle / leading block — copy 16 bytes directly.
      block.set(msg.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE));
    } else {
      // Last block — copy what we have, optionally pad with 10*, XOR
      // with K1 (complete) or K2 (incomplete or empty).
      const start = i * BLOCK_SIZE;
      const slice = msg.subarray(start, msgLen);
      block.set(slice);
      if (isComplete) {
        xorInto(block, k1);
      } else {
        block[slice.byteLength] = 0x80; // remaining bytes are already 0
        xorInto(block, k2);
      }
    }
    xorInto(block, mac); // CBC chaining
    mac = aesEcbBlock(key, block);
  }
  return mac;
}

function xorInto(dst: Uint8Array, src: Uint8Array): void {
  // dst ^= src, in place. Assumes equal length.
  for (let i = 0; i < dst.byteLength; i++) {
    dst[i] = (dst[i] ?? 0) ^ (src[i] ?? 0);
  }
}

// =====================================================================
//  S2V (RFC 5297 §2.4, single-input form)
// =====================================================================

/**
 * S2V for N=0 additional data — only the plaintext is processed.
 *
 * Mirrors aes-siv.js:L285-L313 — note that the desktop client never
 * passes AD, so we deliberately only implement the N=0 form.
 *
 *   if |P| >= 16: T = CMAC(K, P[:-16] || (P[-16:] XOR D))
 *                 where D = CMAC(K, 0^128)
 *   else:        T = CMAC(K, dbl(D) XOR pad(P))
 */
export function s2v(macKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const d = cmac(macKey, new Uint8Array(BLOCK_SIZE)); // CMAC(K, 0^128)

  if (plaintext.byteLength >= BLOCK_SIZE) {
    // Long input path. Take the last 16 bytes, XOR with D, splice back
    // and CMAC the whole thing.
    const merged = new Uint8Array(plaintext.byteLength);
    merged.set(plaintext);
    const tailStart = plaintext.byteLength - BLOCK_SIZE;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      merged[tailStart + i] = (merged[tailStart + i] ?? 0) ^ (d[i] ?? 0);
    }
    return cmac(macKey, merged);
  }

  // Short input path. Pad with 10*, double D, XOR.
  const padded = new Uint8Array(BLOCK_SIZE);
  padded.set(plaintext);
  padded[plaintext.byteLength] = 0x80; // remaining bytes are already 0
  const dDoubled = dbl(d);
  xorInto(padded, dDoubled);
  return cmac(macKey, padded);
}

// =====================================================================
//  clearSivBits: zero bit 31 and bit 63 of the SIV tag for CTR use.
// =====================================================================

/**
 * Returns a NEW buffer with bytes 8 and 12 having their high bit cleared.
 *
 * Per RFC 5297 §2.5, the SIV output is used unchanged as the IV /
 * counter for AES-CTR, EXCEPT that the high bit of the 4th-from-end
 * and 8th-from-end bytes (i.e. bytes 12 and 8 in a 16-byte tag) must
 * be cleared to ensure no overflow into bits that AES-CTR treats as
 * part of the block counter.
 *
 * Mirrors aes-siv.js:L320-L323:
 *   tag[len-8] &= 0x7F;
 *   tag[len-4] &= 0x7F;
 */
export function clearSivBits(tag: Uint8Array): Uint8Array {
  if (tag.byteLength !== BLOCK_SIZE) {
    throw new Error('clearSivBits: tag must be 16 bytes');
  }
  const out = new Uint8Array(BLOCK_SIZE);
  out.set(tag);
  out[BLOCK_SIZE - 8] = (out[BLOCK_SIZE - 8] ?? 0) & 0x7f;
  out[BLOCK_SIZE - 4] = (out[BLOCK_SIZE - 4] ?? 0) & 0x7f;
  return out;
}

// =====================================================================
//  AES-CTR encryption — same key & counter for both directions because
//  CTR is symmetric. Uses Node's built-in aes-256-ctr / aes-128-ctr.
// =====================================================================

function aesCtr(key: Uint8Array, counter: Uint8Array, data: Uint8Array): Uint8Array {
  const alg =
    key.byteLength === 16
      ? 'aes-128-ctr'
      : key.byteLength === 24
        ? 'aes-192-ctr'
        : key.byteLength === 32
          ? 'aes-256-ctr'
          : null;
  if (!alg) {
    throw new Error(`AES key length must be 16/24/32 bytes, got ${key.byteLength}`);
  }
  if (counter.byteLength !== BLOCK_SIZE) {
    throw new Error('aesCtr: counter must be 16 bytes');
  }
  const cipher = createCipheriv(alg, key, counter);
  const a = cipher.update(data);
  const b = cipher.final();
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(Uint8Array.from(a), 0);
  out.set(Uint8Array.from(b), a.byteLength);
  return out;
}

// =====================================================================
//  Public API: AES-SIV seal / open (v2/v3 path)
// =====================================================================

/**
 * AES-SIV seal: returns [tag(16) ‖ ciphertext(len(P))].
 *
 * Mirrors aes-siv.js:L237-L253. The tag is written to the output BEFORE
 * being mutated by clearSivBits — i.e. the on-wire tag retains the
 * original two bits even though the CTR counter doesn't.
 */
export function sivEncrypt(keys: SivKeySet, plaintext: Uint8Array): Uint8Array {
  const tag = s2v(keys.macKey, plaintext); // 16 B SIV tag
  const counter = clearSivBits(tag);
  const ct = aesCtr(keys.ctrKey, counter, plaintext);
  const out = new Uint8Array(BLOCK_SIZE + ct.byteLength);
  out.set(tag, 0);
  out.set(ct, BLOCK_SIZE);
  return out;
}

/**
 * AES-SIV open: validates the tag in constant time, zeroes the
 * (already-decrypted) plaintext on failure, then throws AesSivError.
 *
 * Mirrors aes-siv.js:L256-L282.
 */
export class AesSivError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AesSivError';
  }
}

export function sivDecrypt(keys: SivKeySet, sealed: Uint8Array): Uint8Array {
  if (sealed.byteLength < BLOCK_SIZE) {
    throw new AesSivError('ciphertext is truncated');
  }
  const tag = sealed.subarray(0, BLOCK_SIZE);
  const ct = sealed.subarray(BLOCK_SIZE);
  const counter = clearSivBits(tag);
  const plaintext = aesCtr(keys.ctrKey, counter, ct);
  const tagCheck = s2v(keys.macKey, plaintext);
  if (!constantTimeEqual(tag, tagCheck)) {
    zeroOut(plaintext); // wipe the speculative plaintext before throwing
    throw new AesSivError('ciphertext verification failure!');
  }
  return plaintext;
}

// =====================================================================
//  Public API: deterministicEncodeStr / deterministicDecodeStr (v2/v3)
// =====================================================================

/**
 * Convenience wrapper for the wire format: UTF-8 encode → seal → hex.
 *
 * This is what the desktop client calls "deterministicEncodeStr" — see
 * encryption-provider.js:L183-L194.
 */
export function deterministicEncodeStrV3(keys: SivKeySet, str: string): string {
  const sealed = sivEncrypt(keys, utf8Encode(str));
  return bytesToHex(sealed);
}

export function deterministicDecodeStrV3(keys: SivKeySet, hex: string): string {
  const bytes = hexToBytes(hex);
  const plain = sivDecrypt(keys, bytes);
  return utf8Decode(plain);
}

// =====================================================================
//  v0 path: pseudo-deterministic AES-GCM with IV = SHA-256(plain)[0:12]
//
//  Separate function signatures so v0/v3 cannot be accidentally mixed.
//  Per §3.7 the v0 master key is the raw scrypt output (NOT an HKDF
//  sub-key) — callers must pass the 32-byte masterKey directly.
// =====================================================================

/**
 * v0 deterministic encrypt of a single string for path / hash fields.
 *
 * Output layout: [IV(12) ‖ ciphertext ‖ tag(16)].
 *   IV  = SHA-256(utf8(plaintext))[0:12]
 *   key = masterKey (32 B, scrypt output)
 *
 * Returns the RAW bytes — callers that need hex should `bytesToHex` it.
 */
export function sivEncryptV0(masterKey: Uint8Array, plaintext: string): Uint8Array {
  if (masterKey.byteLength !== 32) {
    throw new Error('Invalid encryption key');
  }
  const bytes = utf8Encode(plaintext);
  // Compute the pseudo-deterministic IV.
  const fullDigest = createHash('sha256').update(bytes).digest();
  const iv = new Uint8Array(12);
  iv.set(fullDigest.subarray(0, 12));

  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct1 = cipher.update(bytes);
  const ct2 = cipher.final();
  const tag = cipher.getAuthTag();

  const out = new Uint8Array(iv.byteLength + ct1.byteLength + ct2.byteLength + tag.byteLength);
  let offset = 0;
  out.set(iv, offset);
  offset += iv.byteLength;
  out.set(Uint8Array.from(ct1), offset);
  offset += ct1.byteLength;
  out.set(Uint8Array.from(ct2), offset);
  offset += ct2.byteLength;
  out.set(Uint8Array.from(tag), offset);
  return out;
}

/**
 * v0 deterministic decrypt — mirror of sivEncryptV0.
 */
export function sivDecryptV0(masterKey: Uint8Array, sealed: Uint8Array): string {
  if (masterKey.byteLength !== 32) {
    throw new Error('Invalid encryption key');
  }
  if (sealed.byteLength < 12 + 16) {
    throw new Error('Encrypted data is bad');
  }
  const iv = sealed.subarray(0, 12);
  const ct = sealed.subarray(12, sealed.byteLength - 16);
  const tag = sealed.subarray(sealed.byteLength - 16);

  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  const a = decipher.update(ct);
  const b = decipher.final(); // throws on tag mismatch
  const plain = new Uint8Array(a.byteLength + b.byteLength);
  plain.set(Uint8Array.from(a), 0);
  plain.set(Uint8Array.from(b), a.byteLength);
  return utf8Decode(plain);
}

// Useful test helper / future-proofing: expose the random-bytes hook
// so tests can monkeypatch if needed. Currently unused internally.
export const _siv_internals_for_tests = {
  cmac,
  s2v,
  dbl,
  clearSivBits,
  aesEcbBlock,
  randomBytes,
};
