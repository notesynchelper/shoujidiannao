/**
 * `_allowSyncFile` if/else ladder (spec 06 §3.2).
 *
 * Hard rule: the order of steps below is wire-compatible with the
 * desktop client. We log the reason **before** returning so the
 * Settings UI's "Sync info" panel can surface skip stats.
 *
 * Caller wires up `settings` + `configDir` from the SyncPlugin
 * instance. The spec routes folders through Step 1 (ignoreFolders) →
 * Step 3 (dot-prefix block) → Step 4 (folders default-allow). Files
 * descend further through `.obsidian/` branch, extension whitelist,
 * MIME class lookup, and finally the `unsupported` fallback.
 */

import { categorizeObsidianPath, type ObsidianFileCategory } from './obsidian-paths.js';

// ---------------------------------------------------------------------
// Extension classes (spec 06 §2.2).
// ---------------------------------------------------------------------

const IMAGE_EXTS = new Set<string>(['bmp', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif']);
const AUDIO_EXTS = new Set<string>(['mp3', 'wav', 'm4a', '3gp', 'flac', 'ogg', 'oga', 'opus']);
const VIDEO_EXTS = new Set<string>(['mp4', 'webm', 'ogv', 'mov', 'mkv']);
const PDF_EXTS = new Set<string>(['pdf']);

/** Markup-class extensions — synced regardless of `allowTypes` (spec 06 §3.2 step 6). */
const MARKUP_EXTS = new Set<string>(['md', 'canvas', 'base']);

export interface AllowSyncMeta {
  size: number;
  folder: boolean;
}

export interface AllowTypeFlags {
  md: boolean; // unused by ladder (md is unconditional); kept for UI parity
  image: boolean;
  audio: boolean;
  video: boolean;
  pdf: boolean;
  /** Catch-all for extensions outside the four MIME classes. */
  unsupported: boolean;
}

export interface AllowSpecialFlags {
  app: boolean; // app.json / types.json
  appearance: boolean;
  hotkey: boolean;
  'core-plugin': boolean;
  'community-plugin': boolean;
  'appearance-data': boolean;
  'core-plugin-data': boolean;
  'community-plugin-data': boolean;
}

export interface AllowSyncSettings {
  /** AKA `ignoreFolders` in the spec. Forward-slash strings, no trailing `/`. */
  excludedFolders: string[];
  allowTypes: AllowTypeFlags;
  allowSpecialFiles: AllowSpecialFlags;
  /** Per-file size ceiling. Bytes. */
  perFileMax: number;
  /** Vault config dir; usually `.obsidian` but user-customisable. */
  configDir: string;
}

export type SkipReason =
  | 'ignore-folder-prefix'
  | 'ignore-folder-self'
  | 'oversize'
  | 'obsidian-hidden-segment'
  | 'obsidian-never-sync'
  | 'obsidian-category-disabled'
  | 'obsidian-category-unknown'
  | 'vault-hidden-prefix'
  | 'extension-disabled'
  | 'unsupported-disabled';

export type AllowDecision =
  | { allow: true; reason: 'folder-default' | 'obsidian-allowed' | 'markup' | 'mime-allowed' }
  | { allow: false; reason: SkipReason; detail?: string };

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function extLower(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Spec 06 §3.2 ladder with explicit reason codes. The "syncing"
 * decision returns `{allow: true, reason}` so callers can debug-log;
 * the boolean shorthand is exposed via `allowSyncFile`.
 */
export function decideSync(
  path: string,
  meta: AllowSyncMeta,
  settings: AllowSyncSettings,
): AllowDecision {
  // Step 1 — ignoreFolders (spec 06 §3.2 step 1).
  for (const r of settings.excludedFolders) {
    if (!r) continue;
    if (meta.folder && path === r) {
      return { allow: false, reason: 'ignore-folder-self', detail: r };
    }
    if (path.startsWith(`${r}/`)) {
      return { allow: false, reason: 'ignore-folder-prefix', detail: r };
    }
  }

  const configPrefix = `${settings.configDir}/`;

  // Step 2 — `.obsidian/` branch (files only).
  if (!meta.folder && path.startsWith(configPrefix)) {
    const o = path.substring(configPrefix.length);
    const cat: ObsidianFileCategory = categorizeObsidianPath(o);
    if (cat === 'ignore') {
      // workspace.json / workspace-mobile.json / node_modules / dot.
      const reason: SkipReason =
        o === 'workspace.json' || o === 'workspace-mobile.json'
          ? 'obsidian-never-sync'
          : 'obsidian-hidden-segment';
      return { allow: false, reason, detail: o };
    }
    if (cat === 'none') {
      return { allow: false, reason: 'obsidian-category-unknown', detail: o };
    }
    // Size check applies here too (spec 06 §3.2 doesn't enumerate it
    // for special files but the broader spec ladder does — apply it
    // pre-toggle to mirror the desktop client's perFileMax gate which
    // is shared between branches).
    if (meta.size > settings.perFileMax) {
      return { allow: false, reason: 'oversize', detail: `${meta.size}>${settings.perFileMax}` };
    }
    const ok = settings.allowSpecialFiles[cat];
    if (!ok) {
      return { allow: false, reason: 'obsidian-category-disabled', detail: cat };
    }
    return { allow: true, reason: 'obsidian-allowed' };
  }

  // Step 3 — vault-root hidden file (spec 06 §3.2 step 3).
  if (path.startsWith('.')) {
    return { allow: false, reason: 'vault-hidden-prefix' };
  }

  // Step 4 — folder default allow (spec 06 §3.2 step 4).
  if (meta.folder) {
    return { allow: true, reason: 'folder-default' };
  }

  // Step 4.5 — per-file size cap (apply before any extension check).
  if (meta.size > settings.perFileMax) {
    return { allow: false, reason: 'oversize', detail: `${meta.size}>${settings.perFileMax}` };
  }

  // Step 6 — markup whitelist (md / canvas / base unconditionally).
  const ext = extLower(basename(path));
  if (MARKUP_EXTS.has(ext)) {
    return { allow: true, reason: 'markup' };
  }

  // Step 7 — MIME class lookup.
  if (IMAGE_EXTS.has(ext)) {
    return settings.allowTypes.image
      ? { allow: true, reason: 'mime-allowed' }
      : { allow: false, reason: 'extension-disabled', detail: 'image' };
  }
  if (ext === 'webm') {
    // webm: audio OR video either flag releases it.
    if (settings.allowTypes.audio || settings.allowTypes.video) {
      return { allow: true, reason: 'mime-allowed' };
    }
    return { allow: false, reason: 'extension-disabled', detail: 'webm' };
  }
  if (AUDIO_EXTS.has(ext)) {
    return settings.allowTypes.audio
      ? { allow: true, reason: 'mime-allowed' }
      : { allow: false, reason: 'extension-disabled', detail: 'audio' };
  }
  if (VIDEO_EXTS.has(ext)) {
    return settings.allowTypes.video
      ? { allow: true, reason: 'mime-allowed' }
      : { allow: false, reason: 'extension-disabled', detail: 'video' };
  }
  if (PDF_EXTS.has(ext)) {
    return settings.allowTypes.pdf
      ? { allow: true, reason: 'mime-allowed' }
      : { allow: false, reason: 'extension-disabled', detail: 'pdf' };
  }

  // Step 7 fallback — unsupported toggle.
  return settings.allowTypes.unsupported
    ? { allow: true, reason: 'mime-allowed' }
    : { allow: false, reason: 'unsupported-disabled', detail: ext || '(no-ext)' };
}

/** Boolean shorthand suitable for the SyncPlugin `_allowSyncFile` hook. */
export function allowSyncFile(
  path: string,
  meta: AllowSyncMeta,
  settings: AllowSyncSettings,
): boolean {
  return decideSync(path, meta, settings).allow;
}
