/**
 * Post-login vault bootstrap (ROADMAP §6.4 / §1.5.2).
 *
 * Plugin semantics: the local Obsidian vault the plugin is installed
 * in **is** the only sync vault. The user never picks or creates one
 * through UI. Right after the 6-digit-code login lands a token, we
 * route into one of three cases:
 *
 *   case A — server already has a vault by this name, AND IndexedDB
 *            already holds the corresponding `masterKey`. Plain reuse;
 *            caller persists vault metadata and starts the sync loop.
 *
 *   case B — server already has a vault by this name, but IndexedDB
 *            has no `masterKey` for it. This is the "second device"
 *            scenario: we still record the vault id but settings UI
 *            must drop into the pair flow (Device 2 side) before
 *            sync can start.
 *
 *   case C — no matching vault on the server: client generates a fresh
 *            `masterKey` + `salt`, computes `keyhash`, calls
 *            `/vault/create`. Caller persists `masterKey` to IndexedDB
 *            **before** kicking sync.
 *
 * The masterKey-presence probe and the fresh-vault creator are
 * injected so jest can drive this module without real Web Crypto,
 * IndexedDB, or `@obsync/crypto` pulled into the unit test bundle.
 *
 * Keep this module pure (no `obsidian` imports) so jest can drive it
 * under jsdom without the Obsidian electron shim.
 */

import type { VaultMeta } from '@obsync/proto';
import type { ApiClient } from '../api-client.js';

/** Single-region deployment — see ROADMAP §6.4 + apps/obsync-server `SUPPORTED_REGIONS`. */
export const DEFAULT_REGION = 'shanghai';

export interface CreateFreshVaultDeps {
  api: ApiClient;
  token: string;
  name: string;
  region: string;
}

export interface AutoBootstrapDeps {
  api: ApiClient;
  token: string;
  /** From `app.vault.getName()` — the on-disk folder name Obsidian opened. */
  localVaultName: string;
  /**
   * Probe: does the client already have a `masterKey` for the given
   * `vault_id`? Returning `true` routes to case A; returning `false`
   * when the vault is known to the server routes to case B (pair flow).
   * Injection lets tests skip real IndexedDB.
   */
  hasLocalMasterKey: (vaultId: string) => Promise<boolean>;
  /**
   * Case-C handler: generate a fresh `masterKey` + `salt`, compute the
   * v3 `keyhash`, call `/vault/create` on `deps.api`, and persist the
   * `masterKey` to IndexedDB **before** returning. The returned
   * `VaultMeta` becomes the caller's record.
   *
   * Injection isolates this module from `@obsync/crypto` so jest tests
   * don't need the crypto package at all.
   */
  createFreshVault: (deps: CreateFreshVaultDeps) => Promise<VaultMeta>;
}

/**
 * Discriminated union: callers route UI on `case`. `reason` is a
 * stable string suitable for E2E log scraping.
 */
export type AutoBootstrapResult =
  | { case: 'A'; vault: VaultMeta; reason: 'reused-with-local-key' }
  | { case: 'B'; vault: VaultMeta; reason: 'reused-needs-pairing' }
  | { case: 'C'; vault: VaultMeta; reason: 'fresh-create' };

export async function autoBootstrapVault(
  deps: AutoBootstrapDeps,
): Promise<AutoBootstrapResult> {
  const list = await deps.api.vaultList(deps.token);
  const existing = list.vaults.find((v) => v.name === deps.localVaultName);
  if (existing) {
    const hasKey = await deps.hasLocalMasterKey(existing.id);
    if (hasKey) {
      return { case: 'A', vault: existing, reason: 'reused-with-local-key' };
    }
    return { case: 'B', vault: existing, reason: 'reused-needs-pairing' };
  }
  const vault = await deps.createFreshVault({
    api: deps.api,
    token: deps.token,
    name: deps.localVaultName,
    region: DEFAULT_REGION,
  });
  return { case: 'C', vault, reason: 'fresh-create' };
}
