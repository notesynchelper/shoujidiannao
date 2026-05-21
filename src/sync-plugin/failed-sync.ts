/**
 * failedSync retry helper — spec 05a §3.5.
 *
 * `retryDelay = min(5 * 2^count * 1000, 5*60*1000)`. Caps at 5 minutes
 * once count ≥ 6 (5 * 2^6 = 320s already > 300s). The plugin tracks
 * `fileRetry[path] = { count, error, ts }`; this module is a pure-math
 * helper without any state.
 */

export const FAILED_SYNC_MAX_DELAY_MS = 5 * 60 * 1000;

export function failedSyncDelay(count: number): number {
  return Math.min(5 * Math.pow(2, count) * 1000, FAILED_SYNC_MAX_DELAY_MS);
}

export interface FileRetryEntry {
  count: number;
  error: string;
  ts: number;
}

/**
 * Return true iff the cool-off window has elapsed since the last
 * attempt. `now - entry.ts > failedSyncDelay(entry.count)`.
 */
export function canRetry(entry: FileRetryEntry, now: number): boolean {
  return now - entry.ts > failedSyncDelay(entry.count);
}
