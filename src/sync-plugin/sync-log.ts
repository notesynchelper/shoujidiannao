/**
 * SyncLog — bounded ring buffer for sync activity (spec 05a §2.1).
 *
 * Desktop keeps `maxSize = 2000`, mobile `500`. On overflow we drop the
 * oldest 100 entries (spec: "超出删前 100"). The plugin does not persist
 * the log; it's a UI-only debug trail and re-initialises at boot.
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'merge';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

export const DESKTOP_LOG_MAX = 2000;
export const MOBILE_LOG_MAX = 500;

export class SyncLog {
  private entries: LogEntry[] = [];

  constructor(private readonly maxSize: number) {
    if (maxSize < 100) {
      // Defensive — drop-first-100 doesn't make sense otherwise. Tests
      // pass maxSize >= 100; we don't expect smaller in practice.
      throw new Error(`maxSize must be ≥ 100, got ${maxSize}`);
    }
  }

  /** Add an entry. Trims the oldest 100 when overflowed. */
  log(level: LogLevel, msg: string, ts: number = Date.now()): void {
    this.entries.push({ ts, level, msg });
    if (this.entries.length > this.maxSize) {
      this.entries.splice(0, 100);
    }
  }

  /** Snapshot — caller MUST treat the array as immutable. */
  get all(): readonly LogEntry[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
