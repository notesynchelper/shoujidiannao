/**
 * Thin wrapper around the obsync REST API. Uses global `fetch` so it
 * works in both Obsidian (Electron) and jsdom-backed tests with
 * minimal shim.
 *
 * Error contract: the upstream desktop client distinguishes success vs
 * error **purely by the presence of `error`** in the body. We mirror
 * that here — HTTP status is ignored as long as the JSON parses.
 *
 * The exact literal `Not logged in` is bubbled up as the specialised
 * `NotLoggedInError` so the Settings UI can route to
 * `displayRequireLogin()` (spec 08 §3.1 third branch).
 */

import { NOT_LOGGED_IN_LITERAL } from '@obsync/proto';
import { HostPool } from './host-pool.js';
import type {
  PairCancelBody,
  PairCancelResp,
  PairClaimBody,
  PairClaimResp,
  PairFinalizeBody,
  PairFinalizeResp,
  PairInitBody,
  PairInitOk,
  PairPollBody,
  PairPollResp,
  PairRevealDBody,
  PairRevealPBody,
  PairRevealResp,
  TestIssueTokenBody,
  TestIssueTokenOk,
  UserInfoOk,
  UserTokenBody,
  VaultAccessBody,
  VaultAccessOk,
  VaultCreateBody,
  VaultCreateOk,
  VaultListBody,
  VaultListOk,
  VaultMeta,
  VaultRegionsBody,
  VaultRegionsOk,
  WeChatCodePollBody,
  WeChatCodePollResp,
  WeChatCodeStartOk,
} from '@obsync/proto';

/** Raised exactly when the server replies `{error: "Not logged in"}`. */
export class NotLoggedInError extends Error {
  constructor() {
    super(NOT_LOGGED_IN_LITERAL);
    this.name = 'NotLoggedInError';
  }
}

/** Generic transport error (network down, non-JSON body, etc). */
export class ApiTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiTransportError';
  }
}

/** Anything the server returned in `{error: "..."}` other than the login sentinel. */
export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /**
   * Either a fixed base origin (`https://api.obsync.example`, no
   * trailing slash) or a `HostPool` that supplies one per call. When a
   * `HostPool` is passed, `ApiTransportError` from `fetch` triggers
   * `pool.advance()` and the request is retried against the next slot
   * (up to `pool.size` total attempts) — implementing the relay-1 →
   * relay-N sequential failover. Auth-level errors (`ApiError`,
   * `NotLoggedInError`) and non-transport responses do NOT advance.
   */
  baseUrl: string | HostPool;
  /** Override for tests / DI; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  private readonly baseSource: string | HostPool;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.baseSource =
      typeof opts.baseUrl === 'string'
        ? opts.baseUrl.replace(/\/+$/, '')
        : opts.baseUrl;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Resolve the current HTTPS base — sticky to the pool's active slot. */
  private currentBase(): string {
    return typeof this.baseSource === 'string'
      ? this.baseSource
      : this.baseSource.httpsBase();
  }

  /** How many transport attempts a single REST call may make. */
  private get attemptBudget(): number {
    return this.baseSource instanceof HostPool ? this.baseSource.size : 1;
  }

  // -----------------------------------------------------------------
  // /wechat/code/*
  // -----------------------------------------------------------------

  async wechatCodeStart(): Promise<WeChatCodeStartOk> {
    return this.post<WeChatCodeStartOk>('/wechat/code/start', {});
  }

  async wechatCodePoll(sessionId: string): Promise<WeChatCodePollResp> {
    return this.post<WeChatCodePollResp>('/wechat/code/poll', {
      session_id: sessionId,
    } satisfies WeChatCodePollBody);
  }

  // -----------------------------------------------------------------
  // /test/issue-token
  // -----------------------------------------------------------------

  async testIssueToken(body: TestIssueTokenBody): Promise<TestIssueTokenOk> {
    return this.post<TestIssueTokenOk>('/test/issue-token', body);
  }

  // -----------------------------------------------------------------
  // /user/*
  // -----------------------------------------------------------------

  async userInfo(token: string): Promise<UserInfoOk> {
    return this.post<UserInfoOk>('/user/info', { token } satisfies UserTokenBody);
  }

  async userSignout(token: string): Promise<void> {
    await this.post<Record<string, unknown>>('/user/signout', {
      token,
    } satisfies UserTokenBody);
  }

  // -----------------------------------------------------------------
  // /vault/*
  // -----------------------------------------------------------------

  async vaultList(token: string): Promise<VaultListOk> {
    return this.post<VaultListOk>('/vault/list', {
      token,
      supported_encryption_version: 3,
    } satisfies VaultListBody);
  }

  async vaultRegions(token: string, host?: string): Promise<VaultRegionsOk> {
    const body: VaultRegionsBody = host ? { token, host } : { token };
    return this.post<VaultRegionsOk>('/vault/regions', body);
  }

  /**
   * Client-managed-key vault create (ROADMAP §1.5 / §6.4 case C).
   *
   * Caller must have already generated `masterKey` locally and computed
   * `keyhash + salt` via `@obsync/crypto.generateClientVaultKey()` +
   * `computeKeyHashV3(masterKey, saltHex)`. The server stores both
   * values verbatim and NEVER derives or returns a `password`.
   */
  async vaultCreateClientKey(
    token: string,
    name: string,
    region: string,
    keyhash: string,
    salt: string,
  ): Promise<VaultCreateOk> {
    const body: VaultCreateBody = {
      token,
      name,
      region,
      encryption_version: 3,
      keyhash,
      salt,
    };
    return this.post<VaultCreateOk>('/vault/create', body);
  }

  /**
   * Vault access — server compares submitted `keyhash` to stored row.
   *
   * Caller computes `keyhash` from its local `masterKey + salt` via
   * `computeKeyHashV3`. Server NEVER returns `password`; response is
   * vault metadata only.
   */
  async vaultAccess(
    token: string,
    vaultUid: string,
    keyhash: string,
    host?: string,
  ): Promise<VaultAccessOk> {
    const body: VaultAccessBody = host
      ? { token, vault_uid: vaultUid, keyhash, host, encryption_version: 3 }
      : { token, vault_uid: vaultUid, keyhash, encryption_version: 3 };
    return this.post<VaultAccessOk>('/vault/access', body);
  }

  /**
   * Test-only helper: hits `/vault/list` first and returns the first
   * vault matching `name`. Returns `null` when not found.
   */
  async findVaultByName(token: string, name: string): Promise<VaultMeta | null> {
    const r = await this.vaultList(token);
    return r.vaults.find((v) => v.name === name) ?? null;
  }

  // -----------------------------------------------------------------
  // /pair/* — cross-device key transfer (ROADMAP §2.6)
  //
  // session_id_d1 / session_id_d2 are bearer secrets — callers MUST NOT
  // log them or expose them via any user-visible UI / debug panel.
  // -----------------------------------------------------------------

  async pairInit(body: PairInitBody): Promise<PairInitOk> {
    return this.post<PairInitOk>('/pair/init', body);
  }

  async pairClaim(body: PairClaimBody): Promise<PairClaimResp> {
    return this.post<PairClaimResp>('/pair/claim', body);
  }

  async pairRevealD(body: PairRevealDBody): Promise<PairRevealResp> {
    return this.post<PairRevealResp>('/pair/reveal-d', body);
  }

  async pairRevealP(body: PairRevealPBody): Promise<PairRevealResp> {
    return this.post<PairRevealResp>('/pair/reveal-p', body);
  }

  async pairPoll(body: PairPollBody): Promise<PairPollResp> {
    return this.post<PairPollResp>('/pair/poll', body);
  }

  async pairFinalize(body: PairFinalizeBody): Promise<PairFinalizeResp> {
    return this.post<PairFinalizeResp>('/pair/finalize', body);
  }

  async pairCancel(body: PairCancelBody): Promise<PairCancelResp> {
    return this.post<PairCancelResp>('/pair/cancel', body);
  }

  // -----------------------------------------------------------------
  // Transport
  // -----------------------------------------------------------------

  private async post<T>(path: string, body: unknown): Promise<T> {
    const budget = this.attemptBudget;
    let lastTransportErr: ApiTransportError | null = null;
    for (let attempt = 0; attempt < budget; attempt++) {
      try {
        return await this.postOnce<T>(path, body);
      } catch (e) {
        if (e instanceof ApiTransportError) {
          lastTransportErr = e;
          // Only HostPool-backed clients can fail over; string baseUrl
          // gives up immediately so the error reaches the caller in
          // shape `ApiTransportError(<original message>)`.
          if (this.baseSource instanceof HostPool && attempt < budget - 1) {
            this.baseSource.advance();
            continue;
          }
          throw lastTransportErr;
        }
        // Auth / business errors — do NOT cycle the host pool.
        throw e;
      }
    }
    // budget>=1 always; this guard is unreachable but keeps TS happy.
    throw lastTransportErr ?? new ApiTransportError('all hosts exhausted');
  }

  /** Single-attempt POST against the current base — the failover loop. */
  private async postOnce<T>(path: string, body: unknown): Promise<T> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.currentBase()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'fetch failed';
      throw new ApiTransportError(msg);
    }

    let parsed: unknown;
    try {
      parsed = await resp.json();
    } catch {
      throw new ApiTransportError(`non-json body from ${path}`);
    }

    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = (parsed as { error: unknown }).error;
      if (typeof err === 'string') {
        if (err === NOT_LOGGED_IN_LITERAL) throw new NotLoggedInError();
        throw new ApiError(err);
      }
      throw new ApiError('unknown server error');
    }

    return parsed as T;
  }
}
