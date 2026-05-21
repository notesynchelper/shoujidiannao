/**
 * `ObsidianVaultIO` — wraps Obsidian's `Vault.adapter` (a.k.a.
 * `DataAdapter`) into the `VaultIO` interface used by P5's
 * SyncPlugin.
 *
 * The adapter takes / yields strings & ArrayBuffers; we convert at the
 * boundary so the sync core can stay on `Uint8Array`.
 *
 * Recursive `list()` walks the vault root with a BFS-style stack —
 * Obsidian's `DataAdapter.list(path)` only returns one level.
 */

import { Platform, type DataAdapter } from 'obsidian';
import type { FileMeta, ScanSnapshot, VaultIO } from '../sync-plugin/types.js';

/** Memoised platform check — `Platform.isMobile` is a static boolean
 *  in the Obsidian API so we read it once at module load. Test envs
 *  whose `obsidian` mock omits `Platform` default to "not mobile". */
function isMobile(): boolean {
  return Boolean((Platform as { isMobile?: boolean } | undefined)?.isMobile);
}

export class ObsidianVaultIO implements VaultIO {
  constructor(private readonly adapter: DataAdapter) {}

  async list(): Promise<FileMeta[]> {
    return (await this.listSnapshot()).files;
  }

  /**
   * Walk the vault and report per-directory health alongside the
   * listing. The original `list()` swallowed `adapter.list(dir)`
   * exceptions as `continue` — that masked SAF/permission failures so
   * Phase 3 (`pushOrphans`) treated entire missing subtrees as user
   * deletes. We now surface:
   *   - `rootFailed: true` when the root directory itself failed (we
   *     can't tell what's on disk at all).
   *   - `partialDirs: ['sub/']` when a descendant directory failed to
   *     list (the parent saw it, but we couldn't descend).
   *
   * Phase 3 reads both signals and skips push-delete for affected
   * paths. See `doc/edge-tests/00-候选清单-Claude侧.md` A1/A2.
   */
  async listSnapshot(): Promise<ScanSnapshot> {
    const out: FileMeta[] = [];
    const partialDirs: string[] = [];
    let rootEntries: { files: string[]; folders: string[] };
    try {
      rootEntries = await this.adapter.list('');
    } catch {
      return { files: [], rootFailed: true };
    }
    // Empty-but-successful root listing is treated as healthy. A real
    // empty vault has zero files — Phase 3 then has nothing to delete
    // anyway, so the mass-delete guard is the relevant safety net.
    const stack: { dir: string; entries: { files: string[]; folders: string[] } }[] = [
      { dir: '', entries: rootEntries },
    ];
    while (stack.length > 0) {
      const top = stack.pop()!;
      const entries = top.entries;
      for (const f of entries.folders) {
        const stat = await this.adapter.stat(f);
        out.push({
          path: f,
          ctime: stat?.ctime ?? 0,
          mtime: stat?.mtime ?? 0,
          size: 0,
          folder: true,
        });
        let sub: { files: string[]; folders: string[] };
        try {
          sub = await this.adapter.list(f);
        } catch {
          partialDirs.push(`${f}/`);
          continue;
        }
        stack.push({ dir: f, entries: sub });
      }
      for (const f of entries.files) {
        const stat = await this.adapter.stat(f);
        out.push({
          path: f,
          ctime: stat?.ctime ?? 0,
          mtime: stat?.mtime ?? 0,
          size: stat?.size ?? 0,
          folder: false,
        });
      }
    }
    return partialDirs.length > 0 ? { files: out, partialDirs } : { files: out };
  }

  async read(path: string): Promise<Uint8Array> {
    const buf = await this.adapter.readBinary(path);
    return new Uint8Array(buf);
  }

  async readText(path: string): Promise<string> {
    return this.adapter.read(path);
  }

  async write(
    path: string,
    data: Uint8Array,
    opts?: { ctime?: number; mtime?: number },
  ): Promise<void> {
    // Adapter takes ArrayBuffer — copy into a fresh ArrayBuffer to
    // satisfy the strict ArrayBuffer (non-SharedArrayBuffer) type and
    // ensure callers can't mutate our underlying buffer.
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    // Obsidian Mobile (Android SAF path) has a confirmed bug where
    // writeBinary(path, data, { ctime, mtime }) PERSISTS 0 BYTES while
    // honouring the timestamps. Verified by stat showing mtime=push
    // frame's mtime but size=0. Strip options on mobile so content
    // lands correctly; the resulting mtime mismatch with server is
    // resolved on the next sync round (case-3 server-wins or symmetric
    // re-push) and content stays intact.
    const safeOpts = isMobile() ? undefined : opts;
    await this.adapter.writeBinary(path, buf, safeOpts);
  }

  async writeText(
    path: string,
    text: string,
    opts?: { ctime?: number; mtime?: number },
  ): Promise<void> {
    const safeOpts = isMobile() ? undefined : opts;
    await this.adapter.write(path, text, safeOpts);
  }

  async delete(path: string): Promise<void> {
    const stat = await this.adapter.stat(path);
    if (!stat) return;
    if (stat.type === 'folder') {
      await this.adapter.rmdir(path, false);
    } else {
      await this.adapter.remove(path);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.adapter.rename(oldPath, newPath);
  }

  async mkdir(path: string): Promise<void> {
    if (await this.adapter.exists(path)) return;
    await this.adapter.mkdir(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  async stat(path: string): Promise<FileMeta | null> {
    const s = await this.adapter.stat(path);
    if (!s) return null;
    return {
      path,
      ctime: s.ctime,
      mtime: s.mtime,
      size: s.size,
      folder: s.type === 'folder',
    };
  }
}
