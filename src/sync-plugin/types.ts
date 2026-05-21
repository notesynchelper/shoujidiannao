/**
 * SyncPlugin shared types.
 *
 * The plugin layer is intentionally decoupled from Obsidian: it operates
 * on a portable `VaultIO` abstraction (an in-memory implementation lives
 * in tests; the real adapter mapping to `app.vault.adapter` is P6). All
 * file paths are forward-slash strings; bytes are `Uint8Array`.
 */

import type { PushControlFrame, ServerPushFrame } from '@obsync/proto';

/** Spec 05a §2.3 LocalFileState fingerprint (subset relevant to P5). */
export interface FileMeta {
  /** Forward-slash path relative to vault root. */
  path: string;
  /** ms epoch — file creation. Folders carry 0. */
  ctime: number;
  /** ms epoch — last modification. Folders carry 0. */
  mtime: number;
  /** Plaintext byte size. Folders carry 0. */
  size: number;
  /** True for directories. */
  folder: boolean;
}

/**
 * Result of a "scan-health-aware" recursive listing.
 *
 * Returned by `VaultIO.listSnapshot()` (optional). When the host IO
 * cannot enumerate part of the tree we MUST surface that as `rootFailed`
 * or `partialDirs` so Phase 3 (`pushOrphans`) does not mis-classify the
 * unreachable subset as "user deleted these files" and push delete to
 * the server. Selective-sync filtering goes through `filtered` for the
 * same reason — paths the filter dropped are still on disk and must
 * not be push-deleted.
 *
 * Background: the original `_sync.scan()` treated "absent from
 * snapshot" as "user deleted" unconditionally. A failing
 * `adapter.list()` returning empty, or a tightened `excludedFolders`
 * collapsing 100 files out of the listing, would therefore wipe the
 * server and broadcast deletes to every peer. See
 * `doc/edge-tests/00-候选清单-Claude侧.md` red lines A1/A2/A3-A6/A11.
 */
export interface ScanSnapshot {
  files: FileMeta[];
  /** True when root `list()` (whole vault) failed. Phase 3 MUST skip. */
  rootFailed?: boolean;
  /**
   * Directory prefixes (with trailing `/`) that scan could enumerate
   * the parent of but failed to descend into (e.g. SAF permission
   * lost on a single subdir). Phase 3 MUST skip push-delete for any
   * server-baseline path whose path starts with one of these prefixes.
   */
  partialDirs?: string[];
  /**
   * Paths the IO filter (e.g. `SelectiveVaultIO`) chose to suppress at
   * the listing boundary, even though they are still on disk. Phase 3
   * MUST NOT push-delete these (they are filtered, not deleted).
   */
  filtered?: string[];
}

/** Abstraction over Obsidian's `Vault` / `DataAdapter`. */
export interface VaultIO {
  /** List every entry in the vault (recursive). */
  list(): Promise<FileMeta[]>;
  /**
   * Optional "scan-health-aware" recursive listing. Implementations
   * that can report IO failure / selective filtering SHOULD provide
   * this; `_sync.scan()` falls back to `list()` when absent (treating
   * an absent snapshot as "healthy + nothing filtered").
   */
  listSnapshot?(): Promise<ScanSnapshot>;
  /** Read raw bytes. Throws if missing or is a folder. */
  read(path: string): Promise<Uint8Array>;
  /** Read bytes as UTF-8 text. */
  readText(path: string): Promise<string>;
  /** Write bytes (creates parents). Optional ctime/mtime stamping. */
  write(
    path: string,
    data: Uint8Array,
    opts?: { ctime?: number; mtime?: number },
  ): Promise<void>;
  /** Write a UTF-8 string. */
  writeText(
    path: string,
    text: string,
    opts?: { ctime?: number; mtime?: number },
  ): Promise<void>;
  /** Remove a file or empty folder. Folders MUST be empty. */
  delete(path: string): Promise<void>;
  /** Rename / move. The new parent dir is created if missing. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Create an (empty) folder. No-op if it already exists. */
  mkdir(path: string): Promise<void>;
  /** Existence check; folders included. */
  exists(path: string): Promise<boolean>;
  /** Metadata for one path, or null when absent. */
  stat(path: string): Promise<FileMeta | null>;
}

/**
 * Local-side per-file state mirroring spec 05a §2.3 — we only persist
 * the hash baselines that matter for the conflict resolver.
 */
export interface LocalFileState extends FileMeta {
  /** SHA-256 hex of current bytes; "" until computed. */
  hash: string;
  /** Pre-rename path (clears on push completion). */
  previouspath: string;
  /** Throttle key (Date.now() at last successful push). */
  synctime: number;
  /** Hash captured at last successful sync — conflict baseline. */
  synchash: string;
}

/** Server-side per-file fingerprint (last seen in a push frame). */
export interface ServerFileState {
  path: string;
  size: number;
  hash: string;
  ctime: number;
  mtime: number;
  folder: boolean;
  deleted: boolean;
  uid: number;
  device: string;
  user: number;
  /** Annotated locally during init replay (see spec 05a §3.9 / 05b §3.6). */
  initial?: boolean;
}

/** A push frame the server replayed back to us. */
export type ServerPush = ServerPushFrame & { initial?: boolean };

export type ConflictMode = 'merge' | 'conflict';

export interface SyncPluginSettings {
  /** "merge" (default) or "conflict" — drives Case 6 behaviour. */
  conflictAction: ConflictMode;
  /** Desktop devices keep 2000 syncLog entries; mobile keeps 500. */
  isDesktop: boolean;
  /** Device label embedded in conflicted-copy file names. */
  deviceName: string;
}

/** Interface the SyncPlugin expects from its `SyncServer` transport. */
export interface PushPullTransport {
  push(meta: PushControlFrame, ciphertext: Uint8Array): Promise<number>;
  pull(uid: number): Promise<{ size: number; pieces: number; data: Uint8Array }>;
}

/** Mergeable text extensions (spec 05b §3.7). */
export const MERGEABLE_EXTS = new Set<string>(['md', 'markdown', 'txt']);

/** Empty file constant — re-exported so plugin internals don't allocate. */
export const EMPTY_BYTES: Uint8Array = new Uint8Array(0);
