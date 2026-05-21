/**
 * Spec 06 §2.4 — paths under `<configDir>/` that the client never
 * pushes regardless of allowSpecialFiles. Centralised here so we can
 * assert "no opt-in possible" both in `_allowSyncFile` and at the
 * unit-test boundary.
 *
 * The list intentionally does NOT include hidden-segment / dot-file
 * skips (those are handled inside `categorizeObsidianPath` because the
 * spec inlines them into the same if-chain).
 */

/** Forward-slash basenames that are hard-blocked under `<configDir>/`. */
export const NEVER_SYNC_OBSIDIAN_BASENAMES: ReadonlySet<string> = new Set([
  'workspace.json',
  'workspace-mobile.json',
]);

/**
 * Returns true when `<configDir>/`-relative path is a workspace file
 * the client must never sync. The caller has already stripped the
 * config-dir prefix.
 */
export function isNeverSyncObsidianFile(relativePath: string): boolean {
  return NEVER_SYNC_OBSIDIAN_BASENAMES.has(relativePath);
}
