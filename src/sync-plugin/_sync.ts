/**
 * `_sync()` — the 4-phase main loop body (spec 05a §3.8).
 *
 * Phases:
 *   A. (omitted in P5 — Phase A is the `.obsidian/` rescan trigger;
 *       our VaultIO returns the full tree on `list()`, so scanning is
 *       implicit in Phase 1 below.)
 *   1. scan         — `io.list()` snapshot of local state
 *   2. newServerFiles — drain server pushes against local state through
 *                     `classifyConflict` and `applyAction`
 *   3. orphans      — local deletions: paths in `previouslySynced` that
 *                     are neither on the server nor on disk → push delete
 *   4. upload       — push every locally-modified file that survived
 *                     phases 1-3, respecting throttleUpload + JustPushed
 *
 * `_sync` returns `true` when it did work and the loop should run again
 * immediately (server frame queue or upload candidate still present);
 * `false` when there's nothing else to do or all candidates are
 * throttled.
 */

import { encode as toBytes, decode as toText } from './codec.js';
import { classifyConflict, type ConflictAction } from './conflict.js';
import { makeConflictedCopyName } from './conflicted-copy.js';
import { JustPushedRing } from './just-pushed.js';
import { mergeObsidianJson, JsonMergeUnsupported } from './obsidian-json-merge.js';
import { canSyncLocalFile, throttleUpload } from './throttle.js';
import { threeWayMerge, MergeFailed } from './three-way-merge.js';
import type {
  FileMeta,
  LocalFileState,
  PushPullTransport,
  ScanSnapshot,
  ServerFileState,
  SyncPluginSettings,
  VaultIO,
} from './types.js';
import { MERGEABLE_EXTS } from './types.js';
import type { SyncLog } from './sync-log.js';

const OBSIDIAN_PREFIX = '.obsidian/';

interface SyncDeps {
  io: VaultIO;
  transport: PushPullTransport;
  justPushed: JustPushedRing;
  settings: SyncPluginSettings;
  log: SyncLog;
  /** Pre-populated state shared with the plugin instance. */
  state: SyncState;
}

/**
 * Mass-delete guard tunables (Phase 3 red line). When Phase 3 would push
 * more deletes than these thresholds allow in a single round, it pauses
 * and surfaces a notice instead — preventing the "vault accidentally
 * wiped" disaster class. See `doc/edge-tests/00-候选清单-Claude侧.md` A8.
 *
 * The guard fires when BOTH conditions are true:
 *   - absolute count > `MASS_DELETE_ABS_FLOOR`
 *   - ratio of deletes / live-baseline > `MASS_DELETE_RATIO`
 *
 * Calibration: 5 absolute is small enough that a user genuinely cleaning
 * up a handful of notes is not blocked; 30% ratio catches the OS-rm /
 * SAF-mount-corrupted / mass-tooling-error case where most of the vault
 * disappears at once but is high enough that a "delete this week's
 * scratch notes" workflow (under-30% of the vault) goes through.
 *
 * The non-content baseline (Welcome.md + `.obsidian/*`) dilutes the
 * ratio for small vaults, so a 6-of-8 delete in a fresh vault works
 * out to ~46% — comfortably over 30%.
 */
export const MASS_DELETE_ABS_FLOOR = 5;
export const MASS_DELETE_RATIO = 0.3;

export interface MassDeleteSnapshot {
  /** Paths that would be push-deleted this round were the guard absent. */
  pendingPaths: string[];
  /** Total non-deleted server baseline rows when the guard fired. */
  liveBaselineCount: number;
  /** Monotonic timestamp (Date.now) of the moment the guard fired. */
  firedAt: number;
}

export interface SyncState {
  /** Path → last-known LocalFileState (persisted across boots in P6). */
  localFiles: Map<string, LocalFileState>;
  /** Path → server baseline (most recent ServerFileState we saw). */
  serverFiles: Map<string, ServerFileState>;
  /** Queue of un-applied server pushes (FIFO, deduped by path). */
  newServerFiles: ServerFileState[];
  /** `true` until first ready frame; spec 05b §3.6 cross-cutter. */
  initial: boolean;
  /**
   * True once the server has emitted `{op:"initial-done"}` (or the
   * initial flag has been flipped off some other way). Phase 3 is hard-
   * gated on this so a premature `initial=false` flip during the first
   * round cannot trigger orphan deletes. See A9.
   */
  initialReplayDone: boolean;
  /** Set of paths uploaded this round; used for upload-stage skips. */
  uploadedThisRound: Set<string>;
  /**
   * Last scan's health signal — populated by `scan()` from the IO's
   * `listSnapshot()` (or defaulted to "healthy" when the IO only
   * implements `list()`). Phase 3 reads this to decide whether the
   * snapshot is trustworthy enough to push deletes.
   */
  scanHealth: ScanHealth;
  /**
   * Set when Phase 3 last refused to push deletes because the would-be
   * count crossed the mass-delete threshold. Cleared as soon as Phase 3
   * runs again with no candidates (so a UI banner doesn't linger after
   * the underlying issue resolves itself) OR as soon as the user
   * approves it via `SyncPlugin.acknowledgePendingMassDelete()`.
   * Surfaced by the plugin host for UI rendering (Notice / settings).
   */
  pendingMassDelete: MassDeleteSnapshot | null;
  /**
   * One-shot acknowledgement of a SPECIFIC `pendingMassDelete` snapshot.
   * Set by `SyncPlugin.acknowledgePendingMassDelete()` after the user
   * approves the listed paths in UI. Phase 3 consumes it when the next
   * candidate set matches the approved snapshot (subset check) — once
   * consumed, the ack is cleared so any subsequent unrelated mass-delete
   * re-arms the guard. Keying on the exact path set prevents a stale
   * "always allow" boolean from disarming the protection forever
   * (codex review feedback).
   */
  pendingMassDeleteAck: { approvedPaths: Set<string>; firedAt: number } | null;
}

export interface ScanHealth {
  /** True when root `list()` threw — Phase 3 skipped wholesale. */
  rootFailed: boolean;
  /** Directory prefixes (with trailing slash) that scan couldn't descend. */
  partialDirs: string[];
  /** Paths the IO filter suppressed but which are still on disk. */
  filtered: Set<string>;
}

function emptyScanHealth(): ScanHealth {
  return { rootFailed: false, partialDirs: [], filtered: new Set() };
}

export function emptySyncState(): SyncState {
  return {
    localFiles: new Map(),
    serverFiles: new Map(),
    newServerFiles: [],
    initial: true,
    initialReplayDone: false,
    uploadedThisRound: new Set(),
    scanHealth: emptyScanHealth(),
    pendingMassDelete: null,
    pendingMassDeleteAck: null,
  };
}

function extOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const fileName = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return '';
  return fileName.slice(dot + 1).toLowerCase();
}

function isObsidianJsonPath(path: string): boolean {
  return path.startsWith(OBSIDIAN_PREFIX) && path.endsWith('.json');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Node 20 supports crypto.subtle natively. Copy into a fresh ArrayBuffer
  // so we can satisfy the BufferSource type without leaking SharedArrayBuffer.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', ab);
  const u = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < u.length; i++) {
    out += u[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

async function refreshLocalHash(io: VaultIO, lf: LocalFileState): Promise<Uint8Array | null> {
  if (lf.folder) return null;
  if (lf.hash) return null;
  const bytes = await io.read(lf.path);
  lf.hash = await sha256Hex(bytes);
  return bytes;
}

function toServerFileFromPush(p: ServerFileState): ServerFileState {
  return { ...p };
}

/** Spec 05a §3.9 — server push enqueue. */
export function enqueueServerPush(state: SyncState, frame: ServerFileState): void {
  // De-dup by path (spec 05a §3.9): if a frame for the same path is
  // already queued, the new frame supersedes — drop the older entry.
  for (let i = 0; i < state.newServerFiles.length; i++) {
    const e = state.newServerFiles[i]!;
    if (e.path === frame.path) {
      state.newServerFiles.splice(i, 1);
      i--;
    }
  }
  if (state.initial) {
    frame.initial = true;
  }
  state.newServerFiles.push(frame);
}

interface PhaseResult {
  /** Whether the loop should immediately run again. */
  more: boolean;
}

/** Phase 1 — fresh `io.list()` (or `io.listSnapshot()` when available). */
async function scan(deps: SyncDeps): Promise<Map<string, FileMeta>> {
  const out = new Map<string, FileMeta>();
  let snapshot: ScanSnapshot;
  if (deps.io.listSnapshot) {
    try {
      snapshot = await deps.io.listSnapshot();
    } catch (err) {
      deps.log.log('error', `scan: listSnapshot threw: ${(err as Error).message}`);
      snapshot = { files: [], rootFailed: true };
    }
  } else {
    try {
      const files = await deps.io.list();
      snapshot = { files };
    } catch (err) {
      deps.log.log('error', `scan: list() threw: ${(err as Error).message}`);
      snapshot = { files: [], rootFailed: true };
    }
  }
  deps.state.scanHealth = {
    rootFailed: snapshot.rootFailed === true,
    partialDirs: snapshot.partialDirs ? [...snapshot.partialDirs] : [],
    filtered: new Set(snapshot.filtered ?? []),
  };
  for (const f of snapshot.files) {
    out.set(f.path, f);
    // Ensure we have a LocalFileState row that matches the scan.
    const existing = deps.state.localFiles.get(f.path);
    if (!existing) {
      deps.state.localFiles.set(f.path, {
        ...f,
        hash: '',
        previouspath: '',
        synctime: 0,
        synchash: '',
      });
    } else {
      // Invalidate hash when size/mtime changed.
      if (existing.mtime !== f.mtime || existing.size !== f.size) {
        existing.hash = '';
      }
      existing.mtime = f.mtime;
      existing.ctime = f.ctime;
      existing.size = f.size;
      existing.folder = f.folder;
    }
  }
  // Drop LocalFileState rows for files that vanished off disk. Skip the
  // drop when scan was unhealthy — we have no idea whether those local
  // entries are still on disk, and forgetting them here would also lose
  // the chance to upload local edits once the IO recovers.
  if (!deps.state.scanHealth.rootFailed) {
    const partialDirs = deps.state.scanHealth.partialDirs;
    const filtered = deps.state.scanHealth.filtered;
    for (const path of [...deps.state.localFiles.keys()]) {
      if (out.has(path)) continue;
      if (filtered.has(path)) continue;
      if (partialDirs.some((p) => path.startsWith(p))) continue;
      deps.state.localFiles.delete(path);
    }
  }
  return out;
}

/** Phase 2 — drain newServerFiles one at a time. */
async function applyNewServerFiles(
  deps: SyncDeps,
  scanSnapshot: Map<string, FileMeta>,
): Promise<PhaseResult> {
  if (deps.state.newServerFiles.length === 0) return { more: false };
  const frame = deps.state.newServerFiles[0]!;
  const local = deps.state.localFiles.get(frame.path);
  // Refresh local hash before classify. scan() invalidates hash on disk
  // mtime/size drift (mobile SAF strips mtime, so hash gets nuked every
  // round); without this we'd hand classifyConflict an empty hash and
  // miss the local-clean-against-baseline short circuit (Case 3),
  // potentially routing into three-way-merge or reject.
  if (local && !local.folder && !local.hash) {
    await refreshLocalHash(deps.io, local);
  }
  const baseline = deps.state.serverFiles.get(frame.path) ?? null;
  const action = classifyConflict({
    local: local ?? { path: frame.path, ctime: 0, mtime: 0, size: 0, folder: false, hash: '' },
    localExists: !!local,
    remote: frame,
    baseline: baseline
      ? { hash: baseline.hash, deleted: baseline.deleted, uid: baseline.uid }
      : null,
    initial: frame.initial === true || deps.state.initial,
    isMergeableExt: MERGEABLE_EXTS.has(extOf(frame.path)),
    isObsidianJson: isObsidianJsonPath(frame.path),
    conflictAction: deps.settings.conflictAction,
  });
  await applyAction(deps, action, frame, local, scanSnapshot);
  // Dequeue regardless of action (renames re-enqueue from outside).
  deps.state.newServerFiles.shift();
  // Update server baseline.
  deps.state.serverFiles.set(frame.path, toServerFileFromPush(frame));
  return { more: true };
}

async function applyAction(
  deps: SyncDeps,
  action: ConflictAction,
  frame: ServerFileState,
  local: LocalFileState | undefined,
  _scan: Map<string, FileMeta>,
): Promise<void> {
  const { io, log, transport, settings, state } = deps;
  switch (action.kind) {
    case 'noop':
      return;
    case 'accept-server': {
      if (frame.folder) {
        await io.mkdir(frame.path);
        return;
      }
      if (frame.deleted) {
        if (await io.exists(frame.path)) {
          try {
            await io.delete(frame.path);
          } catch {
            // ignore
          }
        }
        state.localFiles.delete(frame.path);
        return;
      }
      const pulled = await transport.pull(frame.uid);
      await io.write(frame.path, pulled.data, { ctime: frame.ctime, mtime: frame.mtime });
      const newLf: LocalFileState = {
        path: frame.path,
        folder: false,
        ctime: frame.ctime,
        mtime: frame.mtime,
        size: pulled.data.byteLength,
        hash: frame.hash,
        previouspath: '',
        synctime: Date.now(),
        synchash: frame.hash,
      };
      state.localFiles.set(frame.path, newLf);
      log.log('info', `accept-server: ${frame.path} (${action.reason})`);
      return;
    }
    case 'delete-local': {
      if (await io.exists(frame.path)) {
        try {
          await io.delete(frame.path);
        } catch {
          // folder not empty etc — leave it, baseline still moves.
        }
      }
      state.localFiles.delete(frame.path);
      log.log('info', `delete-local: ${frame.path} (${action.reason})`);
      return;
    }
    case 'rename-type-clash': {
      if (!local) return;
      const newPath = makeConflictedCopyName(frame.path, {
        device: settings.deviceName,
        mtime: local.mtime,
      });
      try {
        await io.rename(frame.path, newPath);
        state.localFiles.delete(frame.path);
        const stat = await io.stat(newPath);
        if (stat) {
          state.localFiles.set(newPath, {
            ...stat,
            hash: local.hash,
            previouspath: frame.path,
            synctime: 0,
            synchash: '',
          });
        }
      } catch (err) {
        log.log('error', `rename-type-clash: ${(err as Error).message}`);
      }
      return;
    }
    case 'conflicted-copy': {
      if (!local) return;
      try {
        const bytes = await io.read(frame.path);
        const copyPath = makeConflictedCopyName(frame.path, {
          device: settings.deviceName,
          mtime: local.mtime,
        });
        await io.write(copyPath, bytes, { ctime: local.ctime, mtime: local.mtime });
        const pulled = await transport.pull(frame.uid);
        await io.write(frame.path, pulled.data, { ctime: frame.ctime, mtime: frame.mtime });
        state.localFiles.set(frame.path, {
          path: frame.path,
          folder: false,
          ctime: frame.ctime,
          mtime: frame.mtime,
          size: pulled.data.byteLength,
          hash: frame.hash,
          previouspath: '',
          synctime: Date.now(),
          synchash: frame.hash,
        });
        log.log('merge', `Conflicted copy stored ${copyPath}`);
      } catch (err) {
        log.log('error', `conflicted-copy: ${(err as Error).message}`);
      }
      return;
    }
    case 'three-way-merge': {
      if (!local) return;
      try {
        const localBytes = await io.read(frame.path);
        const localText = toText(localBytes);
        const baseline = state.serverFiles.get(frame.path);
        let baseText = '';
        if (baseline && !baseline.deleted) {
          try {
            const pulled = await transport.pull(baseline.uid);
            baseText = toText(pulled.data);
          } catch {
            baseText = '';
          }
        }
        const remote = await transport.pull(frame.uid);
        const remoteText = toText(remote.data);
        if (baseText === remoteText) {
          // server has no change relative to baseline.
          return;
        }
        if (localText === remoteText || remoteText.length === 0) {
          return;
        }
        if (!baseText) {
          // No baseline: spec 05b §3.7.6 — prefer server if newer
          // OR file just born within 3 minutes.
          if (
            Math.abs(Date.now() - local.ctime) < 180_000 ||
            frame.mtime > local.mtime
          ) {
            await io.write(frame.path, remote.data, {
              ctime: frame.ctime,
              mtime: frame.mtime,
            });
            state.localFiles.set(frame.path, {
              path: frame.path,
              folder: false,
              ctime: frame.ctime,
              mtime: frame.mtime,
              size: remote.data.byteLength,
              hash: frame.hash,
              previouspath: '',
              synctime: Date.now(),
              synchash: frame.hash,
            });
          }
          return;
        }
        try {
          const merged = threeWayMerge(baseText, localText, remoteText);
          const mergedBytes = toBytes(merged);
          await io.write(frame.path, mergedBytes);
          const mergedHash = await sha256Hex(mergedBytes);
          state.localFiles.set(frame.path, {
            path: frame.path,
            folder: false,
            ctime: local.ctime,
            mtime: Date.now(),
            size: mergedBytes.byteLength,
            hash: mergedHash,
            previouspath: '',
            synctime: 0, // re-uploadable
            synchash: '',
          });
          log.log('merge', `Merge successful ${frame.path}`);
        } catch (err) {
          if (err instanceof MergeFailed) {
            // Spec end-of §3.10: degrade to conflicted-copy.
            const copyPath = makeConflictedCopyName(frame.path, {
              device: settings.deviceName,
              mtime: local.mtime,
            });
            await io.write(copyPath, localBytes, { ctime: local.ctime, mtime: local.mtime });
            await io.write(frame.path, remote.data, {
              ctime: frame.ctime,
              mtime: frame.mtime,
            });
            log.log('merge', `Merge failed → conflicted copy ${copyPath}`);
            state.localFiles.set(frame.path, {
              path: frame.path,
              folder: false,
              ctime: frame.ctime,
              mtime: frame.mtime,
              size: remote.data.byteLength,
              hash: frame.hash,
              previouspath: '',
              synctime: Date.now(),
              synchash: frame.hash,
            });
          } else {
            throw err;
          }
        }
      } catch (err) {
        log.log('error', `merge: ${(err as Error).message}`);
      }
      return;
    }
    case 'obsidian-json-merge': {
      try {
        const localText = await io.readText(frame.path);
        const remote = await transport.pull(frame.uid);
        const remoteText = toText(remote.data);
        let merged: string;
        try {
          merged = mergeObsidianJson(frame.path, localText, remoteText);
        } catch (err) {
          if (err instanceof JsonMergeUnsupported) {
            // Spec 05b §3.8 fallthrough → server wins.
            await io.write(frame.path, remote.data, {
              ctime: frame.ctime,
              mtime: frame.mtime,
            });
            return;
          }
          throw err;
        }
        const mergedBytes = toBytes(merged);
        await io.write(frame.path, mergedBytes);
        log.log('info', `obsidian-json-merge: ${frame.path}`);
      } catch (err) {
        log.log('error', `obsidian-json-merge: ${(err as Error).message}`);
      }
      return;
    }
    case 'reject':
      log.log('warn', `Rejected server change ${frame.path}`);
      return;
    default: {
      // Exhaustiveness guard.
      const _x: never = action;
      void _x;
    }
  }
}

/**
 * Phase 3 — local-deletion → push delete.
 *
 * Safety guards (see `doc/edge-tests/00-候选清单-Claude侧.md` red lines):
 *   - A1: root list() failed → scan can't tell what's on disk; refuse
 *     to delete anything this round.
 *   - A2: a subtree was un-enumerable → skip every path under it.
 *   - A3/A4/A5/A6/A11: SelectiveVaultIO filtered some paths out of the
 *     listing → those paths are still on disk; skip them.
 *   - A8: user (or a backup tool / corrupted SAF mount) wiped a large
 *     fraction of the vault → pause Phase 3, record a snapshot for the
 *     plugin host to surface in UI, do not propagate the mass delete.
 *   - A9: initial replay never reported "done" → refuse Phase 3 because
 *     state.serverFiles may still be racing inbound frames.
 */
async function pushOrphans(
  deps: SyncDeps,
  scanSnapshot: Map<string, FileMeta>,
): Promise<PhaseResult> {
  const { state, transport, justPushed, log } = deps;
  if (state.scanHealth.rootFailed) {
    log.log('warn', 'Phase 3 skipped: scan IO root failed');
    return { more: false };
  }
  // initialReplayDone is the ONLY signal Phase 3 trusts to know the
  // server baseline is complete. The `state.initial` flag is decoupled
  // (it controls the wire-level `initial:true` init request and the
  // conflict-classifier's "case 5/initial accept-server" short-circuit
  // — both of which only apply on the very first connect of a session).
  // Tying Phase 3 to `initial` is brittle because round-completion
  // auto-flips `initial` to false even when no `initial-done` arrived.
  // See `doc/edge-tests/00-候选清单-Claude侧.md` A9 + codex review.
  if (!state.initialReplayDone) {
    log.log('warn', 'Phase 3 skipped: initial replay not yet completed');
    return { more: false };
  }
  const filtered = state.scanHealth.filtered;
  const partialDirs = state.scanHealth.partialDirs;
  const candidates: string[] = [];
  // liveBaselineCount is the denominator of the mass-delete ratio. It
  // MUST exclude paths that this Phase 3 round can't manage anyway
  // (selective-filter, partial-scan subtrees) — otherwise a large
  // filtered set (e.g. excludedFolders covering 900 paths in a 1000-row
  // vault) would dilute the ratio enough that 100% loss of the
  // manageable 100 paths still wouldn't trip the 30% threshold
  // (codex review blocker, 2nd pass).
  let liveBaselineCount = 0;
  for (const [path, srv] of state.serverFiles) {
    if (srv.deleted) continue;
    if (filtered.has(path)) continue;
    if (partialDirs.some((p) => path.startsWith(p))) continue;
    liveBaselineCount++;
    if (scanSnapshot.has(path)) continue;
    candidates.push(path);
  }
  if (candidates.length === 0) {
    // Clear stale guard so a future round with deletes can re-arm.
    if (state.pendingMassDelete) state.pendingMassDelete = null;
    if (state.pendingMassDeleteAck) state.pendingMassDeleteAck = null;
    return { more: false };
  }
  // Mass-delete threshold (A8). Three independent triggers; ANY of them
  // fires the guard. Honour a one-shot acknowledgement that names the
  // exact paths approved by the user — a stale "always allow" boolean
  // could disarm the protection forever (codex review).
  const overFloor = candidates.length > MASS_DELETE_ABS_FLOOR;
  const overRatio =
    liveBaselineCount > 0 &&
    candidates.length / liveBaselineCount > MASS_DELETE_RATIO;
  // Defence for tiny vaults (<5 live rows). "Every live row is missing
  // from scan" is the classic empty-IO disaster; absolute floor would
  // otherwise let it through unflagged.
  const wipeAll =
    liveBaselineCount > 0 && candidates.length === liveBaselineCount;
  const ack = state.pendingMassDeleteAck;
  const ackCovers =
    ack !== null && candidates.every((p) => ack.approvedPaths.has(p));
  const guardArmed = (overFloor && overRatio) || wipeAll;
  if (guardArmed && !ackCovers) {
    state.pendingMassDelete = {
      pendingPaths: [...candidates],
      liveBaselineCount,
      firedAt: Date.now(),
    };
    log.log(
      'warn',
      `Phase 3 paused: mass-delete guard fired (${candidates.length}/${liveBaselineCount} would be deleted; call acknowledgePendingMassDelete() to override)`,
    );
    return { more: false };
  }
  // Crossed the guard. Clear the pending snapshot. The one-shot ack
  // stays alive until its approved set is fully drained — Phase 3 only
  // pushes ONE delete per call (returns more:true to loop), so clearing
  // ack on the first push would re-arm the guard mid-batch and force the
  // user to re-acknowledge for every file (codex review P2).
  state.pendingMassDelete = null;
  const path = candidates[0]!;
  const srv = state.serverFiles.get(path)!;
  await transport.push(
    {
      op: 'push',
      path,
      hash: '',
      size: 0,
      ctime: 0,
      mtime: 0,
      folder: srv.folder,
      deleted: true,
      pieces: 0,
    },
    new Uint8Array(0),
  );
  justPushed.push({ path, folder: srv.folder, deleted: true, mtime: 0, hash: '' });
  // Advance baseline so we don't re-push next round (the server-push
  // echo would normally do this; we mirror it locally for unit tests
  // that don't relay the broadcast).
  state.serverFiles.set(path, { ...srv, deleted: true });
  state.localFiles.delete(path);
  // Drain the path from the ack set. When the set is empty (all
  // approved paths pushed) the ack expires automatically so a brand-new
  // unrelated mass-delete will re-arm the guard.
  if (ack) {
    ack.approvedPaths.delete(path);
    if (ack.approvedPaths.size === 0) state.pendingMassDeleteAck = null;
  }
  log.log('info', `orphan-push-delete: ${path}`);
  return { more: true };
}

/** Phase 4 — upload local-modifications. */
async function uploadLocals(
  deps: SyncDeps,
  scanSnapshot: Map<string, FileMeta>,
  now: number,
): Promise<PhaseResult> {
  const { state, io, transport, justPushed, log, settings } = deps;
  void settings;
  for (const local of state.localFiles.values()) {
    const path = local.path;
    if (state.uploadedThisRound.has(path)) continue;
    if (!scanSnapshot.has(path)) continue;
    const srv = state.serverFiles.get(path);
    if (local.folder) {
      if (!srv || srv.deleted || srv.folder !== local.folder) {
        await transport.push(
          {
            op: 'push',
            path,
            hash: '',
            size: 0,
            ctime: 0,
            mtime: 0,
            folder: true,
            deleted: false,
            pieces: 0,
          },
          new Uint8Array(0),
        );
        justPushed.push({ path, folder: true, deleted: false, mtime: 0, hash: '' });
        state.uploadedThisRound.add(path);
        log.log('info', `upload-folder: ${path}`);
        return { more: true };
      }
      continue;
    }
    const bytes = await refreshLocalHash(io, local);
    // Content-hash-only diff (mirrors official Obsidian Sync). mtime is
    // unreliable on mobile (SAF strips writeBinary's mtime opts, see
    // ObsidianVaultIO Bug#1 fix) and would otherwise trigger a re-upload
    // loop after every accept-server download. size is redundant once
    // hash matches (SHA-256 collision-resistant). See
    // doc/移动端 mtime 同步循环根因分析.md.
    const diff = !srv || srv.deleted || srv.hash !== local.hash;
    if (!diff) continue;
    // Throttle: skip if file pushed recently.
    if (!canSyncLocalFile(now, local.synctime, local.size)) continue;
    if (justPushed.matchPath(path, local.mtime, local.hash)) continue;
    // Official-style double check: reuse refreshed bytes or read now,
    // re-hash, and if it still matches server hash → skip push. Guards
    // against a stale `local.hash` racing the scan/refresh window.
    const data = bytes ?? (await io.read(path));
    if (srv && !srv.deleted) {
      // If bytes came from refreshLocalHash, local.hash is already the
      // fresh hash of the same buffer — skip the redundant SHA-256.
      const freshHash = bytes ? local.hash : await sha256Hex(data);
      if (freshHash === srv.hash) {
        local.hash = freshHash;
        local.size = data.byteLength;
        local.synctime = Date.now();
        local.synchash = freshHash;
        continue;
      }
      local.hash = freshHash;
      local.size = data.byteLength;
    }
    const pieces = data.byteLength === 0 ? 0 : Math.ceil(data.byteLength / 2_097_152);
    await transport.push(
      {
        op: 'push',
        path,
        hash: local.hash,
        size: data.byteLength,
        ctime: local.ctime,
        mtime: local.mtime,
        folder: false,
        deleted: false,
        pieces,
      },
      data,
    );
    local.synctime = Date.now();
    local.synchash = local.hash;
    local.previouspath = '';
    justPushed.push({
      path,
      folder: false,
      deleted: false,
      mtime: local.mtime,
      hash: local.hash,
    });
    state.uploadedThisRound.add(path);
    log.log('info', `upload-file: ${path} (${data.byteLength}B)`);
    return { more: true };
  }
  return { more: false };
}

/** One round of `_sync()`. Returns true if more work is queued. */
export async function runSyncRound(deps: SyncDeps, now: number = Date.now()): Promise<boolean> {
  void throttleUpload; // re-export anchor
  deps.state.uploadedThisRound.clear();
  const snapshot = await scan(deps);
  const phase2 = await applyNewServerFiles(deps, snapshot);
  if (phase2.more) return true;
  const phase3 = await pushOrphans(deps, snapshot);
  if (phase3.more) return true;
  const phase4 = await uploadLocals(deps, snapshot, now);
  if (phase4.more) return true;
  // End of round. The `initial` flag is now only toggled off by
  // `SyncPlugin.onInitialDone()` when the server sends
  // `{op:"initial-done"}` (see edge-test A9 + codex review). Letting
  // `runSyncRound` auto-flip it caused Phase 3 to start mass-deleting
  // mid-replay if a single empty round happened to land first.
  // Round-uniqueness is now `state.initialReplayDone`.
  return false;
}
