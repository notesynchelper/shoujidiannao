/**
 * Settings tab renderer (spec 08 §3.2).
 *
 * This file deliberately does **not** depend on the `obsidian` runtime
 * — instead, the host (the real `Plugin` subclass in `main.ts`) hands
 * the tab a generic `SettingsHost` with the few capabilities we need.
 * That makes the renderer trivially testable under jsdom.
 *
 * Layout (top-to-bottom, per spec 08 §3.2 + ROADMAP §6.2):
 *   - Device name
 *   - Resolve conflicts (merge | conflict)
 *   - 5 File types (md/image/pdf/audio/video)
 *   - 8 Special files (.obsidian)
 *   - Excluded folders (Manage…)
 *   - Pause / Resume
 *   - Sync info dump
 *
 * Spec deviations explicitly tracked:
 *   - "md" is rendered as a toggle for UI symmetry even though the
 *     spec hard-codes it ON. We disable the underlying flag from
 *     having effect (markup ext list); the toggle is read-only true.
 *   - We don't render the "View deleted files", "Sync log", "Vault
 *     size", "Contact support" sections (ROADMAP §6.2 only required
 *     the items listed above).
 */

import type { AllowSpecialFlags, AllowTypeFlags } from '../selective/allow-sync-file.js';
import type { ConflictAction, PluginData } from './data-schema.js';
import { TOGGLEABLE_SPECIAL_CATEGORIES } from '../selective/obsidian-paths.js';
import { displayRequireLogin } from './require-login-view.js';
import type { ApiClient } from '../api-client.js';
import type { Account } from '../account.js';

/** Aggregated runtime info displayed by "Sync info" dump. */
export interface SyncInfoSnapshot {
  deviceName: string;
  connected: boolean;
  vaultName: string | null;
  vaultId: string | null;
  encryptionVersion: number | null;
  lastSyncMs: number | null;
  filesSynced: number;
  conflictsInLastRun: number;
}

export interface SettingsHost {
  containerEl: HTMLElement;
  /** Live snapshot of plugin data. Read-only here; updates go via `set*`. */
  getData(): PluginData;
  setData(patch: Partial<PluginData>): Promise<void>;

  api: ApiClient;
  account: Account;

  getSyncInfo(): SyncInfoSnapshot;
  /** Pause / resume callbacks; real plugin wires these to SyncPlugin. */
  onPauseClicked(): void;
  onResumeClicked(): void;
  /** Open Excluded Folders modal; returns the (possibly mutated) list. */
  manageExcludedFolders(current: string[]): Promise<string[]>;
  /**
   * Optional sign-out / pair callbacks. The real plugin in `main.ts`
   * wires these for the pair-block + login flow; tests inject lighter
   * hosts that omit them. Settings UI guards with optional chaining.
   */
  onSignOut?(): Promise<void>;
  loadMasterKey?(): Promise<Uint8Array>;
  onPaired?(
    masterKey: Uint8Array,
    vault: { id: string; name: string; host?: string; salt: string },
  ): Promise<void>;
}

/** Spec 06 §2.2 file-type toggle keys (5). */
const FILE_TYPE_KEYS: ReadonlyArray<{ key: keyof AllowTypeFlags; label: string; desc: string }> = [
  { key: 'md', label: 'Markdown', desc: 'md, canvas, base (always on)' },
  { key: 'image', label: 'Image', desc: 'bmp, png, jpg, jpeg, gif, svg, webp, avif' },
  { key: 'pdf', label: 'PDF', desc: 'pdf' },
  { key: 'audio', label: 'Audio', desc: 'mp3, wav, m4a, 3gp, flac, ogg, oga, opus' },
  { key: 'video', label: 'Video', desc: 'mp4, webm, ogv, mov, mkv' },
];

const SPECIAL_FILE_LABELS: Record<keyof AllowSpecialFlags, string> = {
  app: 'Appearance (app.json / types.json)',
  appearance: 'Appearance theme (appearance.json)',
  hotkey: 'Hotkeys',
  'core-plugin': 'Core plugins config',
  'core-plugin-data': 'Core plugin data',
  'appearance-data': 'Themes & snippets',
  'community-plugin': 'Community plugins list',
  'community-plugin-data': 'Community plugin payloads',
};

/**
 * Render the settings tab into `host.containerEl`. Caller controls
 * lifecycle (`hide()` removes the loop). Returns a dispose handle.
 */
export function renderSettingsTab(host: SettingsHost): { dispose: () => void } {
  let loginHandle: { dispose(): void } | null = null;

  function rerender(): void {
    loginHandle?.dispose();
    loginHandle = null;

    const data = host.getData();
    if (!host.account.loggedIn && !data.account.token) {
      loginHandle = displayRequireLogin(
        { containerEl: host.containerEl, api: host.api, account: host.account },
        {
          onLoginComplete: () => {
            // Persist token into plugin data and rerender.
            void host.setData({
              account: {
                token: host.account.token,
                email: host.account.email,
                name: host.account.name,
                license: host.account.license,
              },
            });
            rerender();
          },
        },
      );
      return;
    }
    renderMain(host, rerender);
  }

  rerender();

  return {
    dispose() {
      loginHandle?.dispose();
      loginHandle = null;
    },
  };
}

// ---------------------------------------------------------------------
// Main panel (post-login).
// ---------------------------------------------------------------------

function renderMain(host: SettingsHost, rerender: () => void): void {
  const data = host.getData();
  const doc = host.containerEl.ownerDocument;
  host.containerEl.innerHTML = '';

  const root = doc.createElement('div');
  root.className = 'obsync-settings';
  host.containerEl.appendChild(root);

  // --- Device name ---------------------------------------------------
  appendRow(root, 'Device name', 'The label shown in conflict-copy filenames.', (control) => {
    const input = doc.createElement('input');
    input.type = 'text';
    input.value = data.deviceName;
    input.placeholder = data.deviceName ? '' : 'desktop';
    input.dataset['obsyncField'] = 'deviceName';
    input.addEventListener('change', () => {
      void host.setData({ deviceName: input.value });
    });
    control.appendChild(input);
  });

  // --- Resolve conflicts --------------------------------------------
  appendRow(root, 'Resolve conflicts', 'merge: 3-way text merge. conflict: write conflicted copies.', (control) => {
    const select = doc.createElement('select');
    select.dataset['obsyncField'] = 'conflictAction';
    for (const opt of ['merge', 'conflict'] as ConflictAction[]) {
      const o = doc.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if (data.conflictAction === opt) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => {
      void host.setData({ conflictAction: select.value as ConflictAction });
    });
    control.appendChild(select);
  });

  // --- File types (5) ------------------------------------------------
  appendHeading(root, 'File types');
  for (const ft of FILE_TYPE_KEYS) {
    appendToggleRow(root, ft.label, ft.desc, data.allowTypes[ft.key], async (next) => {
      if (ft.key === 'md') return; // always on; ignore click
      const allowTypes = { ...data.allowTypes, [ft.key]: next };
      await host.setData({ allowTypes });
      rerender();
    }, ft.key === 'md');
  }

  // --- Special files (.obsidian/) ------------------------------------
  appendHeading(root, 'Special files (config folder)');
  for (const cat of TOGGLEABLE_SPECIAL_CATEGORIES) {
    appendToggleRow(
      root,
      SPECIAL_FILE_LABELS[cat],
      `Category: ${cat}`,
      data.allowSpecialFiles[cat],
      async (next) => {
        const allowSpecialFiles = {
          ...data.allowSpecialFiles,
          [cat]: next,
        };
        await host.setData({ allowSpecialFiles });
        rerender();
      },
    );
  }

  // --- Excluded folders ----------------------------------------------
  appendRow(root, 'Excluded folders', describeExcluded(data.excludedFolders), (control) => {
    const btn = doc.createElement('button');
    btn.textContent = 'Manage…';
    btn.className = 'obsync-settings__manage-excluded';
    btn.addEventListener('click', () => {
      void (async () => {
        const next = await host.manageExcludedFolders([...data.excludedFolders]);
        await host.setData({ excludedFolders: next });
        rerender();
      })();
    });
    control.appendChild(btn);
  });

  // --- Pause / Resume ------------------------------------------------
  appendHeading(root, 'Sync control');
  {
    const row = doc.createElement('div');
    row.className = 'obsync-settings__row obsync-settings__row--buttons';
    const pauseBtn = doc.createElement('button');
    pauseBtn.textContent = 'Pause sync';
    pauseBtn.dataset['obsyncAction'] = 'pause';
    pauseBtn.disabled = data.pause;
    pauseBtn.addEventListener('click', () => {
      host.onPauseClicked();
      void host.setData({ pause: true });
      rerender();
    });

    const resumeBtn = doc.createElement('button');
    resumeBtn.textContent = 'Resume sync';
    resumeBtn.dataset['obsyncAction'] = 'resume';
    resumeBtn.disabled = !data.pause;
    resumeBtn.addEventListener('click', () => {
      host.onResumeClicked();
      void host.setData({ pause: false });
      rerender();
    });

    row.appendChild(pauseBtn);
    row.appendChild(resumeBtn);
    root.appendChild(row);
  }

  // --- Sync info dump ------------------------------------------------
  appendHeading(root, 'Sync info');
  const info = host.getSyncInfo();
  const pre = doc.createElement('pre');
  pre.className = 'obsync-settings__sync-info';
  pre.textContent = renderSyncInfo(info, data);
  root.appendChild(pre);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function appendHeading(parent: HTMLElement, text: string): void {
  const doc = parent.ownerDocument;
  const h = doc.createElement('h3');
  h.textContent = text;
  h.className = 'obsync-settings__heading';
  parent.appendChild(h);
}

function appendRow(
  parent: HTMLElement,
  title: string,
  desc: string,
  buildControl: (control: HTMLElement) => void,
): void {
  const doc = parent.ownerDocument;
  const row = doc.createElement('div');
  row.className = 'obsync-settings__row';

  const info = doc.createElement('div');
  info.className = 'obsync-settings__info';
  const t = doc.createElement('div');
  t.className = 'obsync-settings__title';
  t.textContent = title;
  info.appendChild(t);
  const d = doc.createElement('div');
  d.className = 'obsync-settings__desc';
  d.textContent = desc;
  info.appendChild(d);
  row.appendChild(info);

  const control = doc.createElement('div');
  control.className = 'obsync-settings__control';
  buildControl(control);
  row.appendChild(control);

  parent.appendChild(row);
}

function appendToggleRow(
  parent: HTMLElement,
  title: string,
  desc: string,
  checked: boolean,
  onChange: (next: boolean) => void | Promise<void>,
  disabled = false,
): void {
  appendRow(parent, title, desc, (control) => {
    const doc = control.ownerDocument;
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.disabled = disabled;
    input.dataset['obsyncToggle'] = title;
    input.addEventListener('change', () => {
      void onChange(input.checked);
    });
    control.appendChild(input);
  });
}

function describeExcluded(folders: string[]): string {
  if (!folders.length) return 'No folders excluded.';
  return `${folders.length} folder${folders.length === 1 ? '' : 's'}: ${folders.join(', ')}`;
}

function fmtTs(ms: number | null): string {
  if (!ms) return 'never';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? 'invalid' : d.toISOString();
}

/** Spec 08 §3.8 — multi-line dump format. */
export function renderSyncInfo(info: SyncInfoSnapshot, data: PluginData): string {
  const lines = ['SYNC INFO:'];
  lines.push(`\tVault ID: ${info.vaultId ?? '(none)'}`);
  lines.push(`\tHost server: ${data.vaultHost ?? '(none)'}`);
  lines.push(`\tDevice name: ${info.deviceName || '(default)'}`);
  lines.push(
    `\tEncryption version: ${info.encryptionVersion === null ? '(none)' : info.encryptionVersion}`,
  );
  lines.push(`\tConnected: ${info.connected ? 'yes' : 'no'}`);
  lines.push(`\tLast sync: ${fmtTs(info.lastSyncMs)}`);
  lines.push(`\tFiles synced: ${info.filesSynced}`);
  lines.push(`\tConflicts in last run: ${info.conflictsInLastRun}`);
  const types = Object.entries(data.allowTypes)
    .filter(([, v]) => v)
    .map(([k]) => k);
  lines.push(`\tAllowed file types: ${types.join(', ')}`);
  const special = Object.entries(data.allowSpecialFiles)
    .filter(([, v]) => v)
    .map(([k]) => k);
  lines.push(`\tAllowed special types: ${special.join(', ')}`);
  lines.push(`\tIgnored directories:${data.excludedFolders.map((f) => `\n\t\t- ${f}`).join('')}`);
  return lines.join('\n');
}
