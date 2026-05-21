/**
 * Compile-time flags injected via esbuild --define.
 *
 * `OBSYNC_DEV_BUILD` is the gate for the paste-token developer panel
 * (ROADMAP §6.7). esbuild's `define` replaces the literal identifier
 * `OBSYNC_DEV_BUILD` with `"true"` / `"false"` (the strings, not the
 * booleans) before tree-shaking, so a release bundle reads:
 *
 *     if ("false") { renderPasteToken(...) }
 *
 * which DCE removes wholesale.
 *
 * In tsc / jest the symbol must exist as a real value; we declare a
 * global so test code can flip it at runtime. The default is `false`,
 * matching a release build.
 */

declare global {
  // eslint-disable-next-line no-var
  var OBSYNC_DEV_BUILD: boolean;
}

// The bare identifier `OBSYNC_DEV_BUILD` is replaced by esbuild's
// `define` with the literal string `"true"` / `"false"`. In a plain
// tsc/jest run no such replacement happens, so the symbol does not
// exist on globalThis at all — fall back to `false`.
if (typeof (globalThis as Record<string, unknown>)['OBSYNC_DEV_BUILD'] === 'undefined') {
  // Coerce via `String() === "true"` so the post-bundle replacement
  // ("true" or "false") still yields a real boolean.
  try {
    (globalThis as Record<string, unknown>)['OBSYNC_DEV_BUILD'] =
      String(OBSYNC_DEV_BUILD) === 'true';
  } catch {
    (globalThis as Record<string, unknown>)['OBSYNC_DEV_BUILD'] = false;
  }
}

/** Reads the current flag value (host-controlled in tests). */
export function isDevBuild(): boolean {
  return Boolean((globalThis as Record<string, unknown>)['OBSYNC_DEV_BUILD']);
}

/** Test-only setter — production code must never call this. */
export function __setDevBuildForTests(flag: boolean): void {
  (globalThis as Record<string, unknown>)['OBSYNC_DEV_BUILD'] = flag;
}

export {};
