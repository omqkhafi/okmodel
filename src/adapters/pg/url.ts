/**
 * Connection URL helpers shared by the Postgres drivers.
 *
 * Pooler client hints in the query string are not Postgres startup parameters.
 * Drivers that pass the URL through must strip those hints first.
 */

/**
 * Removes the `pgbouncer` query parameter before a driver opens a connection.
 *
 * Other pooler hints in the URL are left alone: this version does not
 * interpret them. The migrate pooler guard still reads `pgbouncer=true` on
 * the original URL before this runs.
 *
 * @param url - A `postgres://` or `postgresql://` URL
 * @returns The same URL without `pgbouncer` in the query string
 */
export function driverUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.searchParams.has("pgbouncer")) return url;
  parsed.searchParams.delete("pgbouncer");
  return parsed.toString();
}
