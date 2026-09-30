/** Postgres majors the topology can start. */
export const POSTGRES_VERSIONS = ["15", "16", "17", "18"] as const;

/** A Postgres major the harness knows how to run. */
export type PostgresVersion = (typeof POSTGRES_VERSIONS)[number];

/**
 * Accepts a Postgres major from 15 through 18.
 *
 * @param version - Major version string, for example `17`
 * @returns The same version when it is in range
 */
export function assertPostgresVersion(version: string): PostgresVersion {
  if ((POSTGRES_VERSIONS as readonly string[]).includes(version)) {
    return version as PostgresVersion;
  }
  throw new Error(`Postgres version '${version}' is outside 15–18.`);
}

/**
 * Reads `POSTGRES_VERSION`, defaulting to 17.
 *
 * @param env - Environment to read. Defaults to `process.env`
 * @returns The selected major
 */
export function postgresVersionFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PostgresVersion {
  return assertPostgresVersion(env.POSTGRES_VERSION ?? "17");
}
