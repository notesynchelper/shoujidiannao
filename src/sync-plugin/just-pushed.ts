/**
 * JustPushed — short ring buffer that records every push we just sent
 * so the inbound `onServerPush` echo can be discarded as our own.
 *
 * The five fingerprint fields per spec doc/04 §3.7 are:
 *   path, folder, deleted, mtime, hash
 *
 * Comparison is byte-exact. The ring holds 20 entries; older entries
 * are silently overwritten. Each `match()` call CONSUMES the entry
 * (returns true once) so an unrelated subsequent push to the same path
 * won't be incorrectly suppressed.
 */

export interface JustPushedEntry {
  path: string;
  folder: boolean;
  deleted: boolean;
  mtime: number;
  hash: string;
}

const RING_CAPACITY = 20;

export class JustPushedRing {
  private buf: JustPushedEntry[] = [];

  push(e: JustPushedEntry): void {
    this.buf.push(e);
    if (this.buf.length > RING_CAPACITY) {
      this.buf.shift();
    }
  }

  /**
   * Return true and remove the entry if every field of an inbound
   * server-push frame matches a queued entry. False on miss.
   */
  match(frame: Pick<JustPushedEntry, 'path' | 'folder' | 'deleted' | 'mtime' | 'hash'>): boolean {
    for (let i = 0; i < this.buf.length; i++) {
      const e = this.buf[i]!;
      if (
        e.path === frame.path &&
        e.folder === frame.folder &&
        e.deleted === frame.deleted &&
        e.mtime === frame.mtime &&
        e.hash === frame.hash
      ) {
        this.buf.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  /** Path+mtime+hash probe; used by Phase D to dodge re-uploads of a
   *  file we already pushed within this loop iteration.
   *
   *  mtime is included for symmetry with `match()` but is unreliable on
   *  mobile SAF (see ObsidianVaultIO Bug#1 fix); hash is the strong
   *  fingerprint that catches "same path, same content already pushed".
   */
  matchPath(path: string, mtime: number, hash: string): boolean {
    for (let i = 0; i < this.buf.length; i++) {
      const e = this.buf[i]!;
      if (e.path === path && e.hash === hash) {
        if (mtime !== 0 && e.mtime !== 0 && e.mtime !== mtime) continue;
        // Note: we don't consume here — Phase D may re-evaluate this
        // file multiple times within a single _sync round.
        return true;
      }
    }
    return false;
  }

  get size(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf.length = 0;
  }
}
