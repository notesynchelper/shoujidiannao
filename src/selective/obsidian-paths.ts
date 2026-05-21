/**
 * `.obsidian/` path → category mapper (spec 06 §2.3).
 *
 * Categories match the 8 toggles in the Settings tab (spec 08 §2.2):
 *   app, appearance, hotkey, core-plugin, community-plugin,
 *   appearance-data, core-plugin-data, community-plugin-data.
 *
 * `ignore` covers paths under `<configDir>/` that are hard-blocked
 * regardless of toggles — currently `workspace.json` /
 * `workspace-mobile.json` and the `node_modules` / dot-segment escape
 * hatches enumerated in spec 06 §3.2.
 *
 * `none` means "no rule matched" — the spec treats this as `c = null`
 * which the caller maps to `_allowSyncFile = false` (i.e. unknown
 * files under `.obsidian/` are never synced).
 */

/** Spec 06 §2.3 categories; `ignore`/`none` are local extensions. */
export type ObsidianFileCategory =
  | 'app'
  | 'appearance'
  | 'hotkey'
  | 'core-plugin'
  | 'community-plugin'
  | 'appearance-data'
  | 'core-plugin-data'
  | 'community-plugin-data'
  | 'ignore'
  | 'none';

/** The 8 toggleable categories surfaced in spec 08 §3.2 row 13. */
export const TOGGLEABLE_SPECIAL_CATEGORIES: ReadonlyArray<
  Exclude<ObsidianFileCategory, 'ignore' | 'none'>
> = [
  'app',
  'appearance',
  'hotkey',
  'core-plugin',
  'community-plugin',
  'appearance-data',
  'core-plugin-data',
  'community-plugin-data',
];

/** Spec 06 §2.4 — paths that NEVER sync, no opt-in possible. */
const NEVER_SYNC_OBSIDIAN_FILES = new Set<string>(['workspace.json', 'workspace-mobile.json']);

/**
 * Spec 06 §2.3 last row — the 4 file names that count as a community
 * plugin payload. Anything else under `plugins/<id>/` falls through to
 * `none`.
 */
const PLUGIN_PAYLOAD_FILES = new Set<string>([
  'manifest.json',
  'main.js',
  'styles.css',
  'data.json',
]);

/** Spec 06 §2.3 last row — used independently for Phase-1 scan enumeration. */
export function isPluginManifestFile(basename: string): boolean {
  return PLUGIN_PAYLOAD_FILES.has(basename);
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function extLower(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Categorise a `.obsidian/`-relative path (the substring AFTER
 * `<configDir>/`). Pass in the raw `path` value that the spec calls
 * `o` — the spec uses `o = path.substring(configDir.length + 1)`.
 *
 * The caller is responsible for stripping the `<configDir>/` prefix
 * before invoking this function; we treat `o` as a forward-slash
 * relative path.
 */
export function categorizeObsidianPath(o: string): ObsidianFileCategory {
  // Hard-block: workspace.json / workspace-mobile.json (spec 06 §2.4).
  if (NEVER_SYNC_OBSIDIAN_FILES.has(o)) {
    return 'ignore';
  }

  const segments = o.split('/');

  // Spec 06 §3.2 — drop anything that traverses `node_modules` or a
  // dot-prefixed segment ("hidden" files inside the config dir).
  for (const seg of segments) {
    if (seg === 'node_modules' || seg.startsWith('.')) {
      return 'ignore';
    }
  }

  const leaf = basename(o);
  const ext = extLower(leaf);

  // Named single-file rules (top-level JSON files).
  if (segments.length === 1) {
    if (o === 'app.json' || o === 'types.json') return 'app';
    if (o === 'appearance.json') return 'appearance';
    if (o === 'hotkeys.json') return 'hotkey';
    if (o === 'core-plugins.json' || o === 'core-plugins-migration.json') {
      return 'core-plugin';
    }
    if (o === 'community-plugins.json') return 'community-plugin';

    // Generic core-plugin-data catch: any other top-level .json
    // (spec 06 §2.3 row "core-plugin-data").
    if (ext === 'json') return 'core-plugin-data';
    return 'none';
  }

  // Themes: `themes/<theme>/{theme.css|manifest.json}`.
  if (
    segments[0] === 'themes' &&
    segments.length === 3 &&
    (leaf === 'theme.css' || leaf === 'manifest.json')
  ) {
    return 'appearance-data';
  }

  // Snippets: `snippets/<file>.css`.
  if (segments[0] === 'snippets' && segments.length === 2 && ext === 'css') {
    return 'appearance-data';
  }

  // Community plugin payload: `plugins/<id>/{manifest.json|main.js|styles.css|data.json}`.
  if (
    segments[0] === 'plugins' &&
    segments.length === 3 &&
    isPluginManifestFile(leaf)
  ) {
    return 'community-plugin-data';
  }

  return 'none';
}
