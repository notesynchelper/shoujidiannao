/**
 * `displayRequireLogin` — replaces the spec 08 §3.1 email/password
 * form with the project's 6-digit code + paste-token combo
 * (ROADMAP §6.3 + §6.7).
 *
 * Login flow:
 *   1. User clicks "Sign in with WeChat".
 *   2. We POST /wechat/code/start and display the returned 6-digit code
 *      with instructions to send it to the project's 服务号 (WeChat
 *      Official Account).
 *   3. The 服务号 webhook forwards {openid, code} to a CF Worker, which
 *      in turn POSTs /wechat/code/bind on the server. The server flips
 *      the code's status to "ok" and attaches a token.
 *   4. We poll /wechat/code/poll every 2 seconds; when status === "ok"
 *      we update Account and notify the host. The loop self-aborts when
 *      the host calls `dispose()` (e.g. settings tab re-renders).
 *
 * Dev/test builds additionally render a folded paste-token area whose
 * inputs feed straight into the `Account` object; ROADMAP §6.7 lists
 * `OBSYNC_DEV_BUILD === true` as the gate.
 */

import type { ApiClient } from '../api-client.js';
import type { Account } from '../account.js';
import { isDevBuild } from '../plugin-build-flags.js';

/** Public-facing display name of the 服务号 the user should send the code to. */
const OFFICIAL_ACCOUNT_LABEL = 'Obsync 服务号';

export interface RequireLoginCallbacks {
  /** Called after `Account` is populated so the host can re-render. */
  onLoginComplete: () => void;
  /** Optional hook for telemetry / breadcrumbs. */
  onError?: (message: string) => void;
}

export interface RequireLoginHost {
  containerEl: HTMLElement;
  api: ApiClient;
  account: Account;
  /** Poll interval in ms; tests override this to 0 to step manually. */
  pollIntervalMs?: number;
}

export interface RequireLoginHandle {
  /** Manually cancel any in-flight polling loop. */
  dispose(): void;
  /**
   * Test helper — synchronously trigger one poll round. Returns the
   * promise so tests can await deterministic state transitions.
   */
  pollOnceForTest(): Promise<void>;
}

/** Step 1: render the static "Sign in with WeChat" entry view. */
export function displayRequireLogin(
  host: RequireLoginHost,
  callbacks: RequireLoginCallbacks,
): RequireLoginHandle {
  const doc = host.containerEl.ownerDocument;
  host.containerEl.innerHTML = '';

  const wrap = doc.createElement('div');
  wrap.className = 'obsync-require-login';
  host.containerEl.appendChild(wrap);

  const h2 = doc.createElement('h2');
  h2.textContent = 'Sign in to obsync';
  wrap.appendChild(h2);

  const p = doc.createElement('p');
  p.textContent = `通过 ${OFFICIAL_ACCOUNT_LABEL} 发送 6 位验证码登录`;
  wrap.appendChild(p);

  const signinBtn = doc.createElement('button');
  signinBtn.className = 'mod-cta obsync-require-login__signin';
  signinBtn.textContent = 'Sign in with wechat';
  wrap.appendChild(signinBtn);

  const codeZone = doc.createElement('div');
  codeZone.className = 'obsync-require-login__code';
  wrap.appendChild(codeZone);

  let pollHandle: { stop: () => void; once: () => Promise<void> } | null = null;
  let disposed = false;

  signinBtn.addEventListener('click', () => {
    if (disposed) return;
    void openWechatCode(host, codeZone, callbacks, (handle) => {
      pollHandle?.stop();
      pollHandle = handle;
    });
  });

  // The literal `OBSYNC_DEV_BUILD` is replaced by esbuild's `define`
  // with `"true"` / `"false"` (the strings). In a release build the
  // branch below collapses to `if ("false")` and esbuild's DCE
  // strips both the branch and the unused `renderPasteTokenSection`.
  // Wrap in `isDevBuild()` too so tsc / jest can flip the flag at
  // runtime without recompiling.
  if (OBSYNC_DEV_BUILD && isDevBuild()) {
    renderPasteTokenSection(host, wrap, callbacks);
  }

  return {
    dispose() {
      disposed = true;
      pollHandle?.stop();
      pollHandle = null;
    },
    async pollOnceForTest() {
      if (pollHandle) await pollHandle.once();
    },
  };
}

// ---------------------------------------------------------------------
// 6-digit code + polling
// ---------------------------------------------------------------------

async function openWechatCode(
  host: RequireLoginHost,
  codeZone: HTMLElement,
  callbacks: RequireLoginCallbacks,
  attach: (handle: { stop: () => void; once: () => Promise<void> }) => void,
): Promise<void> {
  const doc = codeZone.ownerDocument;
  codeZone.innerHTML = '';

  const status = doc.createElement('p');
  status.className = 'obsync-require-login__status';
  status.textContent = '正在生成验证码…';
  codeZone.appendChild(status);

  let start: Awaited<ReturnType<typeof host.api.wechatCodeStart>>;
  try {
    start = await host.api.wechatCodeStart();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    status.textContent = `登录初始化失败：${msg}`;
    callbacks.onError?.(msg);
    return;
  }

  // The 6-digit code itself — large, selectable, easy to copy.
  const codeEl = doc.createElement('div');
  codeEl.className = 'obsync-require-login__code-value';
  codeEl.textContent = start.code;
  codeZone.appendChild(codeEl);

  const instructions = doc.createElement('p');
  instructions.className = 'obsync-require-login__instructions';
  instructions.textContent =
    `在微信中关注「${OFFICIAL_ACCOUNT_LABEL}」并将上面的 6 位验证码作为消息发送给它，` +
    `登录将自动完成。验证码 ${start.expires_in} 秒内有效。`;
  codeZone.appendChild(instructions);

  status.textContent = '正在等待消息送达…';

  // Polling loop
  let stopped = false;
  let timerId: number | null = null;
  const interval = host.pollIntervalMs ?? 2000;

  async function pollOnce(): Promise<void> {
    if (stopped) return;
    try {
      const resp = await host.api.wechatCodePoll(start.session_id);
      if (stopped) return;
      switch (resp.status) {
        case 'pending':
          status.textContent = '正在等待消息送达…';
          break;
        case 'expired':
          status.textContent = '验证码已过期，请点击 "sign in with wechat" 重新获取';
          stopped = true;
          return;
        case 'ok': {
          host.account.update({
            token: resp.token,
            email: resp.email,
            name: resp.name,
            license: resp.license,
          });
          status.textContent = '登录成功';
          stopped = true;
          callbacks.onLoginComplete();
          return;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      status.textContent = `登录轮询失败：${msg}`;
      callbacks.onError?.(msg);
    }
  }

  function scheduleNext(): void {
    if (stopped || interval <= 0) return;
    timerId = window.setTimeout(() => {
      void (async () => {
        await pollOnce();
        scheduleNext();
      })();
    }, interval);
  }

  attach({
    stop() {
      stopped = true;
      if (timerId) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    },
    once: pollOnce,
  });

  await pollOnce();
  scheduleNext();
}

// ---------------------------------------------------------------------
// Paste-token developer panel (test/dev builds only).
// ---------------------------------------------------------------------

export function renderPasteTokenSection(
  host: RequireLoginHost,
  parent: HTMLElement,
  callbacks: RequireLoginCallbacks,
): void {
  const doc = parent.ownerDocument;
  const details = doc.createElement('details');
  details.className = 'obsync-paste-token';

  const summary = doc.createElement('summary');
  summary.textContent = 'Developer options (test builds only)';
  details.appendChild(summary);

  const warn = doc.createElement('p');
  warn.className = 'obsync-paste-token__warn';
  warn.textContent = '仅用于本地测试；生产构建不会显示此面板';
  details.appendChild(warn);

  function makeInput(label: string, placeholder: string): HTMLInputElement {
    const wrap = doc.createElement('label');
    wrap.className = 'obsync-paste-token__field';
    const span = doc.createElement('span');
    span.textContent = `${label} `;
    wrap.appendChild(span);
    const input = doc.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.dataset['obsyncPaste'] = label.toLowerCase();
    wrap.appendChild(input);
    details.appendChild(wrap);
    return input;
  }

  const tokenInput = makeInput('Token', 'paste test token here');
  const emailInput = makeInput('Email', 'optional');
  const nameInput = makeInput('Name', 'optional');

  const applyBtn = doc.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'obsync-paste-token__apply';
  applyBtn.addEventListener('click', () => {
    const token = tokenInput.value.trim();
    if (!token) {
      callbacks.onError?.('paste-token: empty token');
      return;
    }
    host.account.update({
      token,
      email: emailInput.value.trim() || null,
      name: nameInput.value.trim() || null,
      license: null,
    });
    callbacks.onLoginComplete();
  });
  details.appendChild(applyBtn);

  parent.appendChild(details);
}
