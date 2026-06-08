/**
 * HostPool — sequential failover across a fixed list of relay hosts.
 *
 * Out-of-spec scope: anchors the "relay-1 → relay-N" pool the plugin
 * reaches obsync-server through. Internally a slot index that:
 *   - starts at 0 (the first host)
 *   - advances on consumer-reported failure
 *   - sticks to the last-known-good slot until reset
 *   - reset() rewinds to slot 0 at the start of a new reconnect cycle
 *
 * Two URL views are exposed:
 *   - `httpsBase()`  e.g. https://relay-1.bijitongbu.site/obsync
 *   - `wssBase()`    e.g. wss://relay-1.bijitongbu.site/obsync/
 *
 * The class is intentionally I/O-free. `ApiClient` and the WS-reconnect
 * loop in the SyncPlugin call `advance()` themselves on the errors *they*
 * classify as transport-level — keeping the failover policy in the
 * caller while the URL bookkeeping lives here.
 */

export interface HostPoolOptions {
  /** Ordered host list, e.g. ['relay-1.bijitongbu.site', ...]. Length ≥1. */
  hosts: string[];
  /**
   * Path prefix that wraps every host (no trailing slash).
   * Example: `'/obsync'` → `httpsBase()` returns `https://<host>/obsync`.
   */
  pathPrefix?: string;
}

export class HostPool {
  private idx = 0;
  private readonly _hosts: ReadonlyArray<string>;
  private readonly pathPrefix: string;

  constructor(opts: HostPoolOptions) {
    if (opts.hosts.length === 0) {
      throw new Error('HostPool requires at least one host');
    }
    this._hosts = [...opts.hosts];
    this.pathPrefix = opts.pathPrefix ?? '';
  }

  /** Number of hosts in the pool. */
  get size(): number {
    return this._hosts.length;
  }

  /** Current slot index (0-based). */
  get slot(): number {
    return this.idx;
  }

  /** Current hostname (no scheme, no path). */
  get currentHost(): string {
    return this._hosts[this.idx];
  }

  /** Read-only view of the host list — useful for diagnostics. */
  get hosts(): ReadonlyArray<string> {
    return this._hosts;
  }

  /** HTTPS base for ApiClient (no trailing slash). */
  httpsBase(): string {
    return `https://${this.currentHost}${this.pathPrefix}`;
  }

  /** WSS base for SyncServer (trailing slash to ease join). */
  wssBase(): string {
    return `wss://${this.currentHost}${this.pathPrefix}/`;
  }

  /** Move to the next slot, wrapping around at the end. */
  advance(): void {
    this.idx = (this.idx + 1) % this._hosts.length;
  }

  /** Reset to slot 0 — call at the start of a new reconnect cycle. */
  reset(): void {
    this.idx = 0;
  }
}

/**
 * Expand a template like `'relay-N.bijitongbu.site'` into 1..count hosts.
 * Substitutes the literal `N` with each slot number (1-indexed).
 *
 * `expandHostTemplate('relay-N.bijitongbu.site', 3)` →
 *   ['relay-1.bijitongbu.site', 'relay-2.bijitongbu.site', 'relay-3.bijitongbu.site']
 *
 * Multiple occurrences of `N` are all substituted (template authors
 * rarely need this, but `N-N.example.com` resolves consistently).
 */
export function expandHostTemplate(template: string, count: number): string[] {
  if (count < 1) throw new Error('count must be >= 1');
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    out.push(template.replace(/N/g, String(i)));
  }
  return out;
}
