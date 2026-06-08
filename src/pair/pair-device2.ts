/**
 * Pair flow — Device 2 state machine (ROADMAP §2.6.1, §2.6.6, §6.10.2).
 *
 * Device 2 is the **key receiver**: it has a token (same WeChat
 * account) and a matching local vault row but no local `masterKey`.
 * Flow:
 *
 *   1. User types the 6-digit code from D1's UI. `submitCode()`
 *      generates its own X25519 ephemeral keypair + 32-byte salt,
 *      computes `commit_p`, and POSTs `/pair/claim`. The response
 *      carries D1's `commit_d` — **pin it** plus the vault metadata.
 *   2. Immediately POST `/pair/reveal-p` to reveal `(salt_p, pub_p_eph)`.
 *   3. Poll `/pair/poll`. When D1's reveal lands, the response carries
 *      `(salt_d, pub_d_eph)`. Verify `SHA-256(salt_d||pub_d_eph)`
 *      matches the pinned `commit_d`; derive the shared X25519 secret,
 *      transcript, SAS; surface `phase: 'sas_pending'`.
 *   4. The user compares SAS strings with D1. On confirm, this module
 *      resumes polling until state `SEALED` arrives bearing
 *      `(nonce, ciphertext)`.
 *   5. AES-GCM decrypt with the transcript-bound wrap key + AAD; if the
 *      tag verifies the masterKey is exposed via `phase: 'ready'` and
 *      the caller persists it.
 *
 * Pure module: no DOM, no Obsidian imports.
 */

import type { PairPollResp, VaultMeta } from '@obsync/proto';
import type { ApiClient } from '../api-client.js';
import { formatSas } from './sas-display.js';
import type { D2State } from './state-types.js';

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

export interface PairDevice2Options {
  api: ApiClient;
  token: string;
  pollIntervalMs?: number;
  onState: (s: D2State) => void;
}

function b64u(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
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

export class PairDevice2 {
  private readonly api: ApiClient;
  private readonly token: string;
  private readonly pollIntervalMs: number;
  private readonly emit: (s: D2State) => void;

  private state: D2State = { phase: 'prompt_code' };
  private pollTimer: number | null = null;
  private cancelled = false;

  // private session material
  private session_id_d2: string | null = null;
  private eph_pub: Uint8Array | null = null;
  private eph_priv: Uint8Array | null = null;
  private salt_p: Uint8Array | null = null;
  private commit_p: Uint8Array | null = null;
  private pinned_commit_d: Uint8Array | null = null;
  private vault: VaultMeta | null = null;
  private transcript: Uint8Array | null = null;
  /** Computed once D1 reveals — needed for final GCM-decrypt step. */
  private wrapKey: CryptoKey | null = null;
  private aad: Uint8Array | null = null;

  constructor(opts: PairDevice2Options) {
    this.api = opts.api;
    this.token = opts.token;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.emit = opts.onState;
  }

  /** Validate the 6-digit code and kick off claim + reveal. */
  async submitCode(code: string): Promise<void> {
    if (this.state.phase !== 'prompt_code' && this.state.phase !== 'error') {
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      this.transitionTo({ phase: 'error', message: 'pair code must be 6 digits' });
      return;
    }
    this.transitionTo({ phase: 'claiming' });
    this.lastCode = code;

    try {
      const kp = generateX25519Keypair();
      this.eph_pub = kp.pub;
      this.eph_priv = kp.priv;
      this.salt_p = crypto.getRandomValues(new Uint8Array(32));
      this.commit_p = await computeCommit(this.salt_p, this.eph_pub);

      const r = await this.api.pairClaim({
        token: this.token,
        pair_code: code,
        commit_p: b64u(this.commit_p),
      });

      if (!('ok' in r) || r.ok !== true) {
        const status = 'status' in r ? r.status :
                       'error' in r ? r.error : 'unknown';
        this.transitionTo({
          phase: 'error',
          message: `claim rejected: ${status}`,
        });
        return;
      }

      this.session_id_d2 = r.session_id_d2;
      const commit_d = fromB64u(r.commit_d);
      if (commit_d.length !== 32) {
        this.transitionTo({ phase: 'error', message: 'commit_d must be 32 bytes' });
        return;
      }
      this.pinned_commit_d = commit_d;
      this.vault = this.synthVaultMeta(r);

      // Don't reveal-p yet — protocol requires D1 to reveal-d first
      // (server enforces state transition CLAIMED → D1_REVEALED →
      // BOTH_REVEALED). We poll for D1_REVEALED, then derive SAS, then
      // reveal-p as part of the same handler.
      this.startPolling();
    } catch (e) {
      this.transitionTo({
        phase: 'error',
        message: e instanceof Error ? e.message : 'claim failed',
      });
    }
  }

  /** User clicked "确认一致" — resume polling for the SEALED state. */
  async confirmSas(): Promise<void> {
    if (this.state.phase !== 'sas_pending') {
      throw new Error(`confirmSas called in phase=${this.state.phase}`);
    }
    this.transitionTo({ phase: 'decrypting' });
    this.startPolling(); // resume — we stopped on sas_pending
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.stopPolling();
    if (this.session_id_d2) {
      try {
        await this.api.pairCancel({ session_id: this.session_id_d2 });
      } catch {
        // swallow
      }
    }
    this.reset();
    this.transitionTo({ phase: 'prompt_code' });
  }

  // -----------------------------------------------------------------
  // internal
  // -----------------------------------------------------------------

  private synthVaultMeta(claim: {
    vault_id: string;
    vault_name: string;
    salt: string;
    host: string;
    encryption_version: 3;
  }): VaultMeta {
    // The wire shape returned by /pair/claim is intentionally a slim
    // subset of VaultMeta — populate the rest with sane defaults so
    // downstream code that expects a complete record doesn't NPE. The
    // caller will overwrite size / size_quota / created / keyhash via
    // a follow-up /vault/list after pairing succeeds.
    return {
      id: claim.vault_id,
      name: claim.vault_name,
      host: claim.host,
      // region is not part of /pair/claim — leave blank; caller refreshes.
      region: '',
      encryption_version: claim.encryption_version,
      keyhash: '',
      salt: claim.salt,
      password: '',
      size: 0,
      created: 0,
      size_quota: 0,
    };
  }

  private async revealP(): Promise<void> {
    if (!this.session_id_d2 || !this.eph_pub || !this.salt_p) {
      throw new Error('internal: revealP missing material');
    }
    const r = await this.api.pairRevealP({
      session_id_d2: this.session_id_d2,
      pub_p_eph: b64u(this.eph_pub),
      salt_p: b64u(this.salt_p),
    });
    if ('ok' in r && r.ok) return;
    const status = 'status' in r ? r.status : 'unknown';
    throw new Error(`reveal-p rejected: ${status}`);
  }

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
      if (this.cancelled) return;
      // Re-arm only while in active polling phases.
      if (this.state.phase !== 'claiming' && this.state.phase !== 'decrypting') {
        return;
      }
      this.pollTimer = window.setTimeout(() => {
        void tick();
      }, this.pollIntervalMs);
    };
    void tick();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.session_id_d2) throw new Error('no session_id_d2');
    const resp = await this.api.pairPoll({ session_id: this.session_id_d2 });
    await this.handlePoll(resp);
  }

  private async handlePoll(resp: PairPollResp): Promise<void> {
    // Once we have successfully reached ready / error / dead, drop any
    // poll responses still in flight — server-side the entry was
    // destroyed when D2 fetched SEALED, so the next poll naturally
    // sees EXPIRED, but treating that as a hard error spuriously
    // overwrites the ready state observed by the caller.
    if (
      this.state.phase === 'ready' ||
      this.state.phase === 'error'
    ) {
      return;
    }
    if ('error' in resp) {
      throw new Error(resp.error);
    }
    if (resp.state === 'EXPIRED') {
      this.stopPolling();
      this.transitionTo({ phase: 'error', message: 'pair session expired' });
      return;
    }
    if (resp.state === 'DEAD') {
      this.stopPolling();
      this.transitionTo({ phase: 'error', message: 'pair session cancelled' });
      return;
    }
    if (resp.state === 'DONE') {
      // We already extracted ciphertext below; ignore stragglers.
      this.stopPolling();
      return;
    }
    if (!('role' in resp)) {
      throw new Error('poll: missing role for non-terminal state');
    }
    if (resp.role !== 'd2') {
      throw new Error(`poll: expected role=d2, got ${resp.role}`);
    }

    switch (resp.state) {
      case 'CLAIMED':
        // Server has our claim recorded; D1 hasn't revealed yet.
        return;
      case 'D1_REVEALED': {
        if (this.transcript) {
          // Already derived in a prior tick; just keep polling for SEALED.
          return;
        }
        await this.deriveSasAndPark(resp.pub_d_eph, resp.salt_d);
        return;
      }
      case 'BOTH_REVEALED':
        // We've revealed-p; waiting on D1 to finalize.
        return;
      case 'SEALED':
        if (this.state.phase !== 'decrypting') {
          // User hasn't confirmed SAS yet — ignore until they do.
          return;
        }
        await this.decryptAndFinish(resp.nonce, resp.ciphertext);
        return;
      default:
        return;
    }
  }

  private async deriveSasAndPark(
    pub_d_eph_b64: string,
    salt_d_b64: string,
  ): Promise<void> {
    const eph_priv = this.eph_priv;
    const eph_pub = this.eph_pub;
    const commit_p = this.commit_p;
    const pinned_commit_d = this.pinned_commit_d;
    const vault = this.vault;
    const lastCode = this.lastCode;
    if (!eph_priv || !eph_pub || !commit_p || !pinned_commit_d || !vault || !lastCode) {
      throw new Error('internal: missing material for SAS');
    }
    const pub_d_eph = fromB64u(pub_d_eph_b64);
    const salt_d = fromB64u(salt_d_b64);
    if (pub_d_eph.length !== 32 || salt_d.length !== 32) {
      throw new Error('pub_d_eph/salt_d must be 32 bytes');
    }
    const expected = await computeCommit(salt_d, pub_d_eph);
    if (!this.constantTimeEqual(expected, pinned_commit_d)) {
      this.stopPolling();
      throw new Error('commit mismatch — possible MITM');
    }

    const shared = x25519Shared(eph_priv, pub_d_eph);
    const transcript = buildPairTranscript({
      pair_code: lastCode,
      commit_d: pinned_commit_d,
      commit_p,
      pub_d_eph,
      pub_p_eph: eph_pub,
    });
    this.transcript = transcript;
    this.wrapKey = await deriveWrapKey(shared, transcript);
    this.aad = await computePairAad(transcript);
    const sasBytes = await deriveSasBytes(shared, transcript);
    const sas = renderSas(sasBytes);
    void formatSas(sas.digits, sas.emojiIndices); // throws on garbage

    // Stop the polling loop before issuing reveal-p — both sides will
    // re-poll only after the user clicks confirm.
    this.stopPolling();
    // Now that we have derived shared/SAS, reveal-p so D1's next poll
    // can complete its own SAS derivation. Per protocol this must come
    // strictly after D1's reveal-d (which we just observed).
    try {
      await this.revealP();
    } catch (e) {
      this.transitionTo({
        phase: 'error',
        message: e instanceof Error ? e.message : 'reveal-p failed',
      });
      return;
    }
    this.transitionTo({
      phase: 'sas_pending',
      sas,
      pinned_commit_d,
      vault,
    });
  }

  private async decryptAndFinish(nonce_b64: string, ct_b64: string): Promise<void> {
    const wrapKey = this.wrapKey;
    const aad = this.aad;
    const vault = this.vault;
    if (!wrapKey || !aad || !vault) {
      throw new Error('internal: missing wrap key for decrypt');
    }
    const nonce = fromB64u(nonce_b64);
    const ct = fromB64u(ct_b64);
    if (nonce.length !== 12) {
      throw new Error('nonce must be 12 bytes');
    }
    try {
      // BufferSource narrowing in lib.dom.d.ts rejects Uint8Array<ArrayBufferLike>;
      // cast to silence the spurious type error.
      const ptBuf = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonce as unknown as BufferSource,
          additionalData: aad as unknown as BufferSource,
          tagLength: 128,
        },
        wrapKey,
        ct as unknown as BufferSource,
      );
      const masterKey = new Uint8Array(ptBuf);
      if (masterKey.length !== 32) {
        throw new Error(`decrypted masterKey is ${masterKey.length} B, expected 32`);
      }
      this.stopPolling();
      this.transitionTo({ phase: 'ready', masterKey, vault });
    } catch (e) {
      // Web Crypto signals GCM tag failure with an `OperationError`
      // (browser, jsdom) or, in some Node builds, a plain Error whose
      // message includes `"Cipher job failed"` or `"unable to authenticate
      // data"`. Treat the entire catch as "authentication failed" so
      // the user sees the security-loud message regardless of platform.
      // Other (rare) failure modes still surface their raw message but
      // are de facto authentication failures from the user's POV.
      this.transitionTo({
        phase: 'error',
        message:
          e instanceof Error
            ? `key authentication failed — possible tamper (${e.message || e.name})`
            : 'key authentication failed — possible tamper',
      });
    }
  }

  /** Captured from `submitCode` so the transcript can include it later. */
  private lastCode: string | null = null;

  private transitionTo(s: D2State): void {
    this.state = s;
    try {
      this.emit(s);
    } catch {
      // never let UI bugs corrupt state-machine flow
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
    this.session_id_d2 = null;
    this.eph_pub = null;
    this.eph_priv = null;
    this.salt_p = null;
    this.commit_p = null;
    this.pinned_commit_d = null;
    this.vault = null;
    this.transcript = null;
    this.wrapKey = null;
    this.aad = null;
    this.lastCode = null;
  }
}
