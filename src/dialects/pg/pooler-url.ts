/**
 * URL signals that a target is a pooler.
 *
 * This is the check `detectPooler` and `watch` share. It does not open a
 * client. A quiet URL is not proof of a direct connection.
 */

/** Which part of the URL said the target is pooled. */
export type PoolerUrlSignal = "host" | "port" | "parameter";

/**
 * Reads host, port, and `pgbouncer=true` from a Postgres URL.
 *
 * A host that contains `-pooler`, `.pooler.supabase.com`, `pooler`, or
 * `pgbouncer` is pooled. Ports 6543 and 6432 are pooled. An unparseable URL
 * is not a signal.
 *
 * @param url - Target URL
 * @returns The signal, or `undefined` when the URL is quiet or not a URL
 */
export function poolerUrlSignal(
  url: string,
): { readonly signal: PoolerUrlSignal; readonly detail: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  if (host.includes("-pooler")) return { signal: "host", detail: "the host name contains -pooler" };
  if (host.includes(".pooler.supabase.com")) {
    return { signal: "host", detail: "the host name contains .pooler.supabase.com" };
  }
  if (host.includes("pooler") || host.includes("pgbouncer")) {
    return { signal: "host", detail: "a pooler host" };
  }
  const port = parsed.port.length > 0 ? parsed.port : "5432";
  if (port === "6543" || port === "6432") {
    return { signal: "port", detail: "the port (6543 or 6432)" };
  }
  if (parsed.searchParams.get("pgbouncer") === "true") {
    return { signal: "parameter", detail: "the pgbouncer=true parameter" };
  }
  return undefined;
}
