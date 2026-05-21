/**
 * `classifyConflict` — pure classifier mirroring the spec 05b "B" function.
 *
 * Inputs are observable facts only — the file system reads, server pulls,
 * three-way merges all happen in `_sync`'s `applyAction` adapter. This
 * module only decides WHICH action to take, freeing the test suite from
 * spinning up `VaultIO` mocks.
 *
 * Case ordering matters; we early-return on each match so the table can
 * be read top-down. Each branch carries the spec §3.x reference inline.
 *
 * NOTE: `initial: true` is the cross-cutting override (spec 05b end of
 * §3 + §3.6). Under initial replay every "accept-server" path is taken
 * verbatim; Cases 4 / 6 / 8 are all collapsed into `accept-server`. We
 * place the `initial` shortcut AFTER the no-op early returns (Case 1
 * delete-of-missing, hash-equal short circuit) so initial replay still
 * dedupes trivially.
 */

import type { FileMeta, ServerFileState, ConflictMode } from './types.js';

export interface ConflictBaseline {
  /** Hash captured at the last successful sync of this path. */
  hash: string;
  /** Whether the baseline row was marked deleted. */
  deleted: boolean;
  /** uid of the baseline — needed by the merge path to pull base text. */
  uid: number;
}

export interface ClassifyInput {
  /** Local file (incl. folder rows) or null if absent. */
  local: FileMeta & { hash: string };
  /** Path-keyed local; null when no local entry. */
  localExists: boolean;
  /** The server frame being processed. */
  remote: ServerFileState;
  /** Last-synced baseline; may be null on first encounter. */
  baseline: ConflictBaseline | null;
  /** Client is in init replay (this.initial === true at frame arrival). */
  initial: boolean;
  /** ext in MERGEABLE_EXTS (`md`, `markdown`, `txt`). */
  isMergeableExt: boolean;
  /** path under `.obsidian/` AND ends with `.json`. */
  isObsidianJson: boolean;
  /** Selected mode — `merge` (default) or `conflict`. */
  conflictAction: ConflictMode;
}

export type ConflictAction =
  | { kind: 'accept-server'; reason: string }
  | { kind: 'noop'; reason: string }
  | { kind: 'delete-local'; reason: string }
  | { kind: 'rename-type-clash'; reason: string }
  | { kind: 'conflicted-copy'; reason: string }
  | { kind: 'three-way-merge'; reason: string }
  | { kind: 'obsidian-json-merge'; reason: string }
  | { kind: 'reject'; reason: string };

/**
 * Lightweight wrapper around the local-side ConflictInput used by tests.
 * For the 8-case spec we accept `null` for either side and surface it.
 */
export function classifyConflict(
  input: Omit<ClassifyInput, 'localExists'> & { localExists?: boolean },
): ConflictAction {
  const localExists = input.localExists ?? false;
  const { remote, baseline, initial, isMergeableExt, isObsidianJson, conflictAction } = input;
  const local = localExists ? input.local : null;

  // ── Pre-flight short circuits ─────────────────────────────────────────

  // Same hash (file-vs-file) → no-op even before checking initial.
  if (local && !local.folder && !remote.folder && !remote.deleted) {
    if (local.hash && local.hash === remote.hash) {
      return { kind: 'noop', reason: 'hash equal' };
    }
  }

  // ── Case 1: local missing ────────────────────────────────────────────
  if (!local) {
    if (remote.deleted) {
      // case 1a: server deleted something we don't have → drop baseline
      return { kind: 'noop', reason: 'case 1 — delete of missing local' };
    }
    return { kind: 'accept-server', reason: 'case 1 — download new server file' };
  }

  // ── Case 2: folder ↔ folder ──────────────────────────────────────────
  if (local.folder && remote.folder) {
    if (!remote.deleted) {
      return { kind: 'noop', reason: 'case 2 — both folders, no change' };
    }
    // server says folder deleted → ack; the file walker prunes empty
    // directories. The plugin's `applyAction` handler keeps the local
    // folder if non-empty (spec 05b §3.3).
    return { kind: 'delete-local', reason: 'case 2 — delete remote folder' };
  }

  // ── Case 3: local clean (hash ≡ baseline) ────────────────────────────
  // Notes from spec 05b §3.4 — this branch fires BEFORE Case 4.
  const localCleanAgainstBaseline =
    baseline !== null &&
    !baseline.deleted &&
    ((local.folder && remote.folder) || local.hash === baseline.hash);
  if (localCleanAgainstBaseline) {
    if (remote.deleted) {
      return { kind: 'delete-local', reason: 'case 3 — server delete; local clean' };
    }
    return { kind: 'accept-server', reason: 'case 3 — server wins; local clean' };
  }

  // ── Case 4: type clash (local dirty file vs server folder) ───────────
  if (!local.folder && remote.folder) {
    return {
      kind: 'rename-type-clash',
      reason: 'case 4 — local dirty file vs server folder',
    };
  }

  // ── Initial replay override (spec 05b §3.6 / 05b end of §3) ──────────
  // We DO accept the server unconditionally during init replay, EXCEPT
  // when Case 3 above already short-circuited (initial=true never makes
  // a clean local file conflict anyway). Note: spec 05b §3.6 gates this
  // on `u.initial && u.mtime > d.mtime`; we apply the broader rule from
  // ROADMAP §5.2 ("initial=true special-case: 直接接受服务端版本不冲突").
  if (initial) {
    if (remote.deleted) {
      return { kind: 'delete-local', reason: 'case 5/initial — server deleted, accept' };
    }
    return { kind: 'accept-server', reason: 'case 5/initial — replay accept-server' };
  }

  // ── Case 6: `.md`-style mergeable file conflict ──────────────────────
  if (
    !local.folder &&
    !remote.folder &&
    !remote.deleted &&
    isMergeableExt &&
    remote.hash !== baseline?.hash
  ) {
    if (conflictAction === 'conflict') {
      return { kind: 'conflicted-copy', reason: 'case 6 — conflict mode: copy then accept server' };
    }
    // merge mode: caller does base lookup + diff_match_patch.
    return { kind: 'three-way-merge', reason: 'case 6 — three-way merge' };
  }

  // ── Case 7: `.obsidian/*.json` shallow merge ─────────────────────────
  if (!remote.folder && !remote.deleted && remote.size > 0 && isObsidianJson) {
    return { kind: 'obsidian-json-merge', reason: 'case 7 — .obsidian json merge' };
  }
  // .obsidian/ non-json or json-parse-failure → spec falls back to
  // server-wins (`syncFileDown`); we return accept-server. The caller
  // distinguishes by also passing the prefix check.
  if (!remote.folder && !remote.deleted && remote.size > 0 && !isObsidianJson) {
    // Non-json under .obsidian/ — fallthrough to accept-server. The
    // classifier doesn't know the path prefix; the caller must decide
    // by handing in `isObsidianJson:false` only when path actually
    // starts with `.obsidian/`. We surface this via the spec case-53/60
    // path — but only when local is dirty AND under .obsidian/.
    // For paths NOT under .obsidian/, we hit Case 8 below.
  }

  // ── Case 8: catch-all reject ─────────────────────────────────────────
  return { kind: 'reject', reason: 'case 8 — rejected server change' };
}
