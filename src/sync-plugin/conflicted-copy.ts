/**
 * Conflicted-copy filename grammar (spec 05b §2.4 / §3.7.5).
 *
 *   "{basename} (Conflicted copy {device} {YYYYMMDDHHmm}).{ext}"
 *
 * The desktop client uses `moment().format("YYYYMMDDHHmm")` which is
 * in the device's local timezone. We default to UTC to keep tests
 * deterministic, but accept a `tz` override the plugin will set from
 * the host platform.
 *
 * Device sanitizer mirrors the spec illegal-character rule: only the
 * first illegal character per platform is replaced, and runs of the
 * replacement character are collapsed when the replacement is a single
 * char. We default to underscore — the desktop client's default too.
 *
 * Path/extension splitter:
 *   "foo.md"          → base="foo",       ext="md"
 *   "foo.bar.canvas"  → base="foo.bar",   ext="canvas"
 *   "README"          → base="README",    ext=""
 *   ".hidden"         → base=".hidden",   ext=""  (leading dot retained)
 *   "dir/foo.md"      → base="dir/foo",   ext="md"
 */

export type Platform = 'windows' | 'mac' | 'linux' | 'android';

const ILLEGAL: Readonly<Record<Platform, string>> = Object.freeze({
  windows: '*"\\/<>:|?',
  // macOS / Linux / iOS — minimal set per spec §2.4 (\/:)
  mac: '\\/:',
  linux: '\\/:',
  // Android — adds *?<>" on top of the minimal set per spec §2.4
  android: '\\/:*?<>"',
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** spec §2.4 sanitizer — replace **first** illegal char, then collapse
 *  runs of the replacement when it's a single character. */
export function sanitizeDeviceName(
  name: string,
  replacement = '_',
  platform: Platform = 'linux',
): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return trimmed;
  const illegal = ILLEGAL[platform];
  // spec: `e.replace(qT, t)` against the ORIGINAL `e`, not the trimmed
  // string. We mimic that.
  const charClass = new RegExp(`[${escapeRegex(illegal)}]`);
  let out = name.replace(charClass, replacement);
  if (replacement.length === 1) {
    const collapse = new RegExp(`${escapeRegex(replacement)}{2,}`, 'g');
    out = out.replace(collapse, replacement);
  }
  return out;
}

/** Format a timestamp as the spec's `YYYYMMDDHHmm` string in UTC. */
export function formatTimestamp(ms: number, utc = true): string {
  const d = new Date(ms);
  const yyyy = utc ? d.getUTCFullYear() : d.getFullYear();
  const mm = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const dd = utc ? d.getUTCDate() : d.getDate();
  const hh = utc ? d.getUTCHours() : d.getHours();
  const mi = utc ? d.getUTCMinutes() : d.getMinutes();
  return (
    String(yyyy) +
    String(mm).padStart(2, '0') +
    String(dd).padStart(2, '0') +
    String(hh).padStart(2, '0') +
    String(mi).padStart(2, '0')
  );
}

interface SplitResult {
  base: string;
  ext: string;
}

/** Split path into `{base, ext}` per spec helpers `ru`/`ou`. */
export function splitBaseExt(path: string): SplitResult {
  const lastSlash = path.lastIndexOf('/');
  const fileStart = lastSlash >= 0 ? lastSlash + 1 : 0;
  const fileName = path.slice(fileStart);
  const dot = fileName.lastIndexOf('.');
  // Leading-dot files like ".hidden" have no ext.
  if (dot <= 0) {
    return { base: path, ext: '' };
  }
  return {
    base: path.slice(0, fileStart) + fileName.slice(0, dot),
    ext: fileName.slice(dot + 1),
  };
}

export interface ConflictedCopyOptions {
  device: string;
  /** Local mtime in ms. */
  mtime: number;
  /** Default UTC; the real plugin will pass local time. */
  utc?: boolean;
  /** Override the platform for illegal-char sanitization. */
  platform?: Platform;
}

/**
 * Build a conflicted-copy path. Does NOT collision-check — the caller
 * is responsible for trying alternative suffixes (` 1`, ` 2`, …) when
 * the file already exists. Spec §3.7.5 hands that off to
 * `vault.getAvailablePath`.
 */
export function makeConflictedCopyName(path: string, opts: ConflictedCopyOptions): string {
  const { base, ext } = splitBaseExt(path);
  const device = sanitizeDeviceName(opts.device, '_', opts.platform ?? 'linux');
  const ts = formatTimestamp(opts.mtime, opts.utc ?? true);
  const suffix = ` (Conflicted copy ${device} ${ts})`;
  return ext ? `${base}${suffix}.${ext}` : `${base}${suffix}`;
}
