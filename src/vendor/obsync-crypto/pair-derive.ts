/**
 * Pair protocol derivations (ROADMAP §2.6.4 / §2.6.5).
 *
 * The pair handoff hinges on a deterministic *transcript* both devices
 * can reconstruct bit-for-bit from values they have independently
 * observed. From the X25519 shared + transcript we derive:
 *
 *   - sas_bytes (5B)  → 6-digit decimal + 2 emoji indices for user comparison
 *   - wrap_key (32B)  → AES-GCM-256 key that seals the masterKey on D1
 *   - AAD (32B)       → SHA-256(transcript), fed to GCM additionalData
 *
 * Transcript composition (149 bytes total):
 *
 *   "obsync/pair/v1"       (14 B utf8, prefix)
 *   protocol_version       ( 1 B)
 *   pair_code              ( 6 B ASCII digits)
 *   commit_d               (32 B)
 *   commit_p               (32 B)
 *   pub_d_eph              (32 B)
 *   pub_p_eph              (32 B)
 *
 * HKDF salt for SAS / wrap_key is the UTF-8 encoding of the literal
 * string (`"obsync/sas/v1"` / `"obsync/wrap/v1"`), NOT a SHA pre-hash.
 * This matches the canonical `crypto.subtle.deriveBits` shape used by
 * the JS clients in §2.6.4.
 *
 * Crypto provider: Node's `crypto.webcrypto.subtle`. Node ≥ 18 exposes
 * HKDF / AES-GCM / SHA-256 via SubtleCrypto, identical to browser
 * semantics. We intentionally do NOT use `node:crypto.hkdfSync` here
 * because the wrap_key is consumed downstream by `crypto.subtle.encrypt`
 * (`importKey('raw', ..., 'AES-GCM', extractable=false, ...)`) and
 * keeping everything in SubtleCrypto land avoids a needless export/
 * import round-trip.
 */

import {
  PAIR_CODE_LEN,
  PAIR_PROTOCOL_VERSION,
  PAIR_SAS_LEN,
  PAIR_SAS_SALT,
  PAIR_TRANSCRIPT_PREFIX,
  PAIR_WRAP_SALT,
} from '@obsync/proto';
import { utf8Encode } from './utils.js';

// Use `globalThis.crypto.subtle` so the SubtleCrypto runtime is
// IDENTICAL to whatever consumers use directly (window.crypto in the
// Obsidian Electron renderer; Node's globalThis.crypto in jest/node).
// Mixing Node `webcrypto.subtle` with browser `window.crypto.subtle`
// produces incompatible CryptoKey objects — `crypto.subtle.encrypt`
// in the renderer rejects a Node-generated key with the cross-runtime
// error "parameter 2 is not of type 'CryptoKey'".
//
// Node ≥ 19 exposes `globalThis.crypto` per WHATWG spec; we don't
// fall back to `require('node:crypto').webcrypto` because the runtime
// mismatch above would silently break Electron consumers.
const subtle: SubtleCrypto = window.crypto.subtle;

export interface PairTranscriptInput {
  /** Exactly 6 ASCII decimal digits. */
  pair_code: string;
  /** SHA-256(salt_d || pub_d_eph). 32 bytes. */
  commit_d: Uint8Array;
  /** SHA-256(salt_p || pub_p_eph). 32 bytes. */
  commit_p: Uint8Array;
  /** D1 ephemeral X25519 public key. 32 bytes. */
  pub_d_eph: Uint8Array;
  /** D2 ephemeral X25519 public key. 32 bytes. */
  pub_p_eph: Uint8Array;
}

const PREFIX_BYTES = utf8Encode(PAIR_TRANSCRIPT_PREFIX);
const SAS_SALT_BYTES = utf8Encode(PAIR_SAS_SALT);
const WRAP_SALT_BYTES = utf8Encode(PAIR_WRAP_SALT);

/** Total transcript length in bytes; asserted at runtime in `buildPairTranscript`. */
export const PAIR_TRANSCRIPT_BYTE_LEN =
  PREFIX_BYTES.byteLength +
  1 /* protocol version */ +
  PAIR_CODE_LEN +
  32 +
  32 +
  32 +
  32;

/**
 * Build the canonical transcript bytes. Both devices independently
 * compute this from values they have observed; mismatch ⇒ different
 * SAS / wrap_key ⇒ pair will fail (by design — that IS the MITM
 * binding).
 */
export function buildPairTranscript(input: PairTranscriptInput): Uint8Array {
  if (input.pair_code.length !== PAIR_CODE_LEN) {
    throw new Error(
      `buildPairTranscript: pair_code must be ${PAIR_CODE_LEN} ASCII digits`,
    );
  }
  if (!/^[0-9]{6}$/.test(input.pair_code)) {
    throw new Error('buildPairTranscript: pair_code must be 6 decimal digits');
  }
  for (const [name, buf] of [
    ['commit_d', input.commit_d],
    ['commit_p', input.commit_p],
    ['pub_d_eph', input.pub_d_eph],
    ['pub_p_eph', input.pub_p_eph],
  ] as const) {
    if (buf.byteLength !== 32) {
      throw new Error(`buildPairTranscript: ${name} must be 32 bytes`);
    }
  }

  const codeBytes = utf8Encode(input.pair_code); // 6 B, ASCII digits

  const out = new Uint8Array(PAIR_TRANSCRIPT_BYTE_LEN);
  let offset = 0;

  out.set(PREFIX_BYTES, offset);
  offset += PREFIX_BYTES.byteLength;

  out[offset] = PAIR_PROTOCOL_VERSION & 0xff;
  offset += 1;

  out.set(codeBytes, offset);
  offset += codeBytes.byteLength;

  out.set(input.commit_d, offset);
  offset += 32;
  out.set(input.commit_p, offset);
  offset += 32;
  out.set(input.pub_d_eph, offset);
  offset += 32;
  out.set(input.pub_p_eph, offset);
  offset += 32;

  if (offset !== PAIR_TRANSCRIPT_BYTE_LEN) {
    // Should be impossible given the length validation above; assert
    // here so any silent regression in field counts is caught loudly.
    throw new Error(
      `buildPairTranscript: internal length mismatch (${offset} vs ${PAIR_TRANSCRIPT_BYTE_LEN})`,
    );
  }
  return out;
}

/**
 * SHA-256 commit helper: commit = SHA-256(salt || pubEph).
 *
 * Used both at the start of the protocol (`/pair/init` / `/pair/claim`
 * upload `commit_d` / `commit_p`) and at the reveal step (each side
 * verifies the peer's pinned commit before trusting the revealed pub).
 */
export async function computeCommit(
  salt: Uint8Array,
  pubEph: Uint8Array,
): Promise<Uint8Array> {
  if (pubEph.byteLength !== 32) {
    throw new Error('computeCommit: pubEph must be 32 bytes');
  }
  const buf = new Uint8Array(salt.byteLength + pubEph.byteLength);
  buf.set(salt, 0);
  buf.set(pubEph, salt.byteLength);
  const digest = await subtle.digest('SHA-256', buf);
  return new Uint8Array(digest);
}

/** Internal HKDF helper returning raw bytes (vs hkdf.ts which uses Node's hkdfSync). */
async function hkdfRaw(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  // Uint8Array<ArrayBufferLike> isn't structurally compatible with the
  // narrowed BufferSource (which expects ArrayBufferView<ArrayBuffer>).
  // The values are safe at runtime; cast to the wire type to silence
  // the lib.dom.d.ts shenanigans.
  const baseKey = await subtle.importKey(
    'raw',
    ikm as unknown as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as unknown as BufferSource,
      info: info as unknown as BufferSource,
    },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Derive `PAIR_SAS_LEN` (= 5) bytes of SAS material. The mapping to
 * digits + emoji indices lives in `renderSas`.
 */
export async function deriveSasBytes(
  shared: Uint8Array,
  transcript: Uint8Array,
): Promise<Uint8Array> {
  return hkdfRaw(shared, SAS_SALT_BYTES, transcript, PAIR_SAS_LEN);
}

/**
 * Render the 5-byte SAS into human-comparable form per ROADMAP §2.6.4:
 *
 *   digits        = ((b0 << 16) | (b1 << 8) | b2) mod 1_000_000, zero-padded to 6
 *   emojiIndices  = [b3, b4]   // each indexes into the UI's 256-emoji table
 *
 * The UI layer owns the emoji table. We deliberately return indices
 * (not glyphs) so the crypto package has no Unicode dependency and the
 * emoji set can be A/B-tested without churning this code.
 */
export function renderSas(sasBytes: Uint8Array): {
  digits: string;
  emojiIndices: [number, number];
} {
  if (sasBytes.byteLength !== PAIR_SAS_LEN) {
    throw new Error(
      `renderSas: sasBytes must be ${PAIR_SAS_LEN} bytes (got ${sasBytes.byteLength})`,
    );
  }
  const b0 = sasBytes[0] ?? 0;
  const b1 = sasBytes[1] ?? 0;
  const b2 = sasBytes[2] ?? 0;
  const b3 = sasBytes[3] ?? 0;
  const b4 = sasBytes[4] ?? 0;

  // `>>> 0` would be needed if shifts could overflow into negative; here
  // we use plain arithmetic to stay in safe-integer range (max 2^24-1).
  const u24 = b0 * 0x10000 + b1 * 0x100 + b2;
  const digits = String(u24 % 1_000_000).padStart(6, '0');

  return { digits, emojiIndices: [b3, b4] };
}

/**
 * Derive the AES-GCM-256 wrap key. Returned as a non-extractable
 * CryptoKey so the caller cannot accidentally export and log it; pass
 * directly to `crypto.subtle.encrypt`/`decrypt`.
 */
export async function deriveWrapKey(
  shared: Uint8Array,
  transcript: Uint8Array,
): Promise<CryptoKey> {
  const raw = await hkdfRaw(shared, WRAP_SALT_BYTES, transcript, 32);
  return subtle.importKey(
    'raw',
    raw as unknown as BufferSource,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Compute the AES-GCM AAD = SHA-256(transcript). Both sides feed this
 * to `additionalData` so any flip in the underlying transcript fields
 * (commits / pubs / pair_code) breaks the tag check.
 */
export async function computePairAad(transcript: Uint8Array): Promise<Uint8Array> {
  const digest = await subtle.digest(
    'SHA-256',
    transcript as unknown as BufferSource,
  );
  return new Uint8Array(digest);
}
