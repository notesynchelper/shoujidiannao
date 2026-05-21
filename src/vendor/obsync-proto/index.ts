/**
 * @obsync/proto — wire types + constants shared between client and
 * server. No runtime logic, no I/O.
 *
 * Field-naming policy: snake_case where the desktop client uses it
 * (`vault_uid`, `keyhash`, `encryption_version`, ...). Do not
 * camelCase-rewrap.
 */

export * from './constants.js';
export * from './rest/common.js';
export * from './rest/user.js';
export * from './rest/vault.js';
export * from './rest/wechat.js';
export * from './rest/subscription.js';
export * from './rest/test.js';
export * from './rest/pair.js';
export * from './ws/frames.js';
