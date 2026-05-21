/**
 * Common helpers: constant-time compare, zeroOut, hex codecs.
 *
 * `constantTimeEqual` mirrors the desktop client's helper at
 * [analysis/desktop/modules/crypto/aes-siv.js:L326-L331] — except we
 * delegate to Node's `crypto.timingSafeEqual` which guarantees no
 * data-dependent branching at the native layer.
 */

import { timingSafeEqual } from 'node:crypto';

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Length check up front: timingSafeEqual throws on length mismatch. We
  // intentionally short-circuit before touching the native compare so that
  // callers can pass arbitrary-length buffers without crashing. Returning
  // false on length mismatch does not leak useful timing because the lengths
  // are themselves observable plaintext.
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  // Wrap as Buffer to satisfy the Node API. Buffer.from(view) creates a
  // copy of the underlying bytes (not a view), which is fine for compare.
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Zero out a buffer in place. Accepts Uint8Array, Buffer (which IS a
 * Uint8Array), and raw ArrayBuffer.
 */
export function zeroOut(buf: Uint8Array | ArrayBuffer): void {
  if (buf instanceof ArrayBuffer) {
    new Uint8Array(buf).fill(0);
    return;
  }
  buf.fill(0);
}

/**
 * Lowercase hex codec — matches `arrayBufferToHex` /
 * `[analysis/desktop/modules/util/helpers.js:L79-L88]`.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    out += (b >>> 4).toString(16);
    out += (b & 0x0f).toString(16);
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('hexToBytes: odd-length input');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hex.charCodeAt(i * 2);
    const lo = hex.charCodeAt(i * 2 + 1);
    out[i] = (hexNibble(hi) << 4) | hexNibble(lo);
  }
  return out;
}

function hexNibble(c: number): number {
  // '0'..'9'
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  // 'a'..'f'
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  // 'A'..'F'
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  throw new Error('hexToBytes: invalid hex character');
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
