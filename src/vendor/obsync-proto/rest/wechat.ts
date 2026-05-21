/**
 * /wechat/code/* — 6-digit code login flow introduced by this project
 * (no upstream spec equivalent).
 *
 * Flow:
 *   1. Client calls /wechat/code/start → server returns BOTH a 6-digit
 *      public `code` (shown to the user, sent through WeChat) AND a
 *      high-entropy private `session_id` (kept inside the plugin and
 *      used to poll).
 *   2. User opens the project's 服务号 and sends the 6-digit code as
 *      plain text. The 服务号 → CF Worker forwards {openid, code} to
 *      /wechat/code/bind with shared-secret auth (x-obsync-bind-secret).
 *   3. Client polls /wechat/code/poll {session_id} — once /bind has
 *      matched the code to an openid, /poll flips from "pending" to
 *      "ok" with the same {token,email,name,license} payload the
 *      upstream spec's /user/signin returned.
 *
 * Separating the public code from the poll id is intentional: the
 * 6-digit code is observable (shown on screen, sent through WeChat /
 * CF) and only has 10^6 entropy. If we used it as the poll key any
 * observer could fetch the issued token. The session_id is 32 random
 * hex chars (128 bits) and never leaves the plugin / server pair.
 */

// ---------------------------------------------------------------------
// /wechat/code/start — issue a fresh 6-digit code + session id
// ---------------------------------------------------------------------

export type WeChatCodeStartBody = Record<string, never>;

export interface WeChatCodeStartOk {
  /** 6-digit numeric code, '000000'..'999999' (zero-padded). PUBLIC. */
  code: string;
  /**
   * 32-char hex (128-bit) opaque session id. PRIVATE — never displayed
   * to the user or forwarded through WeChat; only used by the plugin
   * to call /wechat/code/poll.
   */
  session_id: string;
  /** Seconds until both code + session_id expire. */
  expires_in: number;
}

// ---------------------------------------------------------------------
// /wechat/code/poll — client poll (auth via session_id, NOT code)
// ---------------------------------------------------------------------

export interface WeChatCodePollBody {
  session_id: string;
}

export type WeChatCodePollResp =
  | { status: 'pending' }
  | { status: 'expired' }
  | {
      status: 'ok';
      token: string;
      email: string | null;
      name: string;
      license: string | null;
    };

// ---------------------------------------------------------------------
// /wechat/code/bind — CF Worker → server (服务号 message hook)
// ---------------------------------------------------------------------

export interface WeChatCodeBindBody {
  /** WeChat OpenID of the user who sent the code to the 公众号. */
  openid: string;
  /** Optional WeChat UnionID (cross-公众号/小程序 identity). */
  unionid?: string;
  /** Optional 昵称 from 公众号 metadata; falls back to "WeChat User". */
  nickname?: string;
  /** The 6-digit code echoed back from the user's message. */
  code: string;
}

export type WeChatCodeBindResp =
  | { ok: true }
  | { error: string };
