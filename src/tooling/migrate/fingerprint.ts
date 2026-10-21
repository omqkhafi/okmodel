/**
 * Host fingerprint for a Postgres URL.
 *
 * `hostDb` is the SHA-256 of lower-cased `host:port/database`. The user,
 * the password, and the query string are not part of it. `identity` stays
 * null: this build does not read `pg_control_system()`.
 */

import { OkmError } from "../../contracts/error.js";
import { sha256 } from "../../contracts/sha256.js";

/** Host, port, and database name from a Postgres URL. */
export type PostgresEndpoint = {
  readonly host: string;
  readonly port: string;
  readonly database: string;
};

/**
 * SHA-256 of lower-cased `host:port/database`.
 *
 * @param host - Already parsed host
 * @param port - Decimal port, `5432` when the URL omitted it
 * @param database - Pathname without the leading slash
 * @returns Lowercase hex
 */
export function hostDbFingerprint(host: string, port: string, database: string): string {
  return sha256(`${host}:${port}/${database}`.toLowerCase());
}

/**
 * Parses a Postgres URL into the fingerprint parts.
 *
 * @param url - `postgres://` URL
 * @returns Lowercased host, port, and database name
 */
export function postgresEndpoint(url: string): PostgresEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OkmError("OKM1845", "The target URL is not a Postgres URL.", {
      fix: { summary: "Pass a postgres:// URL for the target." },
    });
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port.length > 0 ? parsed.port : "5432",
    database,
  };
}
