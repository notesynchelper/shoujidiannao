/**
 * Settings-tab pair UI block (ROADMAP §6.10).
 *
 * Framework-agnostic vanilla-DOM renderer: pass a container element +
 * either a `device1` or `device2` mode config; this module wires up
 * the corresponding `PairDevice1` / `PairDevice2` state machine and
 * repaints the container on every state transition.
 *
 * Designed so the existing settings tab (`settings-tab.ts`) can mount
 * one block in either D1 or D2 mode depending on whether the local
 * IndexedDB already holds a `masterKey` for the vault (ROADMAP §6.4
 * autoBootstrap case A vs case B).
 *
 * UI copy is Chinese per ROADMAP §6.10 with intentionally loud SAS
 * comparison wording — short timers + bold SAS digits are essential
 * defenses against "瞎点用户" (§1.5.3 threat model).
 */

import type { VaultMeta } from '@obsync/proto';
import type { ApiClient } from '../api-client.js';
import { PairDevice1 } from './pair-device1.js';
import { PairDevice2 } from './pair-device2.js';
import { formatSas } from './sas-display.js';
import type { D1State, D2State } from './state-types.js';

export interface PairBlockOptions {
  container: HTMLElement;
  api: ApiClient;
  token: string;
  device1?: {
    vault_id: string;
    /** Async resolver for the masterKey owned by this device. */
    loadMasterKey: () => Promise<Uint8Array>;
  };
  device2?: {
    /** Persist callback — caller writes IDB + kicks sync from here. */
    onPaired: (masterKey: Uint8Array, vault: VaultMeta) => Promise<void>;
  };
}

export class PairBlock {
  private readonly container: HTMLElement;
  private readonly api: ApiClient;
  private readonly token: string;
  private readonly device1?: PairBlockOptions['device1'];
  private readonly device2?: PairBlockOptions['device2'];

  private d1: PairDevice1 | undefined = undefined;
  private d2: PairDevice2 | undefined = undefined;
  private mounted = false;

  constructor(opts: PairBlockOptions) {
    if (!opts.device1 && !opts.device2) {
      throw new Error('PairBlock requires either device1 or device2 options');
    }
    if (opts.device1 && opts.device2) {
      throw new Error('PairBlock cannot run in both device1 and device2 modes');
    }
    this.container = opts.container;
    this.api = opts.api;
    this.token = opts.token;
    this.device1 = opts.device1;
    this.device2 = opts.device2;
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    if (this.device1) {
      this.renderD1Idle();
    } else if (this.device2) {
      // D2 enters the prompt-code view; the actual machine is created on submit
      // so cancelling/resubmitting doesn't leak state.
      this.renderD2PromptCode();
    }
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.container.innerHTML = '';
    // Best-effort cleanup; cancel() is fire-and-forget.
    void this.d1?.cancel().catch(() => undefined);
    void this.d2?.cancel().catch(() => undefined);
    this.d1 = undefined;
    this.d2 = undefined;
  }

  // -----------------------------------------------------------------
  // Device 1
  // -----------------------------------------------------------------

  private renderD1Idle(): void {
    this.container.innerHTML = '';
    const wrap = activeDocument.createElement('div');
    wrap.className = 'obsync-pair-block obsync-pair-d1-idle';
    const title = activeDocument.createElement('h3');
    title.textContent = '添加新设备';
    const help = activeDocument.createElement('p');
    help.textContent = '点击下方按钮生成 6 位配对码，在新设备的同步设置里输入这段码。';
    const btn = activeDocument.createElement('button');
    btn.textContent = '添加新设备';
    btn.addEventListener('click', () => {
      void this.startD1();
    });
    wrap.append(title, help, btn);
    this.container.appendChild(wrap);
  }

  private async startD1(): Promise<void> {
    if (!this.device1) return;
    try {
      const masterKey = await this.device1.loadMasterKey();
      this.d1 = new PairDevice1({
        api: this.api,
        token: this.token,
        vault_id: this.device1.vault_id,
        masterKey,
        onState: (s) => this.onD1State(s),
      });
      await this.d1.start();
    } catch (e) {
      this.renderD1Error(e instanceof Error ? e.message : '初始化失败');
    }
  }

  private onD1State(s: D1State): void {
    if (!this.mounted) return;
    switch (s.phase) {
      case 'idle':
        this.renderD1Idle();
        return;
      case 'initializing':
        this.renderSpinner('正在生成配对码...');
        return;
      case 'code_displayed':
        this.renderD1CodeDisplayed(s.pair_code);
        return;
      case 'sas_pending': {
        const txt = formatSas(s.sas.digits, s.sas.emojiIndices);
        this.renderSasCompare(
          txt,
          `请确认 Device 2 上看到相同的 ${txt}。两端必须完全一致，任何一位不同都不能继续。`,
          () => void this.d1?.confirmSas(),
          () => void this.d1?.cancel(),
        );
        return;
      }
      case 'sealed':
        this.renderInfo('✓ 已发送密钥。等待新设备完成同步');
        // 3s auto-reset
        window.setTimeout(() => {
          if (this.mounted) this.renderD1Idle();
        }, 3000);
        return;
      case 'expired':
        this.renderD1Error('配对码已过期，请重新生成');
        return;
      case 'error':
        this.renderD1Error(s.message);
        return;
    }
  }

  private renderD1CodeDisplayed(pair_code: string): void {
    this.container.innerHTML = '';
    const wrap = activeDocument.createElement('div');
    wrap.className = 'obsync-pair-block obsync-pair-d1-code';
    const code = activeDocument.createElement('div');
    code.className = 'obsync-pair-code';
    code.textContent = pair_code;

    const help = activeDocument.createElement('p');
    help.textContent = '在新设备的同步设置里输入上方 6 位码。等待新设备输入...';

    const cancel = activeDocument.createElement('button');
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => void this.d1?.cancel());

    wrap.append(code, help, cancel);
    this.container.appendChild(wrap);
  }

  private renderD1Error(msg: string): void {
    this.container.innerHTML = '';
    const wrap = activeDocument.createElement('div');
    wrap.className = 'obsync-pair-block obsync-pair-error';
    const err = activeDocument.createElement('p');
    err.className = 'obsync-pair-error-text';
    err.textContent = `错误：${msg}`;
    const retry = activeDocument.createElement('button');
    retry.textContent = '重试';
    retry.addEventListener('click', () => this.renderD1Idle());
    wrap.append(err, retry);
    this.container.appendChild(wrap);
  }

  // -----------------------------------------------------------------
  // Device 2
  // -----------------------------------------------------------------

  private renderD2PromptCode(): void {
    this.container.innerHTML = '';
    const wrap = activeDocument.createElement('div');
    wrap.className = 'obsync-pair-block obsync-pair-d2-prompt';
    const title = activeDocument.createElement('h3');
    title.textContent = '从已登录设备导入密钥';
    const help = activeDocument.createElement('p');
    help.textContent = '此设备需要从已登录设备导入密钥。请在另一台已登录设备的同步设置里点 "添加新设备"，把生成的 6 位码填到这里。';

    const input = activeDocument.createElement('input');
    input.className = 'obsync-pair-code-input';
    input.type = 'text';
    input.maxLength = 6;
    input.placeholder = '6 位配对码';

    const submit = activeDocument.createElement('button');
    submit.textContent = '提交';
    submit.addEventListener('click', () => {
      void this.startD2(input.value.trim());
    });

    wrap.append(title, help, input, submit);
    this.container.appendChild(wrap);
  }

  private async startD2(code: string): Promise<void> {
    if (!this.device2) return;
    this.d2 = new PairDevice2({
      api: this.api,
      token: this.token,
      onState: (s) => this.onD2State(s),
    });
    await this.d2.submitCode(code);
  }

  private onD2State(s: D2State): void {
    if (!this.mounted) return;
    switch (s.phase) {
      case 'prompt_code':
        this.renderD2PromptCode();
        return;
      case 'claiming':
        this.renderSpinner('正在连接到 Device 1...');
        return;
      case 'sas_pending': {
        const txt = formatSas(s.sas.digits, s.sas.emojiIndices);
        this.renderSasCompare(
          txt,
          `请确认 Device 1 上看到相同的 ${txt}。两端必须完全一致，任何一位不同都不能继续。`,
          () => void this.d2?.confirmSas(),
          () => void this.d2?.cancel(),
        );
        return;
      }
      case 'decrypting':
        this.renderSpinner('正在解密...');
        return;
      case 'ready':
        this.renderInfo('✓ 已成功导入。同步即将开始');
        void this.device2?.onPaired(s.masterKey, s.vault).catch(() => undefined);
        window.setTimeout(() => {
          if (this.mounted) this.unmount();
        }, 5000);
        return;
      case 'error':
        this.renderD2Error(s.message);
        return;
    }
  }

  private renderD2Error(msg: string): void {
    this.container.innerHTML = '';
    const wrap = activeDocument.createElement('div');
    wrap.className = 'obsync-pair-block obsync-pair-error';
    const err = activeDocument.createElement('p');
    err.className = 'obsync-pair-error-text';
    err.textContent = `错误：${msg}`;
    const retry = activeDocument.createElement('button');
    retry.textContent = '重试';
    retry.addEventListener('click', () => this.renderD2PromptCode());
    wrap.append(err, retry);
    this.container.appendChild(wrap);
  }

  // -----------------------------------------------------------------
  // Shared partials
  // -----------------------------------------------------------------

  private renderSpinner(text: string): void {
    this.container.innerHTML = '';
    const p = activeDocument.createElement('p');
    p.textContent = text;
    this.container.appendChild(p);
  }

  private renderInfo(text: string): void {
    this.container.innerHTML = '';
    const p = activeDocument.createElement('p');
    p.className = 'obsync-pair-info';
    p.textContent = text;
    this.container.appendChild(p);
  }

  private renderSasCompare(
    sasText: string,
    helpText: string,
    onConfirm: () => void,
    onReject: () => void,
  ): void {
    this.container.innerHTML = '';
    const wrap = activeDocument.createElement('div');
    wrap.className = 'obsync-pair-block obsync-pair-sas';

    const sas = activeDocument.createElement('div');
    sas.className = 'obsync-pair-sas-text';
    sas.textContent = sasText;

    const help = activeDocument.createElement('p');
    help.className = 'obsync-pair-sas-warning';
    help.textContent = helpText;

    const ok = activeDocument.createElement('button');
    ok.textContent = '一致，确认';
    ok.addEventListener('click', onConfirm);

    const no = activeDocument.createElement('button');
    no.className = 'obsync-pair-reject';
    no.textContent = '不一致，拒绝';
    no.addEventListener('click', onReject);

    wrap.append(sas, help, ok, no);
    this.container.appendChild(wrap);
  }
}
