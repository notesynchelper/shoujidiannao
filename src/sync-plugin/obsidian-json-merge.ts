/**
 * `.obsidian/*.json` shallow merge + core-plugins.json patch.
 *
 * Spec 05b §3.8:
 *
 *   - Both sides parsed as JSON. Non-objects (incl. arrays) → caller
 *     falls back to `syncFileDown` (server wins). We surface this by
 *     throwing `JsonMergeUnsupported`; the conflict resolver catches
 *     and routes to accept-server.
 *
 *   - Top-level shallow merge — `remote[k]` overrides `local[k]`. Keys
 *     only in `local` survive. Nested objects are NOT deep-merged.
 *
 *   - Result is `JSON.stringify(merged, undefined, 2)` (two-space indent
 *     to match the desktop client).
 *
 *   - When the path is `.obsidian/core-plugins.json`, the merged content
 *     is patched through `patchCorePluginsFile` to force `"sync"` to be
 *     enabled regardless of remote state. Both legacy-array and modern-
 *     object schemas are supported (spec 05b §3.8.1).
 */

export class JsonMergeUnsupported extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'JsonMergeUnsupported';
  }
}

interface PlainObject {
  [key: string]: unknown;
}

function isPlainObject(x: unknown): x is PlainObject {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

export function shallowMergeJson(local: PlainObject, remote: PlainObject): PlainObject {
  // Spec: remote overrides local; local-only keys survive.
  return { ...local, ...remote };
}

export function patchCorePluginsContent(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (Array.isArray(parsed)) {
    // legacy schema: list of enabled plugin ids
    if (!parsed.includes('sync')) {
      parsed.push('sync');
      return JSON.stringify(parsed, undefined, 2);
    }
    return text;
  }
  if (isPlainObject(parsed)) {
    if (parsed.sync !== true) {
      parsed.sync = true;
      return JSON.stringify(parsed, undefined, 2);
    }
    return text;
  }
  return text;
}

/**
 * Merge two `.obsidian/*.json` payloads.
 *
 * @param filePath  Full vault-relative path; used to spot core-plugins.
 * @param localStr  Local file contents (UTF-8 string).
 * @param remoteStr Server-decrypted plaintext (UTF-8 string).
 */
export function mergeObsidianJson(
  filePath: string,
  localStr: string,
  remoteStr: string,
): string {
  let local: unknown;
  let remote: unknown;
  try {
    local = JSON.parse(localStr);
  } catch (err) {
    throw new JsonMergeUnsupported(`local json parse: ${(err as Error).message}`);
  }
  try {
    remote = JSON.parse(remoteStr);
  } catch (err) {
    throw new JsonMergeUnsupported(`remote json parse: ${(err as Error).message}`);
  }
  if (!isPlainObject(local) || !isPlainObject(remote)) {
    // Arrays / primitives → spec 05b §3.8 says fall through to
    // syncFileDown. Signal by throwing the caller will catch.
    throw new JsonMergeUnsupported(`non-object payload: ${filePath}`);
  }
  const merged = shallowMergeJson(local, remote);
  let out = JSON.stringify(merged, undefined, 2);
  if (filePath.endsWith('/core-plugins.json') || filePath === '.obsidian/core-plugins.json') {
    out = patchCorePluginsContent(out);
  }
  return out;
}
