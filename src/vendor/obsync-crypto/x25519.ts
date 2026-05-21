/**
 * X25519 ECDH (Curve25519 in Montgomery form) for the pair protocol.
 *
 * Used by ROADMAP §2.6 (cross-device masterKey handoff):
 *   1. Each device generates an ephemeral X25519 keypair.
 *   2. After commit-reveal, both compute `shared = X25519(my_priv, peer_pub)`.
 *   3. `shared` is the input keying material for SAS / wrap-key HKDF.
 *
 * Library choice: @noble/curves, which provides:
 *   - RFC 7748 scalar clamping
 *   - Constant-time montgomery ladder
 *   - Rejection of low-order public keys (shared == 0 → throws)
 *
 * We wrap noble so that:
 *   - Public surface uses plain Uint8Array (no Hex string variant)
 *   - Low-order rejection raises `X25519LowOrderError` — a dedicated subclass
 *     so the UI layer can distinguish "peer pub was malicious / corrupt"
 *     from any other crypto failure.
 *   - We additionally check for an all-zero shared as a belt-and-braces
 *     measure (RFC 7748 §6.1); newer noble versions already throw, but if
 *     a future bump regresses we still fail-closed.
 */

import { x25519 as nobleX25519 } from '@noble/curves/ed25519';

export interface X25519KeyPair {
  /** 32-byte scalar (already clamped per RFC 7748 §5). */
  priv: Uint8Array;
  /** 32-byte u-coordinate of public key. */
  pub: Uint8Array;
}

/**
 * Generate a fresh ephemeral X25519 keypair. Call once per pair session
 * — keys MUST NOT be reused across sessions (would break the SAS /
 * wrap_key entropy argument in ROADMAP §2.6.6).
 */
export function generateX25519Keypair(): X25519KeyPair {
  const { secretKey, publicKey } = nobleX25519.keygen();
  // Defensive copy so callers may freely zeroOut without affecting
  // noble's internal state (noble returns fresh arrays today, but we
  // don't want to depend on that contract).
  return {
    priv: Uint8Array.from(secretKey),
    pub: Uint8Array.from(publicKey),
  };
}

/**
 * Compute the X25519 shared secret. Throws on low-order peer keys per
 * RFC 7748 §6.1 — these would produce an all-zero shared and let an
 * attacker collapse two distinct sessions into the same key.
 *
 * @param priv    32-byte private scalar (own).
 * @param pubPeer 32-byte peer public key.
 * @returns       32-byte shared secret (caller should zeroOut after use).
 */
export function x25519Shared(priv: Uint8Array, pubPeer: Uint8Array): Uint8Array {
  if (priv.byteLength !== 32) {
    throw new Error('x25519Shared: priv must be 32 bytes');
  }
  if (pubPeer.byteLength !== 32) {
    throw new Error('x25519Shared: pubPeer must be 32 bytes');
  }

  let shared: Uint8Array;
  try {
    shared = nobleX25519.getSharedSecret(priv, pubPeer);
  } catch (err) {
    // Noble throws "invalid private or public key received" when the
    // shared comes out as the curve identity (low-order input). Surface
    // it as our typed error so call sites can `instanceof`-check.
    const msg = err instanceof Error ? err.message : String(err);
    throw new X25519LowOrderError(
      `x25519 shared secret rejected: ${msg}`,
    );
  }

  // Belt-and-braces: if a future noble version stops throwing and just
  // returns zero, we still reject. RFC 7748 §6.1 explicitly lists the
  // small-subgroup outputs (all-zero u being the principal one).
  if (shared.every((b) => b === 0)) {
    throw new X25519LowOrderError(
      'x25519 shared secret is all-zero — peer pub is a low-order point',
    );
  }
  return shared;
}

/**
 * Dedicated error subclass for low-order / zero-shared rejection. Lets
 * the pair UI distinguish "peer key was malicious" from generic
 * crypto failures and surface a specific banner.
 */
export class X25519LowOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X25519LowOrderError';
  }
}
