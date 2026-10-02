/**
 * Connection URLs.
 *
 * These exist only at execution time. Plans and run state do not store them.
 */

/** Pieces of a `postgres://` URL. */
export type PostgresUrlParts = {
  readonly user: string;
  readonly password: string;
  readonly host: string;
  readonly port: string;
  readonly database: string;
};

/**
 * Parses a `postgres://` URL.
 *
 * @param url - Connection URL
 * @returns User, password, host, port, and database
 */
export function parsePostgresUrl(url: string): PostgresUrlParts {
  const parsed = new URL(url);
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname,
    port: parsed.port,
    database: parsed.pathname.replace(/^\//, ""),
  };
}

/**
 * Builds a `postgres://` URL.
 *
 * @param parts - User, password, host, port, and database
 * @returns A connection URL
 */
export function formatPostgresUrl(parts: PostgresUrlParts): string {
  const user = encodeURIComponent(parts.user);
  const password = encodeURIComponent(parts.password);
  return `postgres://${user}:${password}@${parts.host}:${parts.port}/${parts.database}`;
}
