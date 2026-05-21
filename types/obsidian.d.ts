/**
 * Minimal ambient declaration for the `obsidian` module surface that the
 * obsync plugin uses. We deliberately keep this tiny — the upstream
 * `obsidian.d.ts` ships ~7500 lines, almost none of which the plugin
 * actually touches.
 *
 * The runtime API is provided by the Obsidian app itself; at bundle
 * time esbuild marks `obsidian` as `external` so this declaration is
 * only consumed by tsc / jest.
 *
 * IMPORTANT: this file must remain a **non-module** script (no top-level
 * `import` / `export` statements) so the `declare module 'obsidian'`
 * block is treated as an ambient declaration, not a module export.
 */

declare module 'obsidian' {
  // -------------------------------------------------------------------
  // DataAdapter / Vault (only the methods VaultIO uses).
  // -------------------------------------------------------------------

  export interface Stat {
    type: 'file' | 'folder';
    ctime: number;
    mtime: number;
    size: number;
  }

  export interface ListedFiles {
    files: string[];
    folders: string[];
  }

  export interface DataWriteOptions {
    ctime?: number;
    mtime?: number;
  }

  export interface DataAdapter {
    list(normalizedPath: string): Promise<ListedFiles>;
    read(normalizedPath: string): Promise<string>;
    readBinary(normalizedPath: string): Promise<ArrayBuffer>;
    write(
      normalizedPath: string,
      data: string,
      options?: DataWriteOptions,
    ): Promise<void>;
    writeBinary(
      normalizedPath: string,
      data: ArrayBuffer,
      options?: DataWriteOptions,
    ): Promise<void>;
    remove(normalizedPath: string): Promise<void>;
    rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
    rename(normalizedPath: string, newNormalizedPath: string): Promise<void>;
    mkdir(normalizedPath: string): Promise<void>;
    exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>;
    stat(normalizedPath: string): Promise<Stat | null>;
  }

  /** Opaque handle returned by `Events.on` for `Events.offref`. */
  export interface EventRef {
    readonly _isEventRef: true;
  }

  export class Vault {
    adapter: DataAdapter;
    configDir: string;
    getName(): string;
    /**
     * Subscribe to vault-level file events. Returns an `EventRef` that
     * can be paired with `Plugin#registerEvent` for auto-disposal on
     * plugin unload. Obsidian's real API ships overloads per event; we
     * just take the catch-all callback shape since the sync layer only
     * cares "something changed, schedule a round".
     */
    on(
      name: 'modify' | 'create' | 'delete' | 'rename' | 'closed',
      cb: (...args: unknown[]) => unknown,
    ): EventRef;
    off(name: string, cb: (...args: unknown[]) => unknown): void;
  }

  // -------------------------------------------------------------------
  // App.
  // -------------------------------------------------------------------

  export class App {
    vault: Vault;
    workspace: unknown;
  }

  // -------------------------------------------------------------------
  // Plugin / PluginSettingTab / Modal / Notice — only what we touch.
  // -------------------------------------------------------------------

  export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    minAppVersion: string;
    description?: string;
    author?: string;
    isDesktopOnly?: boolean;
  }

  export interface Command {
    id: string;
    name: string;
    callback?: () => unknown;
    checkCallback?: (checking: boolean) => boolean | void;
  }

  export class Plugin {
    app: App;
    manifest: PluginManifest;
    constructor(app: App, manifest: PluginManifest);
    onload(): void | Promise<void>;
    onunload(): void;
    loadData(): Promise<unknown>;
    saveData(data: unknown): Promise<void>;
    addSettingTab(tab: PluginSettingTab): void;
    addRibbonIcon(icon: string, title: string, cb: (e: MouseEvent) => unknown): HTMLElement;
    addStatusBarItem(): HTMLElement;
    addCommand(cmd: Command): Command;
    registerInterval(id: number): number;
    /**
     * Track an `EventRef` for automatic disposal on plugin unload.
     * Real Obsidian returns the EventRef untouched; here we keep the
     * signature loose since callers only use it for side effects.
     */
    registerEvent(ref: EventRef): void;
  }

  export class PluginSettingTab {
    app: App;
    plugin: Plugin;
    containerEl: HTMLElement;
    constructor(app: App, plugin: Plugin);
    display(): void;
    hide(): void;
  }

  export class Modal {
    app: App;
    contentEl: HTMLElement;
    titleEl: HTMLElement;
    constructor(app: App);
    open(): void;
    close(): void;
    onOpen(): void;
    onClose(): void;
  }

  export class Notice {
    constructor(message: string, timeout?: number);
    hide(): void;
  }

  // -------------------------------------------------------------------
  // Platform — runtime flags Obsidian exposes for desktop / mobile
  // detection. Static booleans on a namespace-like object. The
  // ObsidianVaultIO mobile bug-workaround needs `isMobile`; main.ts
  // also reads `isDesktop` to pick a deviceName default. Tests stub
  // these out — guard reads with optional-chaining.
  // -------------------------------------------------------------------
  export const Platform: {
    isMobile: boolean;
    isDesktop: boolean;
    isMobileApp: boolean;
    isIosApp: boolean;
    isAndroidApp: boolean;
  };

  // -------------------------------------------------------------------
  // Setting — Obsidian's reusable row-builder used by Modals / settings.
  // Only the fluent methods the obsync plugin actually calls are
  // declared. Each method returns `this` to allow chaining.
  // -------------------------------------------------------------------
  export interface ButtonComponent {
    setButtonText(text: string): ButtonComponent;
    setCta(): ButtonComponent;
    setWarning(): ButtonComponent;
    onClick(cb: () => void): ButtonComponent;
  }
  export interface TextComponent {
    setPlaceholder(text: string): TextComponent;
    setValue(value: string): TextComponent;
    onChange(cb: (value: string) => void): TextComponent;
  }
  export class Setting {
    constructor(containerEl: HTMLElement);
    setName(name: string): Setting;
    setDesc(desc: string): Setting;
    addButton(cb: (b: ButtonComponent) => unknown): Setting;
    addText(cb: (t: TextComponent) => unknown): Setting;
  }

  // -------------------------------------------------------------------
  // requestUrl — Obsidian's CORS-bypassing HTTP helper (Electron main
  // process). The plugin uses this for REST calls because the renderer's
  // `fetch` is CORS-gated when hitting non-https origins.
  // -------------------------------------------------------------------

  export interface RequestUrlParam {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer | undefined;
    throw?: boolean;
    contentType?: string;
  }

  export interface RequestUrlResponse {
    status: number;
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
    text: string;
    json: unknown;
  }

  export function requestUrl(p: RequestUrlParam): Promise<RequestUrlResponse>;

  // -------------------------------------------------------------------
  // DOM helpers — Obsidian augments HTMLElement with these at runtime;
  // we only declare the few we use.
  // -------------------------------------------------------------------

  export interface DomElementInfo {
    text?: string;
    cls?: string | string[];
    attr?: Record<string, string>;
    title?: string;
  }
}

interface HTMLElement {
  createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
  ): HTMLElementTagNameMap[K];
  empty(): void;
  setText(text: string): void;
}
