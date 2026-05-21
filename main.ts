/**
 * Obsidian plugin entrypoint.
 *
 * This module is bundled by esbuild into `dist/main.js`. It is the
 * **only** place we extend Obsidian's `Plugin` / `PluginSettingTab` /
 * `Modal` base classes — everything else stays framework-agnostic so
 * jest can drive it under jsdom.
 *
 * Responsibilities:
 *   - load / save plugin data (delegates parsing to `parsePluginData`)
 *   - own the live `Account` + `ApiClient` instances
 *   - mount the settings tab + Connecting / Create-vault modals
 *   - wire `ObsidianVaultIO` + transport into a `SyncPlugin` instance
 *     and start the 4-phase sync loop (`requestSync()` interval +
 *     vault file-event listeners) once a token + vault are present
 *
 * P6.5: the previous shell only mounted the settings tab; the actual
 * SyncPlugin loop wasn't bootstrapped on onload. We now run the full
 * stack (Account → ApiClient → SyncServer → SyncPlugin) so that
 * conflict + selective-sync E2E cases can drive an end-to-end round.
 */

import { App, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting as SettingClass, requestUrl } from 'obsidian';
import { Account } from './src/account.js';
import { ApiClient } from './src/api-client.js';
import {
  DEFAULT_CONFIG_DIR,
  asAllowSyncSettings,
  defaultPluginData,
  parsePluginData,
  type PluginData,
} from './src/settings/data-schema.js';
import { renderSettingsTab, type SettingsHost, type SyncInfoSnapshot } from './src/settings/settings-tab.js';
import { autoBootstrapVault, type AutoBootstrapResult } from './src/settings/auto-bootstrap.js';
import { PairDevice1 } from './src/pair/pair-device1.js';
import { PairDevice2 } from './src/pair/pair-device2.js';
import type { D1State, D2State } from './src/pair/state-types.js';
import {
  generateClientVaultKey,
  computeKeyHashV3,
} from '@obsync/crypto';
import { ObsidianVaultIO } from './src/adapters/obsidian-vault-io.js';
import { BrowserWsAdapter } from './src/adapters/browser-ws.js';
import {
  SyncPlugin,
  emptySyncState,
  type FileMeta,
  type PushPullTransport,
  type ScanSnapshot,
  type ServerFileState,
  type SyncPluginSettings,
  type VaultIO,
} from './src/sync-plugin/index.js';
import { SyncServer } from './src/sync-server.js';
import { allowSyncFile } from './src/selective/allow-sync-file.js';
import { isDevBuild } from './src/plugin-build-flags.js';
import type { PushControlFrame, VaultMeta } from '@obsync/proto';

// Public production REST endpoint (CF Worker → relay-2/obsync). Tests and
// the real-obsidian harness override this by passing `apiBaseUrl` explicitly
// in `data.json` (see tests/real-obsidian/lib/vault-builder.js).
const DEFAULT_API_BASE = 'https://obsidian.notebooksyncer.com';

/**
 * Derive a `ws://` / `wss://` URL from the `apiBaseUrl` we use for
 * REST. The E2E test server hands out an `http://127.0.0.1:<port>`
 * REST base; the matching WS endpoint is the same host with the http
 * scheme swapped for ws. Production callers hand us an https://
 * base + we go wss://.
 */
function deriveWsUrl(apiBase: string): string {
  if (apiBase.startsWith('https://')) return 'wss://' + apiBase.slice('https://'.length);
  if (apiBase.startsWith('http://')) return 'ws://' + apiBase.slice('http://'.length);
  // Pre-built ws:// / wss:// — pass through.
  return apiBase;
}

// -----------------------------------------------------------------------
// base64url <-> Uint8Array. masterKey is persisted to data.json as
// base64url so it round-trips through JSON without quoting.
// -----------------------------------------------------------------------

function b64uEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A `VaultIO` that filters out files the selective-sync ladder rejects.
 * The full ladder is the source of truth for "should this leave the
 * device"; we honour it at `list()` time so Phase 4 of `_sync` never
 * even sees the rejected entries. Reads/writes still pass through —
 * `_sync` only calls those for paths it learned from `list()`, so
 * filtering at the list boundary is sufficient.
 */
class SelectiveVaultIO implements VaultIO {
  constructor(
    private readonly inner: VaultIO,
    private readonly getData: () => PluginData,
  ) {}

  async list(): Promise<FileMeta[]> {
    return (await this.listSnapshot()).files;
  }

  /**
   * Selective-sync filter goes through the snapshot path so Phase 3
   * can distinguish "user truly removed this file" from "user toggled
   * a filter setting and the path is still on disk". The dropped paths
   * are surfaced via `filtered` (see ScanSnapshot in types.ts).
   *
   * If the inner adapter reports `rootFailed`/`partialDirs` we propagate
   * those upward unchanged.
   */
  async listSnapshot(): Promise<ScanSnapshot> {
    const settings = asAllowSyncSettings(this.getData());
    let inner: ScanSnapshot;
    if (this.inner.listSnapshot) {
      inner = await this.inner.listSnapshot();
    } else {
      // Inner only implements list(). Treat throws as root-failure.
      try {
        const files = await this.inner.list();
        inner = { files };
      } catch {
        return { files: [], rootFailed: true };
      }
    }
    if (inner.rootFailed) return inner;
    const files: FileMeta[] = [];
    const filtered: string[] = inner.filtered ? [...inner.filtered] : [];
    for (const f of inner.files) {
      if (allowSyncFile(f.path, { size: f.size, folder: f.folder }, settings)) {
        files.push(f);
      } else {
        filtered.push(f.path);
      }
    }
    const out: ScanSnapshot = { files, filtered };
    if (inner.partialDirs) out.partialDirs = [...inner.partialDirs];
    return out;
  }
  async read(p: string) { return this.inner.read(p); }
  async readText(p: string) { return this.inner.readText(p); }
  async write(p: string, d: Uint8Array, o?: { ctime?: number; mtime?: number }) {
    return this.inner.write(p, d, o);
  }
  async writeText(p: string, t: string, o?: { ctime?: number; mtime?: number }) {
    return this.inner.writeText(p, t, o);
  }
  async delete(p: string) { return this.inner.delete(p); }
  async rename(o: string, n: string) { return this.inner.rename(o, n); }
  async mkdir(p: string) { return this.inner.mkdir(p); }
  async exists(p: string) { return this.inner.exists(p); }
  async stat(p: string) { return this.inner.stat(p); }
}

/**
 * `PushPullTransport` adapter that bridges P5's expected interface to
 * the P4 `SyncServer`. Plaintext-on-the-wire is fine in P6.5 because
 * the server treats `path`/`hash` as opaque bytes and the test cases
 * run both ends from the same codebase (encryption is a TODO once we
 * leave the in-house server; spec §3.x defers to ROADMAP).
 */
class SyncServerTransport implements PushPullTransport {
  constructor(private readonly server: SyncServer) {}
  push(meta: PushControlFrame, ciphertext: Uint8Array): Promise<number> {
    return this.server.push(meta, ciphertext);
  }
  async pull(uid: number): Promise<{ size: number; pieces: number; data: Uint8Array }> {
    return this.server.pull(uid);
  }
}

export default class ObsyncPlugin extends Plugin {
  data: PluginData = defaultPluginData();
  account = new Account();
  api: ApiClient = new ApiClient({ baseUrl: DEFAULT_API_BASE });

  /** Created lazily once the user has a token + vault. */
  vaultIO: ObsidianVaultIO | null = null;
  syncPlugin: SyncPlugin | null = null;
  syncServer: SyncServer | null = null;
  syncTickHandle: number | null = null;

  /** Settings tab reference for re-rendering. */
  private settingsTab: ObsyncSettingTab | null = null;

  async onload(): Promise<void> {
    const raw = await this.loadData();
    this.data = parsePluginData(raw);
    this.account.loadFrom(this.data.account);
    this.applyApiBaseUrl();

    this.settingsTab = new ObsyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // The `obnotesync:sync` command — wired regardless of build mode so
    // the qa-bridge / settings UI can trigger a manual round. The dev-
    // build E2E variant additionally appends a log entry; the release
    // build silently calls requestSync().
    this.addCommand({
      id: 'sync',
      name: 'Trigger sync',
      callback: () => {
        if (OBSYNC_DEV_BUILD && isDevBuild()) {
          this.writeE2ELog('sync-triggered');
        }
        if (this.syncPlugin) {
          void this.syncPlugin.requestSync();
        } else {
          new Notice('Obsync: sync not yet connected');
        }
      },
    });

    // Dev-build-only commands the E2E harness drives.
    if (OBSYNC_DEV_BUILD && isDevBuild()) {
      this.addCommand({
        id: 'debug-apply-test-token',
        name: 'Apply test token from qa-trigger-token.json (E2E)',
        callback: () => {
          void this.applyTestTokenFromFile();
        },
      });
      this.addCommand({
        id: 'debug-force-resync',
        name: 'Force resync (E2E)',
        callback: () => {
          this.writeE2ELog('force-resync');
          if (this.syncPlugin) void this.syncPlugin.requestSync();
        },
      });

      // Pair-protocol E2E drivers (auto-confirm SAS — only safe in
      // E2E builds because there is no real attacker scenario).
      this.addCommand({
        id: 'debug-pair-start-as-d1',
        name: 'Start /pair/* as Device 1 (E2E)',
        callback: () => {
          void this.debugPairStartAsD1();
        },
      });
      this.addCommand({
        id: 'debug-pair-submit-as-d2',
        name: 'Submit pair code as Device 2 (E2E)',
        callback: () => {
          void this.debugPairSubmitAsD2();
        },
      });

      // Programmatically open the settings tab on this plugin — used by
      // the screenshot harness to surface the UI without simulating
      // keystrokes / mouse clicks.
      this.addCommand({
        id: 'debug-open-settings-tab',
        name: 'Open Obsync settings tab (E2E)',
        callback: () => {
          const app = this.app as unknown as {
            setting?: {
              open?: () => void;
              openTabById?: (id: string) => void;
            };
          };
          try {
            app.setting?.open?.();
            app.setting?.openTabById?.(this.manifest.id);
            this.writeE2ELog('debug-open-settings-tab', { ok: true });
          } catch (e) {
            this.writeE2ELog('debug-open-settings-tab', {
              ok: false,
              err: e instanceof Error ? e.message : String(e),
            });
          }
        },
      });

      // Drop a tiny onload sentinel so the launcher can prove the
      // plugin started even when the bridge isn't waiting on a
      // specific command.
      this.writeE2ELog('onload', {
        apiBaseUrl: this.data.apiBaseUrl,
        vaultId: this.data.vaultId,
        hasToken: Boolean(this.data.account.token),
      });
    }

    // If a token landed on a previous session but vault bootstrap never
    // completed (e.g. plugin crashed mid-flow), retry it before the
    // sync stack starts.
    if (this.account.token && !this.data.vaultId) {
      await this.autoBootstrapIfNeeded();
    }

    // Boot the sync stack if we have everything we need. The settings
    // tab can also call `startSyncIfReady()` after the user finishes a
    // /vault/access flow.
    await this.startSyncIfReady();
  }

  /**
   * "登录后把当前 Obsidian vault 关联到一个 server vault" — runs after the
   * token is first set (or on reload if the previous run didn't get
   * past it). Three cases per ROADMAP §6.4:
   *   A — existing server vault + local masterKey present → resume sync
   *   B — existing server vault + no local masterKey → need /pair/* import
   *   C — no existing server vault → generate masterKey + POST /vault/create
   *
   * Errors are logged to the E2E log and swallowed so a transient outage
   * doesn't leave the plugin unrecoverable — onload / settings re-render
   * retries.
   *
   * Returns the resolved AutoBootstrapResult so callers (settings tab)
   * can route case B into the pair UI flow.
   */
  async autoBootstrapIfNeeded(): Promise<AutoBootstrapResult | null> {
    if (!this.account.token) return null;
    const localName = this.app?.vault?.getName?.();
    if (!localName) return null;
    try {
      const r = await autoBootstrapVault({
        api: this.api,
        token: this.account.token,
        localVaultName: localName,
        hasLocalMasterKey: async (vaultId: string) =>
          this.data.vaultId === vaultId && Boolean(this.data.masterKey),
        createFreshVault: async ({ api, token, name, region }) => {
          // Generate vault key locally; server stores keyhash+salt verbatim
          // and never sees the masterKey itself (ROADMAP §1.5).
          const { masterKey, saltHex } = generateClientVaultKey();
          const keyhash = await computeKeyHashV3(masterKey, saltHex);
          const meta = await api.vaultCreateClientKey(
            token,
            name,
            region,
            keyhash,
            saltHex,
          );
          // Persist masterKey BEFORE returning so a crash between
          // /vault/create and saveData doesn't orphan the vault.
          this.data = {
            ...this.data,
            masterKey: b64uEncode(masterKey),
            vaultSalt: saltHex,
          } as PluginData;
          await this.saveData(this.data);
          return meta;
        },
      });
      this.data = {
        ...this.data,
        vaultId: r.vault.id,
        vaultName: r.vault.name,
        vaultHost: r.vault.host ?? this.data.vaultHost,
      } as PluginData;
      await this.saveData(this.data);
      this.writeE2ELog('auto-bootstrap', {
        vaultId: r.vault.id,
        vaultName: r.vault.name,
        case: r.case,
        reason: r.reason,
      });
      return r;
    } catch (e) {
      this.writeE2ELog('auto-bootstrap-error', {
        err: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  onunload(): void {
    this.teardownSync();
  }

  /**
   * Stand up `Account → SyncServer → SyncPlugin` if (token, vaultId,
   * apiBaseUrl) are all present in `data.json`. Idempotent: a second
   * call after a successful boot is a no-op.
   */
  async startSyncIfReady(): Promise<void> {
    if (this.syncPlugin) return; // already running
    if (!this.account.token) return;
    if (!this.data.vaultId) return;
    if (!this.data.apiBaseUrl) return;
    if (!this.app?.vault?.adapter) return;
    // Client-managed key mode: without masterKey we cannot prove
    // possession of the vault. Settings tab routes case B through
    // the /pair/* flow which then re-invokes this method.
    if (!this.data.masterKey || !this.data.vaultSalt) {
      this.writeE2ELog('sync-boot-pending-pair', {
        vaultId: this.data.vaultId,
        reason: 'no local masterKey — pair from another device',
      });
      return;
    }

    let vault: VaultMeta | null = null;
    try {
      const list = await this.api.vaultList(this.account.token);
      vault =
        list.vaults.find((v) => v.id === this.data.vaultId) ??
        list.shared.find((v) => v.id === this.data.vaultId) ??
        null;
    } catch (e) {
      this.writeE2ELog('sync-boot-error', {
        stage: 'vault-list',
        err: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (!vault) {
      this.writeE2ELog('sync-boot-error', { stage: 'vault-list', err: 'vault not found' });
      return;
    }

    // Compute keyhash from local masterKey for /vault/access + WS init.
    let computedKeyhash: string;
    try {
      const mk = b64uDecode(this.data.masterKey);
      computedKeyhash = await computeKeyHashV3(mk, this.data.vaultSalt);
    } catch (e) {
      this.writeE2ELog('sync-boot-error', {
        stage: 'keyhash-compute',
        err: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    // /vault/access proves keyhash possession; server never returns password
    // in client-managed mode (ROADMAP §1.5 / doc/01 §S16 override).
    try {
      await this.api.vaultAccess(this.account.token, vault.id, computedKeyhash);
    } catch (e) {
      this.writeE2ELog('sync-boot-error', {
        stage: 'vault-access',
        err: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    const rawIO = new ObsidianVaultIO(this.app.vault.adapter);
    this.vaultIO = rawIO;
    const filteredIO = new SelectiveVaultIO(rawIO, () => this.data);

    const syncSettings: SyncPluginSettings = {
      conflictAction: this.data.conflictAction,
      isDesktop: Platform.isDesktop,
      deviceName:
        this.data.deviceName || (Platform.isMobile ? 'Obsidian Mobile' : 'Obsidian'),
    };

    const wsUrl = deriveWsUrl(this.data.apiBaseUrl);
    const server = new SyncServer(wsUrl, {
      onServerPush: (frame) => this.onServerPush(frame),
      onInitialDone: () => {
        if (this.syncPlugin) {
          this.syncPlugin.onInitialDone();
          // Phase 3 is hard-gated on initialReplayDone (edge-test A9).
          // Kick a sync immediately so any local edits accumulated while
          // the gate was closed don't have to wait for the 30s tick (or
          // a vault file event) to propagate. codex review #3.
          void this.runSyncAndLog('initial-done');
        }
      },
      onClose: (info) => {
        this.writeE2ELog('ws-closed', info);
      },
      // Renderer-side: ws@8 ships a `browser.js` stub that throws on
      // construct. We hand SyncServer a W3C WebSocket adapter so the
      // EventEmitter-style code path it depends on works unchanged.
      wsFactory: (u) =>
        new BrowserWsAdapter(u) as unknown as import('ws').WebSocket,
    });
    this.syncServer = server;

    const transport = new SyncServerTransport(server);
    const plugin = new SyncPlugin({ io: filteredIO, transport, settings: syncSettings });
    this.syncPlugin = plugin;

    try {
      await server.connect({
        op: 'init',
        token: this.account.token,
        id: vault.id,
        keyhash: computedKeyhash,
        version: 0,
        initial: true,
        device: syncSettings.deviceName,
        encryption_version: (vault.encryption_version ?? 3) as 0 | 2 | 3,
      });
    } catch (e) {
      this.writeE2ELog('sync-boot-error', {
        stage: 'ws-init',
        err: e instanceof Error ? e.message : String(e),
      });
      this.syncPlugin = null;
      this.syncServer = null;
      return;
    }

    this.writeE2ELog('sync-started', {
      vaultId: vault.id,
      device: syncSettings.deviceName,
      conflictAction: syncSettings.conflictAction,
    });

    // Fire the initial round + arm a recurring tick. 30s matches the
    // desktop client's "idle re-scan" cadence; vault events deliver
    // sub-second responsiveness in between.
    //
    // Note: do NOT reset `plugin.state.initial = true` here. The flag
    // defaults to true via `emptySyncState()` and is flipped off ONLY
    // by `onInitialDone()` (server-emitted marker). A stray reset can
    // race the marker if the server sends `initial-done` before this
    // line runs — codex review #4.
    void this.runSyncAndLog('initial');
    const tick = window.setInterval(() => {
      void this.runSyncAndLog('tick');
    }, 30_000);
    this.syncTickHandle = tick;
    this.registerInterval(tick);

    // Hook vault events → requestSync(). `_isEventRef` is the marker
    // on the EventRef Obsidian hands back; we just pass them straight
    // to registerEvent so they auto-unsubscribe on plugin unload.
    //
    // Filter out events for the plugin's own bookkeeping files —
    // `obnotesync-log.json` is appended to from inside the sync loop
    // itself, so listening unconditionally creates a feedback storm.
    const v = this.app.vault;
    const shouldIgnore = (file: unknown): boolean => {
      const p = (file as { path?: string } | null)?.path;
      if (typeof p !== 'string') return false;
      return p === 'obnotesync-log.json' ||
        p === 'qa-trigger.json' ||
        p === 'qa-result.json' ||
        p === 'qa-bridge-ready.json' ||
        p === 'qa-trigger-token.json';
    };
    this.registerEvent(v.on('modify', (f) => {
      if (shouldIgnore(f)) return;
      this.scheduleSync('modify');
    }));
    this.registerEvent(v.on('create', (f) => {
      if (shouldIgnore(f)) return;
      this.scheduleSync('create');
    }));
    this.registerEvent(v.on('delete', (f) => {
      if (shouldIgnore(f)) return;
      this.scheduleSync('delete');
    }));
    this.registerEvent(v.on('rename', (f) => {
      if (shouldIgnore(f)) return;
      this.scheduleSync('rename');
    }));
  }

  /** Index into syncPlugin.log entries we've already mirrored to E2E log. */
  private lastLogIdx = 0;

  private flushPluginLog(): void {
    if (!(OBSYNC_DEV_BUILD && isDevBuild())) return;
    if (!this.syncPlugin) return;
    const entries = this.syncPlugin.log.all;
    while (this.lastLogIdx < entries.length) {
      const e = entries[this.lastLogIdx];
      this.lastLogIdx++;
      if (!e) continue;
      this.writeE2ELog('plugin-log', { level: e.level, msg: e.msg });
    }
  }

  private async runSyncAndLog(trigger: string): Promise<void> {
    if (!this.syncPlugin) return;
    const plugin = this.syncPlugin;
    const wasRunning = (plugin as unknown as { running?: boolean }).running === true;
    try {
      await plugin.requestSync();
      this.flushPluginLog();
      if (OBSYNC_DEV_BUILD && isDevBuild()) {
        // Only emit sync-idle when our requestSync() actually drained
        // a round (i.e. it didn't coalesce into an in-flight call).
        // Coalesced calls return immediately and would otherwise spam
        // `sync-idle` ahead of the real drain finishing.
        if (!wasRunning) {
          const lf = plugin.state.localFiles.size;
          const sf = plugin.state.serverFiles.size;
          const q = plugin.state.newServerFiles.length;
          this.writeE2ELog('sync-idle', { trigger, lf, sf, q });
        }
      }
    } catch (e) {
      this.flushPluginLog();
      this.writeE2ELog('sync-error', {
        trigger,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private scheduleSync(trigger: string): void {
    if (!this.syncPlugin) return;
    // requestSync coalesces concurrent callers (50ms merge window); no
    // additional debounce needed here. Still write the trigger to the
    // log so the E2E case can confirm event wiring.
    if (OBSYNC_DEV_BUILD && isDevBuild()) {
      this.writeE2ELog('sync-trigger', { trigger });
    }
    void this.runSyncAndLog(trigger);
  }

  private onServerPush(frameRaw: unknown): void {
    if (!this.syncPlugin) return;
    const frame = frameRaw as ServerFileState & { user?: number; device?: string };
    if (!frame || typeof frame !== 'object') return;
    this.syncPlugin.onServerPush({
      path: frame.path,
      size: frame.size,
      hash: frame.hash,
      ctime: frame.ctime,
      mtime: frame.mtime,
      folder: frame.folder,
      deleted: frame.deleted,
      uid: frame.uid,
      device: frame.device ?? '',
      user: frame.user ?? 0,
    });
    if (OBSYNC_DEV_BUILD && isDevBuild()) {
      this.writeE2ELog('server-push', { path: frame.path, uid: frame.uid });
    }
    void this.runSyncAndLog('server-push');
  }

  private teardownSync(): void {
    if (this.syncTickHandle !== null) {
      try { window.clearInterval(this.syncTickHandle); } catch { /* noop */ }
      this.syncTickHandle = null;
    }
    if (this.syncServer) {
      try { this.syncServer.disconnect(); } catch { /* noop */ }
      this.syncServer = null;
    }
    this.syncPlugin = null;
  }

  async patchData(patch: Partial<PluginData>): Promise<void> {
    this.data = { ...this.data, ...patch } as PluginData;
    // Account sub-object kept in lockstep.
    if (patch.account) {
      this.account.loadFrom(patch.account);
    }
    if (patch.apiBaseUrl !== undefined) {
      this.applyApiBaseUrl();
    }
    await this.saveData(this.data);
    // A newly-arrived token (post 6-digit-code login) needs vault
    // bootstrap before the sync stack can come up. autoBootstrapIfNeeded
    // is a no-op when vaultId is already set.
    if (patch.account?.token !== undefined && this.account.token && !this.data.vaultId) {
      await this.autoBootstrapIfNeeded();
    }
    // If a token/vault landed via the settings UI, try to bring the
    // loop up. startSyncIfReady() is idempotent.
    if (
      patch.account?.token !== undefined ||
      patch.vaultId !== undefined ||
      patch.apiBaseUrl !== undefined
    ) {
      await this.startSyncIfReady();
    }
  }

  private applyApiBaseUrl(): void {
    const base = this.data.apiBaseUrl ?? DEFAULT_API_BASE;
    // Use Obsidian's `requestUrl` instead of the renderer's `fetch` —
    // the latter is CORS-gated and an Obsidian renderer hitting our
    // E2E server at `http://127.0.0.1:<port>` will hard-fail the
    // preflight. `requestUrl` runs in the main process so it bypasses
    // CORS entirely. The shim presents a fetch-compatible response
    // object since the ApiClient only consumes `.json()`.
    const reqUrlFetch: typeof fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const r = await requestUrl({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? (init.body as string) : undefined,
        throw: false,
        contentType: 'application/json',
      });
      const parsedJson = r.json;
      return {
        ok: r.status >= 200 && r.status < 400,
        status: r.status,
        async json() { return parsedJson; },
        async text() { return r.text; },
        async arrayBuffer() { return r.arrayBuffer; },
      } as Response;
    }) as typeof fetch;
    this.api = new ApiClient({ baseUrl: base, fetchImpl: reqUrlFetch });
  }

  // ----- SettingsHost glue (read by the settings tab) ---------------

  buildSettingsHost(containerEl: HTMLElement): SettingsHost {
    return {
      containerEl,
      getData: () => this.data,
      setData: (patch) => this.patchData(patch),
      api: this.api,
      account: this.account,
      getSyncInfo: () => this.getSyncInfo(),
      onPauseClicked: () => {
        new Notice('同步已暂停');
      },
      onResumeClicked: () => {
        new Notice('同步已恢复');
        if (this.syncPlugin) void this.syncPlugin.requestSync();
      },
      manageExcludedFolders: (current) => this.openExcludedFoldersModal(current),
      onSignOut: async () => {
        this.teardownSync();
        this.account.update({ token: null, email: null, name: null, license: null });
        await this.patchData({
          account: { token: null, email: null, name: null, license: null },
          vaultId: null,
          vaultName: null,
          vaultHost: null,
          masterKey: null,
          vaultSalt: null,
        });
        new Notice('已退出登录');
      },
      loadMasterKey: async () => {
        if (!this.data.masterKey) throw new Error('本机暂无密钥，无法发起配对');
        return b64uDecode(this.data.masterKey);
      },
      onPaired: async (masterKey, vault) => {
        this.data = {
          ...this.data,
          masterKey: b64uEncode(masterKey),
          vaultSalt: vault.salt,
          vaultId: vault.id,
          vaultName: vault.name,
          vaultHost: vault.host ?? this.data.vaultHost,
        } as PluginData;
        await this.saveData(this.data);
        await this.startSyncIfReady();
        new Notice('已成功导入密钥');
      },
    };
  }

  private getSyncInfo(): SyncInfoSnapshot {
    return {
      deviceName: this.data.deviceName,
      connected: Boolean(this.syncServer && this.syncServer.state === 'ready'),
      vaultId: this.data.vaultId,
      vaultName: this.data.vaultName,
      encryptionVersion: this.data.vaultId ? 3 : null,
      lastSyncMs: null,
      filesSynced: this.syncPlugin?.state.localFiles.size ?? 0,
      conflictsInLastRun: 0,
    };
  }

  private async openExcludedFoldersModal(current: string[]): Promise<string[]> {
    return new Promise<string[]>((resolve) => {
      const modal = new ExcludedFoldersModal(this.app, current, (next) => {
        resolve(next);
      });
      modal.open();
    });
  }

  /** Surface for tests / future REST endpoints. */
  getConfigDir(): string {
    return this.app.vault.configDir || DEFAULT_CONFIG_DIR;
  }

  // ----- P7 E2E helpers ---------------------------------------------

  /** Append a line to `obnotesync-log.json` at the vault root. */
  private writeE2ELog(event: string, extra: Record<string, unknown> = {}): void {
    const adapter = this.app.vault.adapter as unknown as {
      append?: (p: string, d: string) => Promise<void>;
      write?: (p: string, d: string) => Promise<void>;
    };
    const line = JSON.stringify({ event, ts: Date.now(), ...extra }) + '\n';
    const path = 'obnotesync-log.json';
    const done = adapter.append
      ? adapter.append(path, line)
      : adapter.write?.(path, line);
    void Promise.resolve(done).catch(() => {
      // best-effort — never block plugin lifecycle on log writes.
    });
  }

  private async applyTestTokenFromFile(): Promise<void> {
    const adapter = this.app.vault.adapter as unknown as {
      read?: (p: string) => Promise<string>;
    };
    try {
      const raw = await adapter.read?.('qa-trigger-token.json');
      if (!raw) {
        this.writeE2ELog('apply-test-token', { ok: false, reason: 'no-file' });
        return;
      }
      const parsed = JSON.parse(raw) as { token?: string };
      if (typeof parsed.token === 'string' && parsed.token.length > 0) {
        await this.patchData({
          account: {
            token: parsed.token,
            email: this.data.account.email,
            name: this.data.account.name,
            license: this.data.account.license,
          },
        });
        this.writeE2ELog('apply-test-token', { ok: true });
      } else {
        this.writeE2ELog('apply-test-token', { ok: false, reason: 'no-token-field' });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.writeE2ELog('apply-test-token', { ok: false, reason: msg });
    }
  }

  // ------------------------------------------------------------------
  // Pair-protocol E2E drivers. These are gated behind dev-build commands
  // (debug-pair-start-as-d1 / debug-pair-submit-as-d2). They drive the
  // PairDevice1 / PairDevice2 state machines with auto-confirm-SAS so
  // the harness doesn't need to simulate user clicks. NOT safe in
  // production — production users must confirm SAS manually.
  //
  // Coordination via vault files:
  //   qa-pair-code.json  written by D1 once pair_code is allocated;
  //                      read by the harness, then copied to D2's vault
  //   qa-pair-result.json written when D1 reaches `sealed` and again when
  //                      D2 reaches `ready`; used by the harness for
  //                      synchronization.
  // ------------------------------------------------------------------

  private async debugPairStartAsD1(): Promise<void> {
    if (!this.account.token || !this.data.vaultId) {
      this.writeE2ELog('debug-pair-d1', { ok: false, reason: 'no-token-or-vault' });
      return;
    }
    if (!this.data.masterKey) {
      this.writeE2ELog('debug-pair-d1', { ok: false, reason: 'no-local-masterKey' });
      return;
    }
    const masterKey = b64uDecode(this.data.masterKey);
    const dev1 = new PairDevice1({
      api: this.api,
      token: this.account.token,
      vault_id: this.data.vaultId,
      masterKey,
      pollIntervalMs: 500,
      onState: (s: D1State) => {
        const extra: Record<string, unknown> = { phase: s.phase };
        if (s.phase === 'error') extra.message = s.message;
        if (s.phase === 'expired') extra.message = 'expired';
        this.writeE2ELog('debug-pair-d1-state', extra);
        if (s.phase === 'code_displayed') {
          // Surface the pair_code to the harness via a vault file.
          const adapter = this.app.vault.adapter as unknown as {
            write?: (p: string, d: string) => Promise<void>;
          };
          const payload = JSON.stringify({
            pair_code: s.pair_code,
            expires_at: s.expires_at,
          }, null, 2);
          void adapter.write?.('qa-pair-code.json', payload);
        }
        if (s.phase === 'sas_pending') {
          // E2E: auto-confirm. Real users would compare digits + emoji.
          void dev1.confirmSas();
        }
        if (s.phase === 'sealed') {
          const adapter = this.app.vault.adapter as unknown as {
            write?: (p: string, d: string) => Promise<void>;
          };
          void adapter.write?.(
            'qa-pair-result.json',
            JSON.stringify({ side: 'd1', status: 'sealed' }, null, 2),
          );
        }
      },
    });
    try {
      await dev1.start();
    } catch (e) {
      this.writeE2ELog('debug-pair-d1', {
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async debugPairSubmitAsD2(): Promise<void> {
    if (!this.account.token) {
      this.writeE2ELog('debug-pair-d2', { ok: false, reason: 'no-token' });
      return;
    }
    const adapter = this.app.vault.adapter as unknown as {
      read?: (p: string) => Promise<string>;
      write?: (p: string, d: string) => Promise<void>;
    };
    let pairCode: string;
    try {
      const raw = await adapter.read?.('qa-pair-code.json');
      if (!raw) {
        this.writeE2ELog('debug-pair-d2', { ok: false, reason: 'no-pair-code-file' });
        return;
      }
      const parsed = JSON.parse(raw) as { pair_code?: string };
      if (typeof parsed.pair_code !== 'string') {
        this.writeE2ELog('debug-pair-d2', { ok: false, reason: 'malformed-pair-code-file' });
        return;
      }
      pairCode = parsed.pair_code;
    } catch (e) {
      this.writeE2ELog('debug-pair-d2', {
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    const dev2 = new PairDevice2({
      api: this.api,
      token: this.account.token,
      pollIntervalMs: 500,
      onState: (s: D2State) => {
        const extra: Record<string, unknown> = { phase: s.phase };
        if (s.phase === 'error') extra.message = s.message;
        this.writeE2ELog('debug-pair-d2-state', extra);
        if (s.phase === 'sas_pending') {
          void dev2.confirmSas();
        }
        if (s.phase === 'ready') {
          void (async () => {
            // Persist masterKey + vault meta and kick the sync stack.
            this.data = {
              ...this.data,
              masterKey: b64uEncode(s.masterKey),
              vaultSalt: s.vault.salt,
              vaultId: s.vault.id,
              vaultName: s.vault.name,
              vaultHost: s.vault.host ?? this.data.vaultHost,
            } as PluginData;
            await this.saveData(this.data);
            await adapter.write?.(
              'qa-pair-result.json',
              JSON.stringify({ side: 'd2', status: 'ready', vaultId: s.vault.id }, null, 2),
            );
            // Kick the sync stack now that masterKey is present.
            await this.startSyncIfReady();
          })();
        }
        if (s.phase === 'error') {
          void adapter.write?.(
            'qa-pair-result.json',
            JSON.stringify({ side: 'd2', status: 'error', message: s.message }, null, 2),
          );
        }
      },
    });
    try {
      await dev2.submitCode(pairCode);
    } catch (e) {
      this.writeE2ELog('debug-pair-d2', {
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

class ObsyncSettingTab extends PluginSettingTab {
  private dispose: (() => void) | null = null;
  private readonly hostPlugin: ObsyncPlugin;
  constructor(app: App, plugin: ObsyncPlugin) {
    super(app, plugin);
    this.hostPlugin = plugin;
  }

  display(): void {
    this.dispose?.();
    const host = this.hostPlugin.buildSettingsHost(this.containerEl);
    const handle = renderSettingsTab(host);
    this.dispose = handle.dispose;
  }

  hide(): void {
    this.dispose?.();
    this.dispose = null;
  }
}

class ExcludedFoldersModal extends Modal {
  constructor(
    app: App,
    private current: string[],
    private onClose2: (next: string[]) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('管理排除目录');
    this.contentEl.empty();

    // Use Obsidian Setting rows for each item so spacing matches the rest of
    // the settings UI; the row-per-folder list is more comfortable to scan
    // than a bare <ul>.
    if (this.current.length === 0) {
      const empty = this.contentEl.createEl('p');
      empty.textContent = '当前没有排除任何目录。';
      empty.style.color = 'var(--text-muted)';
    } else {
      for (const f of this.current) {
        new SettingClass(this.contentEl).setName(f).addButton((b) =>
          b
            .setButtonText('移除')
            .setWarning()
            .onClick(() => {
              this.current = this.current.filter((x) => x !== f);
              this.onOpen();
            }),
        );
      }
    }

    // 添加新目录的行
    let nextValue = '';
    new SettingClass(this.contentEl)
      .setName('添加目录')
      .setDesc('整个目录及其子项都会被排除。')
      .addText((t) => {
        t.setPlaceholder('目录路径（如 Templates）').onChange((v) => {
          nextValue = v.trim();
        });
      })
      .addButton((b) =>
        b
          .setButtonText('添加')
          .onClick(() => {
            if (nextValue && !this.current.includes(nextValue)) {
              this.current = [...this.current, nextValue];
              this.onOpen();
            }
          }),
      );

    // 完成按钮
    new SettingClass(this.contentEl).addButton((b) =>
      b
        .setButtonText('完成')
        .setCta()
        .onClick(() => this.close()),
    );
  }

  onClose(): void {
    this.onClose2(this.current);
  }
}

// Use `emptySyncState` so tree-shake doesn't drop the symbol; the
// SyncPlugin imports it for its own state init, but esbuild may
// pessimise the side-effect import. Keep this no-op reference.
void emptySyncState;
