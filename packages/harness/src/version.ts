/**
 * Postgres majors the suite runs.
 *
 * The floor is 13: `gen_random_uuid()` is built in from that version. Identity
 * columns exist from 10. `uuidv7()` exists on 18, which stays in the list.
 */
export const POSTGRES_VERSIONS = ["13", "14", "15", "16", "17", "18"] as const;

/** A Postgres major the harness knows how to run. */
export type PostgresVersion = (typeof POSTGRES_VERSIONS)[number];

/**
 * Accepts a Postgres major from 13 through 18.
 *
 * @param version - Major version string, for example `17`
 * @returns The same version when it is in range
 */
export function assertPostgresVersion(version: string): PostgresVersion {
  if ((POSTGRES_VERSIONS as readonly string[]).includes(version)) {
    return version as PostgresVersion;
  }
  throw new Error(`Postgres version '${version}' is outside 13–18.`);
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
