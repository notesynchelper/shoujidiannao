/**
 * Upload throttle table (spec 05a §3.8 / 3.6, `canSyncLocalFile`).
 *
 * Per-size cooldown windows that gate Phase D re-uploads so a single
 * dirty file can't pin the queue. The plugin still tracks `synctime`
 * per LocalFileState — this helper returns the cooldown delta a caller
 * should compare against `now - synctime`.
 *
 *   size  ≤  10 KiB → 10 s
 *   size  ≤ 100 KiB → 20 s
 *   size  >  100 KiB → 30 s
 *
 * Returned milliseconds; callers compare against `Date.now() - synctime`.
 */

export function throttleUpload(sizeBytes: number): number {
  if (sizeBytes <= 10_240) return 10_000;
  if (sizeBytes <= 102_400) return 20_000;
  return 30_000;
}

/**
 * `true` iff the file has cooled down past its size-band window. If
 * `synctime === 0` the file has never been pushed — always returns true.
 */
export function canSyncLocalFile(now: number, synctime: number, size: number): boolean {
  if (!synctime) return true;
  return now - synctime >= throttleUpload(size);
}
