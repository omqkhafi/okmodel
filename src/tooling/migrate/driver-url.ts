/**
 * Connection URL helpers for migrate commands.
 *
 * Pooler client hints in the query string are not Postgres startup parameters.
 * Every migrate path that opens a driver must strip those hints first. The
 * URL guard still reads `pgbouncer=true` on the original URL before this runs.
 */

/**
 * Removes the `pgbouncer` query parameter before a driver opens a connection.
 *
 * Other pooler hints in the URL are left alone: this version does not
 * interpret them.
 *
 * `application` names the connection in `pg_stat_activity` when the URL does
 * not name one already.
 *
 * @param url - A `postgres://` or `postgresql://` URL
 * @param application - `application_name` to add, unless the URL has one
 * @returns The same URL without `pgbouncer` in the query string
 */
export function driverUrl(url: string, application?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const hint = parsed.searchParams.has("pgbouncer");
  const name = application !== undefined && !parsed.searchParams.has("application_name");
  if (!hint && !name) return url;
  parsed.searchParams.delete("pgbouncer");
  if (name) parsed.searchParams.set("application_name", application);
  return parsed.toString();
}
