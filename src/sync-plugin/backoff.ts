/**
 * Backoff — exponential retry timer with optional jitter (spec 05a §3.4
 * / X9 class).
 *
 *   getTimeout():
 *     - count === 0 → returns `min`
 *     - else       → base * 2^(count - 1), * (0.5 + 0.5*Math.random()) if
 *                    jitter, then min(max, min + raw)
 *
 *   nextTs is advanced on both `fail()` and `success()`. `isReady()`
 *   compares `Date.now() > nextTs`.
 */

export interface BackoffOptions {
  /** Seed for deterministic tests. Defaults to `Math.random`. */
  rng?: () => number;
}

export class Backoff {
  private _count = 0;
  private _nextTs: number;
  private readonly rng: () => number;

  constructor(
    private readonly min: number,
    private readonly max: number,
    private readonly base: number,
    private readonly jitter: boolean = true,
    opts: BackoffOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
    this._nextTs = Date.now() + this.getTimeout();
  }

  get count(): number {
    return this._count;
  }
  get nextTs(): number {
    return this._nextTs;
  }

  /** Compute the current step's timeout in ms. */
  getTimeout(): number {
    if (this._count === 0) return this.min;
    let t = this.base * Math.pow(2, this._count - 1);
    if (this.jitter) t *= 0.5 + 0.5 * this.rng();
    return Math.floor(Math.min(this.max, this.min + t));
  }

  /** Record a failure, advance the next ready timestamp. */
  fail(now: number = Date.now()): void {
    this._count += 1;
    this._nextTs = now + this.getTimeout();
  }

  /** Record success — reset counter and re-baseline the timer. */
  success(now: number = Date.now()): void {
    this._count = 0;
    this._nextTs = now + this.getTimeout();
  }

  /** Has the backoff window elapsed? */
  isReady(now: number = Date.now()): boolean {
    return now > this._nextTs;
  }
}
