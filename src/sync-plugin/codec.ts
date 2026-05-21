/**
 * Tiny UTF-8 encode/decode wrappers — kept private to the sync-plugin
 * package so we don't sprinkle `TextEncoder` instances all over.
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder('utf-8');

export function encode(text: string): Uint8Array {
  return ENC.encode(text);
}

export function decode(bytes: Uint8Array): string {
  return DEC.decode(bytes);
}
