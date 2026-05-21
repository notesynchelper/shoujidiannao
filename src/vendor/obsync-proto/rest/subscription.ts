/**
 * /subscription/list — client only inspects `.sync` truthiness.
 * Source: doc/01-rest-api.md §3.14, S22.
 */

export interface SubscriptionListBody {
  token: string;
}

export interface SubscriptionListOk {
  /** Truthy → sync enabled; falsy / missing → "needs subscription" UI. */
  sync: boolean | number | string;
  /** Optional; ignored by client but allowed by spec. */
  publish?: boolean | number | string;
  [extra: string]: unknown;
}
