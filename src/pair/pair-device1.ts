/**
 * Pair flow — Device 1 state machine (ROADMAP §2.6.1, §2.6.6, §6.10.1).
 *
 * Device 1 is the **key sender**: it already holds the vault's
 * `masterKey` (e.g. it is the device that did the first-run
 * `/vault/create`). The flow:
 *
 *   1. `start()` POSTs `/pair/init` with a SHA-256 commitment of
 *      `(salt_d, pub_d_eph)`; the server replies with a 6-digit
 *      `pair_code` plus a bearer `session_id_d1`.
 *   2. While the user reads the code aloud to Device 2, this module
 *      polls `/pair/poll` every 2 s.
 *   3. Once D2 claims, the response includes `commit_p` — **pin it**
 *      locally (never accept a different value on later polls) and
 *      immediately reveal `(salt_d, pub_d_eph)` to the server via
 *      `/pair/reveal-d`.
 *   4. Keep polling. When D2 reveals, the poll response carries
 *      `(salt_p, pub_p_eph)`; verify `SHA-256(salt_p||pub_p_eph)`
 *      matches the pinned `commit_p` (server may be MITM-ing).
 *   5. Derive the shared X25519 secret, transcript and SAS; surface
 *      `phase: 'sas_pending'` for the UI to render. **Stop polling**
 *      until the user clicks confirm.
 *   6. `confirmSas()` derives the AES-GCM wrap key from the same
 *      transcript, encrypts the masterKey with a fresh 12-byte nonce
 *      and the transcript-bound AAD, then POSTs `/pair/finalize`.
 *
 * Pure module: no DOM, no Obsidian imports. UI subscribes via
 * `opts.onState`.
 */

import {
  PAIR_TTL_SECONDS,
  type PairPollResp,
} from '@obsync/proto';
import type { ApiClient } from '../api-client.js';
import { formatSas } from './sas-display.js';
import type { D1State } from './state-types.js';

// The crypto agent is expected to expose these primitives. If the
// import fails at compile time (agent B hasn't landed), `// @ts-expect-error`
// markers in tests guard the gap; runtime resolution catches it later.
import {
  buildPairTranscript,
  computeCommit,
  computePairAad,
  deriveSasBytes,
  deriveWrapKey,
  generateX25519Keypair,
  renderSas,
  x25519Shared,
} from '@obsync/crypto';

const DEFAULT_POLL_MS = 2000;

export interface PairDevice1Options {
  api: ApiClient;
  token: string;
  vault_id: string;
  /** The plaintext 32-byte masterKey we want to ship to D2. */
  masterKey: Uint8Array;
  pollIntervalMs?: number;
  onState: (s: D1State) => void;
}

/** base64url **without padding** — matches wire conventions in pair.ts. */
function b64u(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class PairDevice1 {
  private readonly api: ApiClient;
  private readonly token: string;
  private readonly vault_id: string;
  private readonly masterKey: Uint8Array;
  private readonly pollIntervalMs: number;
  private readonly emit: (s: D1State) => void;

  private state: D1State = { phase: 'idle' };
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;

  // session-private material — never log / surface in UI
  private session_id_d1: string | null = null;
  private pair_code: string | null = null;
  private eph_pub: Uint8Array | null = null;
  private eph_priv: Uint8Array | null = null;
  private salt_d: Uint8Array | null = null;
  private commit_d: Uint8Array | null = null;
  private pinned_commit_p: Uint8Array | null = null;
  private revealed_d = false;
  /** Cached transcript once both reveals land. */
  private transcript: Uint8Array | null = null;
  /** X25519 shared secret — derived once SAS is computed; needed for finalize. */
  private shared: Uint8Array | null = null;

  constructor(opts: PairDevice1Options) {
    this.api = opts.api;
    this.token = opts.token;
    this.vault_id = opts.vault_id;
    this.masterKey = opts.masterKey;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.emit = opts.onState;
  }

  /** Idempotent — calling twice in a row is a UI race; second call no-ops. */
  async start(): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'error' &&
        this.state.phase !== 'expired') {
      return;
    }
    this.transitionTo({ phase: 'initializing' });
    try {
      const kp = generateX25519Keypair();
      this.eph_pub = kp.pub;
      this.eph_priv = kp.priv;
      this.salt_d = crypto.getRandomValues(new Uint8Array(32));
      this.commit_d = await computeCommit(this.salt_d, this.eph_pub);

      const resp = await this.api.pairInit({
        token: this.token,
        vault_id: this.vault_id,
        commit_d: b64u(this.commit_d),
      });
      this.session_id_d1 = resp.session_id_d1;
      this.pair_code = resp.pair_code;
      const expires_at = Date.now() + resp.expires_in * 1000;
      this.transitionTo({
        phase: 'code_displayed',
        pair_code: resp.pair_code,
        expires_at,
      });
      this.startPolling();
    } catch (e) {
      this.transitionTo({
        phase: 'error',
        message: e instanceof Error ? e.message : 'init failed',
      });
    }
  }

  /** User clicked "确认一致" — derive wrap key + AES-GCM seal + finalize. */
  async confirmSas(): Promise<void> {
    if (this.state.phase !== 'sas_pending') {
      throw new Error(`confirmSas called in phase=${this.state.phase}`);
    }
    if (!this.session_id_d1 || !this.transcript) {
      throw new Error('internal: missing session_id_d1 or transcript');
    }
    try {
      if (!this.shared) {
        throw new Error('internal: shared not derived');
      }
      const wrapKey = await deriveWrapKey(this.shared, this.transcript);
      const aad = await computePairAad(this.transcript);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      // BufferSource narrowing in lib.dom.d.ts rejects Uint8Array<ArrayBufferLike>;
      // cast to silence the spurious type error.
      const ctBuf = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce as unknown as BufferSource,
          additionalData: aad as unknown as BufferSource,
          tagLength: 128,
        },
        wrapKey,
        this.masterKey as unknown as BufferSource,
      );
      const ct = new Uint8Array(ctBuf);

      const r = await this.api.pairFinalize({
        session_id_d1: this.session_id_d1,
        nonce: b64u(nonce),
        ciphertext: b64u(ct),
      });
      if ('ok' in r && r.ok) {
        this.transitionTo({ phase: 'sealed' });
        return;
      }
      const status = 'status' in r ? r.status : 'unknown';
      this.transitionTo({
        phase: 'error',
        message: `finalize rejected: ${status}`,
      });
    } catch (e) {
      this.transitionTo({
        phase: 'error',
        message: e instanceof Error ? e.message : 'finalize failed',
      });
    }
  }

  /** User clicked Cancel / Reject. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.stopPolling();
    if (this.session_id_d1) {
      try {
        await this.api.pairCancel({ session_id: this.session_id_d1 });
      } catch {
        // swallow — UI is leaving this state anyway
      }
    }
    this.reset();
    this.transitionTo({ phase: 'idle' });
  }

  // -----------------------------------------------------------------
  // internal
  // -----------------------------------------------------------------

  private startPolling(): void {
    this.stopPolling();
    const tick = async (): Promise<void> => {
      if (this.cancelled) return;
      try {
        await this.pollOnce();
      } catch (e) {
        this.transitionTo({
          phase: 'error',
          message: e instanceof Error ? e.message : 'poll failed',
        });
        return;
      }
      // If we left a polling phase, don't re-arm.
      if (this.cancelled) return;
      if (this.state.phase !== 'code_displayed') return;
      this.pollTimer = setTimeout(() => {
        void tick();
      }, this.pollIntervalMs);
    };
    void tick();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.session_id_d1) throw new Error('no session_id_d1');
    const resp = await this.api.pairPoll({ session_id: this.session_id_d1 });
    await this.handlePoll(resp);
  }

  private async handlePoll(resp: PairPollResp): Promise<void> {
    if ('error' in resp) {
      throw new Error(resp.error);
    }
    // terminal states
    if (resp.state === 'EXPIRED') {
      this.stopPolling();
      this.transitionTo({ phase: 'expired' });
      return;
    }
    if (resp.state === 'DEAD' || resp.state === 'DONE') {
      this.stopPolling();
      this.transitionTo({ phase: 'idle' });
      return;
    }
    // Past here roles are required.
    if (!('role' in resp)) {
      throw new Error('poll: missing role for non-terminal state');
    }
    if (resp.role !== 'd1') {
      throw new Error(`poll: expected role=d1, got ${resp.role}`);
    }

    switch (resp.state) {
      case 'INIT_PENDING':
        return; // keep polling
      case 'CLAIMED': {
        // First sighting of commit_p — pin and reveal d.
        const commit_p = fromB64u(resp.commit_p);
        if (commit_p.length !== 32) {
          throw new Error('commit_p must be 32 bytes');
        }
        if (this.pinned_commit_p &&
            !this.constantTimeEqual(this.pinned_commit_p, commit_p)) {
          throw new Error('commit_p changed after pin — possible MITM');
        }
        this.pinned_commit_p = commit_p;
        if (!this.revealed_d) {
          await this.revealD();
        }
        return;
      }
      case 'D1_REVEALED':
        return; // waiting for D2 reveal
      case 'BOTH_REVEALED': {
        await this.deriveSasAndStop(resp.pub_p_eph, resp.salt_p);
        return;
      }
      case 'SEALED':
        // We already finalized; the UI will move to 'sealed' via confirmSas.
        return;
      default:
        return;
    }
  }

  private async revealD(): Promise<void> {
    if (!this.session_id_d1 || !this.eph_pub || !this.salt_d) {
      throw new Error('internal: revealD missing material');
    }
    const r = await this.api.pairRevealD({
      session_id_d1: this.session_id_d1,
      pub_d_eph: b64u(this.eph_pub),
      salt_d: b64u(this.salt_d),
    });
    if ('ok' in r && r.ok) {
      this.revealed_d = true;
      return;
    }
    const status = 'status' in r ? r.status : 'unknown';
    throw new Error(`reveal-d rejected: ${status}`);
  }

  private async deriveSasAndStop(
    pub_p_eph_b64: string,
    salt_p_b64: string,
  ): Promise<void> {
    const eph_priv = this.eph_priv;
    const eph_pub = this.eph_pub;
    const commit_d = this.commit_d;
    const pinned_commit_p = this.pinned_commit_p;
    const pair_code = this.pair_code;
    if (!eph_priv || !eph_pub || !commit_d || !pinned_commit_p || !pair_code) {
      throw new Error('internal: missing material for SAS');
    }
    const pub_p_eph = fromB64u(pub_p_eph_b64);
    const salt_p = fromB64u(salt_p_b64);
    if (pub_p_eph.length !== 32 || salt_p.length !== 32) {
      throw new Error('pub_p_eph/salt_p must be 32 bytes');
    }
    // LOCAL verify against pinned commit_p — this is the MITM gate.
    const expected = await computeCommit(salt_p, pub_p_eph);
    if (!this.constantTimeEqual(expected, pinned_commit_p)) {
      this.stopPolling();
      throw new Error('commit mismatch — possible MITM');
    }

    const shared = x25519Shared(eph_priv, pub_p_eph);
    this.shared = shared;
    const transcript = buildPairTranscript({
      pair_code,
      commit_d,
      commit_p: pinned_commit_p,
      pub_d_eph: eph_pub,
      pub_p_eph,
    });
    this.transcript = transcript;
    const sasBytes = await deriveSasBytes(shared, transcript);
    const sas = renderSas(sasBytes);
    // sanity-check the renderer output before parking in sas_pending
    void formatSas(sas.digits, sas.emojiIndices);

    this.stopPolling();
    this.transitionTo({
      phase: 'sas_pending',
      sas,
      pinned_commit_p,
    });
  }

  private transitionTo(s: D1State): void {
    this.state = s;
    try {
      this.emit(s);
    } catch {
      // UI subscriber bugs must not crash the state machine.
    }
  }

  private constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) {
      r |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return r === 0;
  }

  private reset(): void {
    this.session_id_d1 = null;
    this.pair_code = null;
    this.eph_pub = null;
    this.eph_priv = null;
    this.salt_d = null;
    this.commit_d = null;
    this.pinned_commit_p = null;
    this.revealed_d = false;
    this.transcript = null;
    this.shared = null;
  }
}

/** Re-exported so call sites can reference the constant for UI copy. */
export { PAIR_TTL_SECONDS };
