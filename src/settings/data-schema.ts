/**
 * Persisted shape for `data.json` (the result of `plugin.saveData()`).
 *
 * Layout reflects spec 08 §2.1 / §3.3 plus our test-backdoor account
 * sub-object. `dataVer = 2` matches the desktop client's saveData
 * serialiser (spec 08 §3.3 `forceSaveData` notes); we bump it together
 * with the `appId` sentinel to detect "this data.json came from a
 * different Obsidian instance" (spec 08 §2.1 references the desktop
 * client's appId sentinel).
 */

import type {
  AllowSpecialFlags,
  AllowSyncSettings,
  AllowTypeFlags,
} from '../selective/allow-sync-file.js';
import type { AccountFields } from '../account.js';

/** Bumped whenever the layout below changes. */
export const DATA_VER = 2 as const;

/** Default per-file size limit — matches `PER_FILE_MAX_DEFAULT`. */
export const DEFAULT_PER_FILE_MAX = 208_666_624;

/** Default config dir (Obsidian standard). */
export const DEFAULT_CONFIG_DIR = '.obsidian';

/** Spec 06 §2.2 — `mk = ["image","audio","pdf","video"]` default ON. */
export const DEFAULT_ALLOW_TYPES: AllowTypeFlags = {
  md: true,
  image: true,
  audio: true,
  video: true,
  pdf: true,
  unsupported: false,
};

/**
 * Spec 06 §2.3 + spec 08 §2.2 — `vk` default 6 of 8 categories ON.
 *
 * Difference from spec 06 §2.3 (which uses the single `"app"` tag for
 * both `app.json` and `types.json`): we expose the same 8 categories
 * the Settings UI toggles, where `app` covers both.
 */
export const DEFAULT_ALLOW_SPECIAL_FILES: AllowSpecialFlags = {
  app: true,
  appearance: true,
  hotkey: true,
  'core-plugin': true,
  'core-plugin-data': true,
  'appearance-data': true,
  'community-plugin': false,
  'community-plugin-data': false,
};

/** Conflict resolution policy (spec 08 §2.1). */
export type ConflictAction = 'merge' | 'conflict';

/**
 * Top-level persisted blob. Field naming intentionally matches the
 * desktop client's (camelCase JS field, snake-case server field —
 * here we stay camelCase since this blob never goes over the wire).
 */
export interface PluginData {
  dataVer: number;
  /** Sentinel set on save to detect cross-app `data.json` swaps. */
  appId: string | null;

  // ---- Account (test backdoor + WeChat result) ---------------------
  account: AccountFields;

  // ---- Sync runtime knobs ------------------------------------------
  deviceName: string;
  conflictAction: ConflictAction;
  pause: boolean;
  preventSleep: boolean;

  // ---- Selective-sync settings -------------------------------------
  allowTypes: AllowTypeFlags;
  allowSpecialFiles: AllowSpecialFlags;
  excludedFolders: string[];
  perFileMax: number;
  configDir: string;

  // ---- Active vault (set once user picks one) ----------------------
  vaultId: string | null;
  vaultName: string | null;
  vaultHost: string | null;
  /** Server origin for REST. */
  apiBaseUrl: string | null;

  // ---- Client-managed vault key (ROADMAP §1.5) ---------------------
  /**
   * 32B random key, base64url-encoded. Generated once on the first
   * device (case C) or imported via /pair/* (case B). Encrypts/
   * decrypts vault content; never sent to the server. `null` means
   * "no key yet — show pair UI or generate fresh on next bootstrap".
   */
  masterKey: string | null;
  /**
   * 32-char lowercase hex (16B random). HKDF salt for keyhash + SAS
   * derivation. Generated alongside `masterKey`.
   */
  vaultSalt: string | null;

  // ---- Multi-relay failover (reserved, see HostPool) ---------------
  /**
   * Hostname template with literal `N` placeholder, expanded into the
   * pool slots 1..hostPoolSize. Example:
   *   `'relay-N.bijitongbu.site/obsync'`
   * `null` keeps the legacy single-host behaviour (apiBaseUrl /
   * vaultHost untouched). Settings UI does not surface this yet — it
   * is plumbed for the plugin's transport layer to opt in.
   */
  hostPoolTemplate: string | null;
  /** Number of slots to expand from `hostPoolTemplate` (1..N). */
  hostPoolSize: number;
}

/** Default in-memory state, used both on first launch and post-`clear()`. */
export function defaultPluginData(): PluginData {
  return {
    dataVer: DATA_VER,
    appId: null,
    account: { token: null, email: null, name: null, license: null },
    deviceName: '',
    conflictAction: 'merge',
    pause: false,
    preventSleep: false,
    allowTypes: { ...DEFAULT_ALLOW_TYPES },
    allowSpecialFiles: { ...DEFAULT_ALLOW_SPECIAL_FILES },
    excludedFolders: [],
    perFileMax: DEFAULT_PER_FILE_MAX,
    configDir: DEFAULT_CONFIG_DIR,
    vaultId: null,
    vaultName: null,
    vaultHost: null,
    apiBaseUrl: null,
    masterKey: null,
    vaultSalt: null,
    hostPoolTemplate: null,
    hostPoolSize: 1,
  };
}

function readAllowTypes(raw: unknown): AllowTypeFlags {
  const out = { ...DEFAULT_ALLOW_TYPES };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(out) as Array<keyof AllowTypeFlags>) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function readAllowSpecial(raw: unknown): AllowSpecialFlags {
  const out = { ...DEFAULT_ALLOW_SPECIAL_FILES };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(out) as Array<keyof AllowSpecialFlags>) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function readStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => typeof x === 'string' && x.length > 0) as string[];
}

function readString(raw: unknown, fallback: string): string {
  return typeof raw === 'string' ? raw : fallback;
}

function readOptionalString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function readNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function readBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function readConflictAction(raw: unknown): ConflictAction {
  return raw === 'conflict' ? 'conflict' : 'merge';
}

/**
 * Hydrate a `PluginData` from a JSON blob (`loadData()` result).
 *
 * Unknown keys are dropped; missing keys take their default. The
 * function is total — any malformed input returns sensible defaults.
 */
export function parsePluginData(raw: unknown): PluginData {
  if (!raw || typeof raw !== 'object') return defaultPluginData();
  const r = raw as Record<string, unknown>;

  const data: PluginData = defaultPluginData();
  data.dataVer = readNumber(r['dataVer'], DATA_VER);
  data.appId = readOptionalString(r['appId']);

  // Account: same shape as Account.loadFrom
  const acc = r['account'];
  if (acc && typeof acc === 'object') {
    const a = acc as Record<string, unknown>;
    data.account = {
      token: readOptionalString(a['token']),
      email: readOptionalString(a['email']),
      name: readOptionalString(a['name']),
      license: readOptionalString(a['license']),
    };
  }

  data.deviceName = readString(r['deviceName'], '');
  data.conflictAction = readConflictAction(r['conflictAction']);
  data.pause = readBool(r['pause'], false);
  data.preventSleep = readBool(r['preventSleep'], false);

  data.allowTypes = readAllowTypes(r['allowTypes']);
  data.allowSpecialFiles = readAllowSpecial(r['allowSpecialFiles']);
  data.excludedFolders = readStringList(r['excludedFolders']);
  data.perFileMax = readNumber(r['perFileMax'], DEFAULT_PER_FILE_MAX);
  data.configDir = readString(r['configDir'], DEFAULT_CONFIG_DIR);

  data.vaultId = readOptionalString(r['vaultId']);
  data.vaultName = readOptionalString(r['vaultName']);
  data.vaultHost = readOptionalString(r['vaultHost']);
  data.apiBaseUrl = readOptionalString(r['apiBaseUrl']);
  data.masterKey = readOptionalString(r['masterKey']);
  data.vaultSalt = readOptionalString(r['vaultSalt']);

  data.hostPoolTemplate = readOptionalString(r['hostPoolTemplate']);
  // Clamp pool size into [1, 64] so a corrupted data.json can't make
  // the failover loop spin pathologically long.
  const rawSize = readNumber(r['hostPoolSize'], 1);
  data.hostPoolSize = Math.min(64, Math.max(1, Math.floor(rawSize)));

  return data;
}

/** Project the selective-sync fields onto the ladder's settings shape. */
export function asAllowSyncSettings(data: PluginData): AllowSyncSettings {
  return {
    excludedFolders: data.excludedFolders,
    allowTypes: data.allowTypes,
    allowSpecialFiles: data.allowSpecialFiles,
    perFileMax: data.perFileMax,
    configDir: data.configDir,
  };
}
