/**
 * Three-way merge (spec 05b §3.10 / IX).
 *
 * Algorithm:
 *   1. `dmp.diff_main(base, ours, /*checklines*\/ true, /*deadline*\/ 0)`
 *   2. If `diffs.length > 2` run `diff_cleanupSemantic` and
 *      `diff_cleanupEfficiency` (spec gating).
 *   3. `patches = dmp.patch_make(base, diffs)`
 *   4. `[merged, results] = dmp.patch_apply(patches, theirs)`
 *   5. Spec 05b §3.10 — desktop client ignores `results[1]`. We
 *      surface `MergeFailed` only when EVERY hunk fails AND the
 *      output equals `theirs` (no progress) — this mirrors what the
 *      upstream sync-plugin caller in P5 will treat as "fall back to
 *      conflicted copy". The spec leaves this gate up to the call site.
 *
 * For our purposes we surface a clear failure when *any* hunk failed so
 * Case 6 can degrade to conflicted-copy per spec 05b end-of §3.10 +
 * §3.7.5 escape. Tests pin both happy + hard-conflict cases.
 */

import { diff_match_patch } from 'diff-match-patch';

export class MergeFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeFailed';
  }
}

export function threeWayMerge(base: string, ours: string, theirs: string): string {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(base, ours, true);
  if (diffs.length > 2) {
    dmp.diff_cleanupSemantic(diffs);
    dmp.diff_cleanupEfficiency(diffs);
  }
  const patches = dmp.patch_make(base, diffs);
  const [merged, results] = dmp.patch_apply(patches, theirs) as [string, boolean[]];
  const anyFailed = Array.isArray(results) && results.some((ok) => ok === false);
  if (anyFailed) {
    // Spec: client ignores results, but the upstream `B` function in
    // 05b explicitly allows degrading to conflicted-copy when merge
    // semantics couldn't be preserved. We make the failure observable
    // here so the caller (conflict.ts) can route to that branch.
    throw new MergeFailed(`patch_apply: ${results.length} hunks, some failed`);
  }
  return merged;
}
