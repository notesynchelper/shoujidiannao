/**
 * @obsync/crypto — public re-exports.
 *
 * The package is split into per-primitive modules. This index re-exports
 * every public symbol so downstream packages can do
 *   import { scryptDerive, sivEncrypt, gcmEncrypt } from '@obsync/crypto';
 * without having to know the internal file layout.
 */

export type { KeyHashVersion, MasterKey, SivKeySet, GcmKeySet } from './types.js';

export {
  scryptDerive,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  SCRYPT_DK_LEN,
  SCRYPT_MAXMEM,
} from './scrypt.js';

export {
  hkdfDerive,
  INFO_KEY_HASH,
  INFO_SIV_MAC,
  INFO_SIV_ENC,
  INFO_GCM,
} from './hkdf.js';

export { passwordToKeyHash, generateKeyHash } from './password-keyhash.js';

export {
  sivEncrypt,
  sivDecrypt,
  sivEncryptV0,
  sivDecryptV0,
  deterministicEncodeStrV3,
  deterministicDecodeStrV3,
  dbl,
  clearSivBits,
  AesSivError,
} from './aes-siv.js';

export { gcmEncrypt, gcmDecrypt, GCM_CONSTANTS } from './aes-gcm.js';

export {
  constantTimeEqual,
  zeroOut,
  bytesToHex,
  hexToBytes,
  utf8Encode,
  utf8Decode,
} from './utils.js';

export {
  generateX25519Keypair,
  x25519Shared,
  X25519LowOrderError,
  type X25519KeyPair,
} from './x25519.js';

export {
  buildPairTranscript,
  deriveSasBytes,
  renderSas,
  deriveWrapKey,
  computePairAad,
  computeCommit,
  PAIR_TRANSCRIPT_BYTE_LEN,
  type PairTranscriptInput,
} from './pair-derive.js';

export {
  generateClientVaultKey,
  computeKeyHashV3,
  type ClientVaultKey,
} from './client-vault-key.js';
