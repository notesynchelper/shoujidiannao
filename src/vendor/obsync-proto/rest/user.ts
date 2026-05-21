/**
 * /user/* wire types. Source: doc/01-rest-api.md §3.5 / §3.7 / §3.8.
 *
 * Note: this project replaces /user/signin with /wechat/oauth/* (see
 * ../wechat.ts). The token-bearing responses (UserInfoOk / AuthTokenOk
 * / WeChatPollOk) share the same shape so Account.save() does not
 * care which login path produced the token.
 */

/** Body for /user/info, /user/signout, /user/authtoken. */
export interface UserTokenBody {
  token: string;
}

/**
 * /user/info success response.
 * The client unconditionally assigns these three fields to Account; if
 * the server omits any, the field becomes `undefined` locally.
 */
export interface UserInfoOk {
  email: string | null;
  name: string;
  license: string | null;
}

/**
 * /user/signout response.
 * Per spec S7: response body is not consumed by the client; we return
 * `{}` on success and `{error: "Not logged in"}` on stale token.
 */
export type UserSignoutOk = Record<string, never>;

/**
 * /user/authtoken response. Same shape as UserInfoOk + `token`.
 * Client writes Account fields only when `token` is truthy.
 */
export interface AuthTokenOk extends UserInfoOk {
  token: string;
}
