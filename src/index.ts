/**
 * @obsync/client — Obsidian-side client surface.
 *
 *   - P3/P4 SyncServer + push/pull (`sync-server.ts`)
 *   - P5 SyncPlugin core (`sync-plugin/`)
 *   - P6 selective-sync filter + Settings UI + login + REST glue.
 *
 * The package doubles as a tsc-compiled library (for jest reuse) and
 * an Obsidian plugin (esbuild bundles `main.ts` into `dist/main.js`).
 */

export { SyncServer, type ClientState, type SyncServerOptions } from './sync-server.js';
export * from './sync-plugin/index.js';

// P6 surface
export { Account, type AccountFields } from './account.js';
export {
  ApiClient,
  ApiError,
  ApiTransportError,
  NotLoggedInError,
  type ApiClientOptions,
} from './api-client.js';
export {
  HostPool,
  expandHostTemplate,
  type HostPoolOptions,
} from './host-pool.js';
export { ObsidianVaultIO } from './adapters/obsidian-vault-io.js';
export {
  allowSyncFile,
  decideSync,
  type AllowDecision,
  type AllowSpecialFlags,
  type AllowSyncMeta,
  type AllowSyncSettings,
  type AllowTypeFlags,
  type SkipReason,
} from './selective/allow-sync-file.js';
export {
  categorizeObsidianPath,
  isPluginManifestFile,
  TOGGLEABLE_SPECIAL_CATEGORIES,
  type ObsidianFileCategory,
} from './selective/obsidian-paths.js';
export {
  isNeverSyncObsidianFile,
  NEVER_SYNC_OBSIDIAN_BASENAMES,
} from './selective/never-sync.js';
export {
  asAllowSyncSettings,
  DATA_VER,
  DEFAULT_ALLOW_SPECIAL_FILES,
  DEFAULT_ALLOW_TYPES,
  DEFAULT_CONFIG_DIR,
  DEFAULT_PER_FILE_MAX,
  defaultPluginData,
  parsePluginData,
  type ConflictAction,
  type PluginData,
} from './settings/data-schema.js';
export {
  renderSettingsTab,
  renderSyncInfo,
  type SettingsHost,
  type SyncInfoSnapshot,
} from './settings/settings-tab.js';
export {
  displayRequireLogin,
  renderPasteTokenSection,
  type RequireLoginCallbacks,
  type RequireLoginHandle,
  type RequireLoginHost,
} from './settings/require-login-view.js';
export {
  autoBootstrapVault,
  DEFAULT_REGION,
  type AutoBootstrapDeps,
  type AutoBootstrapResult,
  type CreateFreshVaultDeps,
} from './settings/auto-bootstrap.js';
export {
  PairDevice1,
  type PairDevice1Options,
} from './pair/pair-device1.js';
export {
  PairDevice2,
  type PairDevice2Options,
} from './pair/pair-device2.js';
export {
  PairBlock,
  type PairBlockOptions,
} from './pair/pair-block.js';
export {
  EMOJI_POOL_256,
  formatSas,
} from './pair/sas-display.js';
export type {
  D1State,
  D2State,
  SasDisplay,
} from './pair/state-types.js';
export { isDevBuild, __setDevBuildForTests } from './plugin-build-flags.js';
