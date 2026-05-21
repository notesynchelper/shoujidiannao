/**
 * /test/issue-token — gated on env var OBSYNC_TEST_LOGIN_ENABLED=true.
 * Source: ROADMAP.md §2.4.
 *
 * The response shape mirrors /wechat/oauth/poll status:ok and the
 * desktop client's original /user/signin response, so jest tests can
 * acquire tokens without going through the WeChat flow.
 */

export interface TestIssueTokenBody {
  seed_id: string;
  name?: string;
  email?: string;
}

export interface TestIssueTokenOk {
  token: string;
  email: string | null;
  name: string;
  license: string | null;
}
