/**
 * Public surface of the sync-plugin module.
 */

export {
  type FileMeta,
  type VaultIO,
  type ScanSnapshot,
  type LocalFileState,
  type ServerFileState,
  type ConflictMode,
  type SyncPluginSettings,
  type PushPullTransport,
  MERGEABLE_EXTS,
} from './types.js';
export { Backoff } from './backoff.js';
export { failedSyncDelay, canRetry, FAILED_SYNC_MAX_DELAY_MS } from './failed-sync.js';
export {
  throttleUpload,
  canSyncLocalFile,
} from './throttle.js';
export {
  SyncLog,
  DESKTOP_LOG_MAX,
  MOBILE_LOG_MAX,
  type LogEntry,
  type LogLevel,
} from './sync-log.js';
export { JustPushedRing, type JustPushedEntry } from './just-pushed.js';
export {
  classifyConflict,
  type ConflictAction,
  type ClassifyInput,
  type ConflictBaseline,
} from './conflict.js';
export {
  threeWayMerge,
  MergeFailed,
} from './three-way-merge.js';
export {
  makeConflictedCopyName,
  sanitizeDeviceName,
  formatTimestamp,
  splitBaseExt,
  type Platform,
  type ConflictedCopyOptions,
} from './conflicted-copy.js';
export {
  mergeObsidianJson,
  patchCorePluginsContent,
  shallowMergeJson,
  JsonMergeUnsupported,
} from './obsidian-json-merge.js';
export { MemoryVaultIO } from './memory-vault-io.js';
export { SyncPlugin, type SyncPluginOptions } from './plugin.js';
export {
  runSyncRound,
  emptySyncState,
  enqueueServerPush,
  MASS_DELETE_ABS_FLOOR,
  MASS_DELETE_RATIO,
  type MassDeleteSnapshot,
  type ScanHealth,
  type SyncState,
} from './_sync.js';
