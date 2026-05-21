/**
 * `Account` — token + identity persisted via the Obsidian Plugin's
 * `loadData()` / `saveData()` hooks. Mirrors the desktop client's
 * 5-field `obsidian-account` localStorage snapshot (spec common §
 * `AccountSnapshot`), minus the enterprise `key` field which we don't
 * surface yet.
 *
 * `save()` is fire-and-forget — callers don't await it for UI flow
 * (the persistence loop is debounced by the plugin's plain `saveData`).
 */

import type { AccountSnapshot } from '@obsync/proto';

export interface AccountFields {
  token: string | null;
  email: string | null;
  name: string | null;
  license: string | null;
}

/** What `loadData()` may hand back; defensively reads each field. */
function readField(raw: unknown, key: keyof AccountFields): string | null {
  if (raw && typeof raw === 'object' && key in raw) {
    const v = (raw as Record<string, unknown>)[key];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }
  return null;
}

export class Account {
  token: string | null = null;
  email: string | null = null;
  name: string | null = null;
  license: string | null = null;

  /** Whether a logged-in token is present. */
  get loggedIn(): boolean {
    return typeof this.token === 'string' && this.token.length > 0;
  }

  /** Hydrate from a parsed `data.json` blob's `account` sub-object. */
  loadFrom(raw: unknown): void {
    this.token = readField(raw, 'token');
    this.email = readField(raw, 'email');
    this.name = readField(raw, 'name');
    this.license = readField(raw, 'license');
  }

  /** Serialise into the wire-compatible `AccountSnapshot` shape. */
  toSnapshot(): AccountFields & { key: null } {
    return {
      token: this.token,
      email: this.email,
      name: this.name,
      license: this.license,
      key: null,
    } satisfies AccountSnapshot;
  }

  /** Overwrite all fields atomically from one wire response. */
  update(fields: Partial<AccountFields>): void {
    if ('token' in fields) this.token = fields.token ?? null;
    if ('email' in fields) this.email = fields.email ?? null;
    if ('name' in fields) this.name = fields.name ?? null;
    if ('license' in fields) this.license = fields.license ?? null;
  }

  /** Wipe everything — equivalent to `displayRequireLogin` resetting state. */
  clear(): void {
    this.token = null;
    this.email = null;
    this.name = null;
    this.license = null;
  }
}
