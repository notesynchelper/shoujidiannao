/**
 * /pair/* wire types. Source: ROADMAP §2.6.
 *
 * Pair protocol: commit-reveal + X25519 ECDH + SAS comparison. Server
 * relays SHA-256 commitments / X25519 public keys / AES-GCM ciphertext
 * only — never sees plaintext masterKey.
 *
 * Field encoding rules:
 *   - 32-byte commits / pubs / salts: base64url, NO padding (URL-safe)
 *   - 12-byte nonce: base64url, no padding
 *   - AES-GCM ciphertext (≥16 B due to tag): base64url, no padding
 *   - pair_code: 6 ASCII decimal digits ('000000'..'999999')
 *   - session_id_d1 / session_id_d2: 32-char lowercase hex (128 bit)
 *
 * Bearer-secret discipline (ROADMAP §2.6.3):
 *   - pair_code is a PUBLIC routing code; not an authentication credential.
 *   - session_id_* are bearer secrets for poll/reveal/finalize/cancel —
 *     server MUST NOT log/metric them; client MUST NOT render them.
 */

/** Pair session state machine values. */
export type PairState =
  | 'INIT_PENDING'   // D1 init done, awaiting D2 claim
  | 'CLAIMED'        // D2 claimed; both commits in place
  | 'D1_REVEALED'    // D1 has revealed pub/salt
  | 'BOTH_REVEALED'  // D2 has also revealed pub/salt
  | 'SEALED'         // D1 has finalized (uploaded ciphertext); D2 may fetch
  | 'DONE'           // D2 fetched ciphertext; entry destroyed
  | 'DEAD'           // cancelled
  | 'EXPIRED';       // TTL elapsed / session_id unknown

/** Role tag returned by /pair/poll for non-terminal states. */
export type PairRole = 'd1' | 'd2';

// -------------------- /pair/init (D1) --------------------------------

export interface PairInitBody {
  token: string;
  vault_id: string;
  /** base64url(SHA-256(salt_d || pub_d_eph)) = 32 B encoded. */
  commit_d: string;
}

export interface PairInitOk {
  /** 6 decimal digits, zero-padded. */
  pair_code: string;
  /** 128-bit bearer secret for D1 to drive subsequent endpoints. */
  session_id_d1: string;
  expires_in: number;
}

// -------------------- /pair/claim (D2) -------------------------------

export interface PairClaimBody {
  token: string;
  pair_code: string;
  /** base64url(SHA-256(salt_p || pub_p_eph)) = 32 B encoded. */
  commit_p: string;
}

export interface PairClaimOk {
  ok: true;
  session_id_d2: string;
  /** D1's commit, MUST be pinned by D2 client. base64url(32B). */
  commit_d: string;
  vault_id: string;
  vault_name: string;
  /** vault salt (32-char lowercase hex) for D2 to compute keyhash later. */
  salt: string;
  host: string;
  encryption_version: 3;
}

export type PairClaimResp =
  | PairClaimOk
  | { status: 'expired' | 'unauthorized' | 'claimed_by_other' }
  | { error: string };

// -------------------- /pair/reveal-d / reveal-p ---------------------

export interface PairRevealDBody {
  session_id_d1: string;
  /** base64url(32B). */
  pub_d_eph: string;
  /** base64url(32B), the random salt used in commit_d. */
  salt_d: string;
}

export interface PairRevealPBody {
  session_id_d2: string;
  pub_p_eph: string;
  salt_p: string;
}

export type PairRevealResp =
  | { ok: true }
  | { status: 'wrong_state' | 'expired' | 'commit_mismatch' }
  | { error: string };

// -------------------- /pair/poll (both sides) -----------------------

export interface PairPollBody {
  /** Either session_id_d1 or session_id_d2. Server disambiguates. */
  session_id: string;
}

/**
 * Response variants by (role, state). Terminal states omit role since
 * the entry has already been removed from the indices.
 *
 * Client invariants (ROADMAP §2.6.6):
 *   - When `role` is present, verify it matches local role; mismatch = abort.
 *   - Verify `state` matches the expected local phase; unexpected = abort.
 *   - Pin first observed commit (commit_p in CLAIMED for d1; commit_d in
 *     claim response for d2). If a later poll returns a different commit
 *     value than pinned, abort.
 *   - After reveal payloads arrive, locally verify
 *     SHA-256(salt || pub) === pinned_commit before trusting the pub.
 */
export type PairPollResp =
  // D1 visible states
  | { role: 'd1'; state: 'INIT_PENDING' }
  | { role: 'd1'; state: 'CLAIMED'; commit_p: string }
  | { role: 'd1'; state: 'D1_REVEALED' }
  | { role: 'd1'; state: 'BOTH_REVEALED'; pub_p_eph: string; salt_p: string }
  | { role: 'd1'; state: 'SEALED' }
  // D2 visible states
  | { role: 'd2'; state: 'CLAIMED'; commit_d: string }
  | { role: 'd2'; state: 'D1_REVEALED'; pub_d_eph: string; salt_d: string }
  | { role: 'd2'; state: 'BOTH_REVEALED' }
  | {
      role: 'd2';
      state: 'SEALED';
      /** base64url(12B). */
      nonce: string;
      /** base64url AES-GCM ciphertext (≥ 16B for tag). */
      ciphertext: string;
    }
  // Terminal — role-check exempt
  | { state: 'DONE' }
  | { state: 'DEAD' }
  | { state: 'EXPIRED' }
  | { error: string };

// -------------------- /pair/finalize (D1) ---------------------------

export interface PairFinalizeBody {
  session_id_d1: string;
  /** base64url(12B). */
  nonce: string;
  /** base64url, AES-GCM ciphertext with tag appended. */
  ciphertext: string;
}

export type PairFinalizeResp =
  | { ok: true }
  | { status: 'wrong_state' | 'expired' }
  | { error: string };

// -------------------- /pair/cancel (both sides) ---------------------

export interface PairCancelBody {
  session_id: string;
}

export type PairCancelResp =
  | { ok: true; state_was: PairState }
  | { status: 'expired' }
  | { error: string };

// -------------------- Protocol constants -----------------------------

/** Single-byte protocol version, prepended to SAS/wrap transcripts. */
export const PAIR_PROTOCOL_VERSION = 1;

/** Pair session TTL in seconds. */
export const PAIR_TTL_SECONDS = 300;

/** SAS HKDF output byte count. */
export const PAIR_SAS_LEN = 5;

/** Per-user /pair/init rate limit (calls per 60 seconds). */
export const PAIR_INIT_PER_USER_PER_MIN = 5;

/** Pair code length (decimal digits). */
export const PAIR_CODE_LEN = 6;

/** HKDF salt strings (UTF-8 bytes). */
export const PAIR_SAS_SALT = 'obsync/sas/v1';
export const PAIR_WRAP_SALT = 'obsync/wrap/v1';
export const PAIR_TRANSCRIPT_PREFIX = 'obsync/pair/v1';

/** Error literals returned by server pair endpoints (besides /error). */
export const PAIR_ERROR_STRINGS = {
  ACTIVE_SESSION_EXISTS: 'pair session already active, cancel it first',
  INVALID_COMMIT_LENGTH: 'commit must be 32 bytes',
  INVALID_PUB_LENGTH: 'pub_eph must be 32 bytes',
  INVALID_SALT_LENGTH: 'salt must be 32 bytes',
  INVALID_NONCE_LENGTH: 'nonce must be 12 bytes',
  INVALID_PAIR_CODE: 'pair_code must be 6 digits',
} as const;
