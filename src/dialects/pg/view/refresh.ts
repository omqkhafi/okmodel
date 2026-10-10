/**
 * `REFRESH MATERIALIZED VIEW` for one view handle.
 *
 * Loaded the first time `refresh()` runs. A featureless app, and an app that
 * never calls it, do not import this module. The name is unqualified so the
 * session `search_path` selects the schema, matching a view `find`.
 */

import type { DriverPool, ExecuteOptions } from "../../../contracts/driver.js";
import type { ErrorStatuses } from "../../../contracts/error.js";

/** The client fields a refresh uses. The view hook passes its session. */
type RefreshHost = {
  readonly pool: DriverPool;
  readonly connected: Promise<void>;
  readonly timeouts?: { readonly statement?: number } | undefined;
  readonly http?: ErrorStatuses | undefined;
  readonly includeValues?: boolean | undefined;
  readonly logger?:
    | { error?(entry: { readonly code: string; readonly summary: string }): void }
    | undefined;
};

/**
 * Refreshes one materialized view on the primary.
 *
 * `CONCURRENTLY` when the declaration asked for it. The statement timeout is
 * the client's, the same ceiling a write uses. A database failure is mapped
 * and logged like any other statement.
 *
 * @param session - Pool, timeout, and logger from the client
 * @param name - SQL name of the materialized view
 * @param concurrently - True when the view declares `refresh: "concurrently"`
 */
export async function refreshView(
  session: object,
  name: string,
  concurrently: boolean,
): Promise<void> {
  const host = asHost(session);
  await host.connected;
  const timeout = host.timeouts?.statement;
  const options: ExecuteOptions | undefined = timeout === undefined ? undefined : { timeout };
  const text = `refresh materialized view${concurrently ? " concurrently" : ""} ${quote(name)}`;
  try {
    await host.pool.execute(text, undefined, options);
  } catch (error) {
    const { mapPostgresError } = await import("../errors.js");
    const mapped = mapPostgresError(error, {
      ...(host.http !== undefined ? { http: host.http } : {}),
      ...(host.includeValues === true ? { includeValues: true } : {}),
    });
    host.logger?.error?.({ code: mapped.code, summary: mapped.summary });
    throw mapped;
  }
}

function asHost(session: object): RefreshHost {
  return session as RefreshHost;
}

/** Quotes one identifier. Internal quotes are doubled. */
function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
