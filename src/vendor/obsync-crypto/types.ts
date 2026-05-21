/**
 * Types shared across the obsync-crypto package.
 *
 * The numeric encryption versions match Obsidian Sync's wire protocol
 * (see doc/02a-key-derivation.md §3.9 — version 1 does not exist).
 */

export type KeyHashVersion = 0 | 2 | 3;

/**
 * 32-byte AES master key, the output of scrypt over (NFKC(password), NFKC(salt)).
 */
export type MasterKey = Uint8Array;

/**
 * v2/v3 AES-SIV sub-keys: two 32-byte raw keys.
 *
 * - `macKey`: HKDF(masterKey, info="ObsidianAesSivMac")  → used for CMAC.
 * - `ctrKey`: HKDF(masterKey, info="ObsidianAesSivEnc")  → used for AES-CTR.
 *
 * Both keys are derived in [encryption-provider.js:L157-L176] with HKDF salt
 * equal to UTF-8(salt_string).
 */
export interface SivKeySet {
  readonly macKey: Uint8Array;
  readonly ctrKey: Uint8Array;
}

/**
 * v0/v2/v3 AES-GCM content key (raw 32 bytes).
 */
export interface GcmKeySet {
  readonly key: Uint8Array;
}
