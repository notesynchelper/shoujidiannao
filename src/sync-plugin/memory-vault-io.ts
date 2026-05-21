/**
 * MemoryVaultIO — in-memory `VaultIO` for jest. Mirrors the Obsidian
 * adapter's surface area (P6 will provide the real implementation).
 *
 * Folders are tracked as entries with `folder: true`. The constructor
 * always seeds the root path "" implicitly; we do NOT model permissions
 * or ENOENT-distinct errors here — the spec lets the plugin treat any
 * IO failure as a per-file skip.
 */

import { encode } from './codec.js';
import type { FileMeta, VaultIO } from './types.js';

interface MemEntry extends FileMeta {
  data: Uint8Array;
}

export class MemoryVaultIO implements VaultIO {
  private files = new Map<string, MemEntry>();

  async list(): Promise<FileMeta[]> {
    const out: FileMeta[] = [];
    for (const e of this.files.values()) {
      out.push({
        path: e.path,
        ctime: e.ctime,
        mtime: e.mtime,
        size: e.size,
        folder: e.folder,
      });
    }
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    const e = this.files.get(path);
    if (!e) throw new Error(`MemoryVaultIO.read: not found: ${path}`);
    if (e.folder) throw new Error(`MemoryVaultIO.read: is a folder: ${path}`);
    return new Uint8Array(e.data);
  }

  async readText(path: string): Promise<string> {
    const bytes = await this.read(path);
    return new TextDecoder('utf-8').decode(bytes);
  }

  async write(
    path: string,
    data: Uint8Array,
    opts?: { ctime?: number; mtime?: number },
  ): Promise<void> {
    const prev = this.files.get(path);
    const ctime = opts?.ctime ?? prev?.ctime ?? Date.now();
    const mtime = opts?.mtime ?? Date.now();
    this.files.set(path, {
      path,
      data: new Uint8Array(data),
      ctime,
      mtime,
      size: data.byteLength,
      folder: false,
    });
  }

  async writeText(
    path: string,
    text: string,
    opts?: { ctime?: number; mtime?: number },
  ): Promise<void> {
    return this.write(path, encode(text), opts);
  }

  async delete(path: string): Promise<void> {
    const e = this.files.get(path);
    if (!e) return;
    if (e.folder) {
      // Must be empty.
      for (const other of this.files.values()) {
        if (other === e) continue;
        if (other.path.startsWith(`${path}/`)) {
          throw new Error(`MemoryVaultIO.delete: folder not empty: ${path}`);
        }
      }
    }
    this.files.delete(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const e = this.files.get(oldPath);
    if (!e) throw new Error(`MemoryVaultIO.rename: not found: ${oldPath}`);
    this.files.delete(oldPath);
    this.files.set(newPath, { ...e, path: newPath });
  }

  async mkdir(path: string): Promise<void> {
    if (this.files.has(path)) return;
    this.files.set(path, {
      path,
      data: new Uint8Array(0),
      ctime: Date.now(),
      mtime: Date.now(),
      size: 0,
      folder: true,
    });
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async stat(path: string): Promise<FileMeta | null> {
    const e = this.files.get(path);
    if (!e) return null;
    return { path: e.path, ctime: e.ctime, mtime: e.mtime, size: e.size, folder: e.folder };
  }

  // ----- test helpers ---------------------------------------------------

  snapshot(): Map<string, { meta: FileMeta; data: Uint8Array }> {
    const out = new Map<string, { meta: FileMeta; data: Uint8Array }>();
    for (const e of this.files.values()) {
      out.set(e.path, {
        meta: { path: e.path, ctime: e.ctime, mtime: e.mtime, size: e.size, folder: e.folder },
        data: new Uint8Array(e.data),
      });
    }
    return out;
  }
}
