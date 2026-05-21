/**
 * SyncPlugin — top-level orchestrator gluing the helpers together.
 *
 * P5 scope:
 *   - Holds `_sync` state (localFiles / serverFiles / newServerFiles)
 *   - Wires VaultIO + PushPullTransport + SyncLog + JustPushed
 *   - Surfaces `onServerPush(frame)` for the wire layer
 *   - Exposes `runOnce()` and `requestSync()` (50ms-merged loop)
 *
 * Not in scope (P6): IndexedDB persistence (`loadData`/`saveData`),
 * status-bar UI, Obsidian event subscription, selective-sync filter.
 */

import { Backoff } from './backoff.js';
import { failedSyncDelay, type FileRetryEntry } from './failed-sync.js';
import { JustPushedRing } from './just-pushed.js';
import { runSyncRound, emptySyncState, type SyncState, enqueueServerPush } from './_sync.js';
import { SyncLog, DESKTOP_LOG_MAX, MOBILE_LOG_MAX } from './sync-log.js';
import type {
  PushPullTransport,
  ServerFileState,
  SyncPluginSettings,
  VaultIO,
} from './types.js';

export interface SyncPluginOptions {
  io: VaultIO;
  transport: PushPullTransport;
  settings: SyncPluginSettings;
}

export class SyncPlugin {
  readonly io: VaultIO;
  readonly transport: PushPullTransport;
  readonly settings: SyncPluginSettings;
  readonly log: SyncLog;
  readonly justPushed = new JustPushedRing();
  readonly state: SyncState = emptySyncState();
  readonly backoff = new Backoff(0, 300_000, 5_000, true);
  readonly fileRetry: Map<string, FileRetryEntry> = new Map();

  /** Tracks the highest server `uid` we've consumed (spec 05a §3.9). */
  version = 0;

  private running = false;
  private queued = false;

  constructor(opts: SyncPluginOptions) {
    this.io = opts.io;
    this.transport = opts.transport;
    this.settings = opts.settings;
    this.log = new SyncLog(opts.settings.isDesktop ? DESKTOP_LOG_MAX : MOBILE_LOG_MAX);
  }

  /** Drain a single `_sync` round; returns true if more work pending. */
  async runOnce(now: number = Date.now()): Promise<boolean> {
    try {
      const more = await runSyncRound(
        {
          io: this.io,
          transport: this.transport,
          justPushed: this.justPushed,
          settings: this.settings,
          log: this.log,
          state: this.state,
        },
        now,
      );
      this.backoff.success(now);
      return more;
    } catch (err) {
      this.backoff.fail(now);
      this.log.log('error', `_sync: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Outer loop with 50ms request-coalescing (spec 05a §3.5). Multiple
   * concurrent `requestSync()` callers collapse into one drain loop.
   */
  async requestSync(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      // Coalesce: let any synchronous-arriving callers join this run.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      let more = true;
      while (more) {
        try {
          more = await this.runOnce();
        } catch {
          more = false;
        }
      }
      if (this.queued) {
        this.queued = false;
        // Drain the deferred request; recursion is bounded by `running`.
        // Use setImmediate so the call stack doesn't grow.
        setTimeout(() => void this.requestSync(), 0);
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Spec 05b §3.6 — server signalled the end of its initial-replay
   * stream. Until we see this frame, Phase 3 (`pushOrphans`) refuses
   * to push deletes, because the server may still be racing inbound
   * baseline frames into `state.serverFiles`. See edge-test A9.
   */
  onInitialDone(): void {
    this.state.initial = false;
    this.state.initialReplayDone = true;
    this.log.log('info', 'initial replay completed (server initial-done)');
  }

  /**
   * Approve the currently-pending mass-delete snapshot (A8 guard).
   *
   * Returns `true` if there was a pending snapshot to acknowledge AND
   * the caller's `expectedFiredAt` (when supplied) still matches.
   *
   * The `expectedFiredAt` parameter is the `firedAt` timestamp the UI
   * read from `state.pendingMassDelete` at the moment it rendered the
   * confirmation dialog. Pass it back here so a background tick that
   * REFRESHED `pendingMassDelete` with a different path set between
   * render and click can't trick the user into approving a list they
   * never saw (codex review feedback). Omit it only for tests / E2E
   * harnesses that drive both ends synchronously.
   *
   * The ack is one-shot: Phase 3 drains it path-by-path as it pushes
   * deletes (see _sync.ts `pushOrphans`). Any unrelated mass-delete
   * arriving later re-arms the guard — there is no "always allow" mode.
   */
  acknowledgePendingMassDelete(expectedFiredAt?: number): boolean {
    const snap = this.state.pendingMassDelete;
    if (!snap) return false;
    if (expectedFiredAt !== undefined && expectedFiredAt !== snap.firedAt) {
      this.log.log(
        'warn',
        `mass-delete ack rejected: stale firedAt=${expectedFiredAt} (current=${snap.firedAt})`,
      );
      return false;
    }
    this.state.pendingMassDeleteAck = {
      approvedPaths: new Set(snap.pendingPaths),
      firedAt: snap.firedAt,
    };
    this.log.log(
      'warn',
      `mass-delete acknowledged (${snap.pendingPaths.length} paths) — next Phase 3 will propagate`,
    );
    return true;
  }

  /** Spec 05a §3.9 — server pushed a frame. Enqueue + maybe self-echo. */
  onServerPush(frame: ServerFileState): void {
    if (frame.uid > this.version) this.version = frame.uid;
    if (
      this.justPushed.match({
        path: frame.path,
        folder: frame.folder,
        deleted: frame.deleted,
        mtime: frame.mtime,
        hash: frame.hash,
      })
    ) {
      // It's the echo of our own push — just advance the baseline.
      this.state.serverFiles.set(frame.path, { ...frame });
      // Remove any stale queued frame for this path.
      for (let i = 0; i < this.state.newServerFiles.length; i++) {
        if (this.state.newServerFiles[i]!.path === frame.path) {
          this.state.newServerFiles.splice(i, 1);
          i--;
        }
      }
      return;
    }
    enqueueServerPush(this.state, { ...frame });
  }

  /** Record a per-file failure for spec 05a §3.5 backoff. */
  failedSync(path: string, error: string, now: number = Date.now()): void {
    const prev = this.fileRetry.get(path);
    const count = (prev?.count ?? 0) + 1;
    this.fileRetry.set(path, { count, error, ts: now });
    this.log.log(
      'error',
      `failedSync(${path}): count=${count} delay=${failedSyncDelay(count)}ms`,
    );
  }
}
