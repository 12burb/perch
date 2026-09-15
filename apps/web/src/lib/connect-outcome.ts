/**
 * How a provider's callback went (spec §7.1 `/connect/callback/{provider}`; task 2.14). The api
 * finishes the exchange and redirects to `/connections` with one of these in the query, because it
 * has no idea which workspace's settings page the browser came from and the browser does.
 */
export type ConnectOutcome = { connected?: string; error?: string };

/** Search params, narrowed: one short word either way, never markup and never a stack. */
export function connectOutcome(search: Record<string, unknown>): ConnectOutcome {
  const one = (value: unknown) => (typeof value === "string" && value ? value.slice(0, 300) : null);
  const connected = one(search.connected);
  const failed = one(search.error);
  return { ...(connected ? { connected } : {}), ...(failed ? { error: failed } : {}) };
}
