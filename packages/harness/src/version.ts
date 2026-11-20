/**
 * Postgres majors the suite runs.
 *
 * The floor is 15. Postgres 13 is past end of life, 14 ends in November 2026,
 * and 15 is where later features can land. `uuidv7()` exists on 18, which
 * stays in the list. 19 is the newest major the suite runs.
 */
export const POSTGRES_VERSIONS = ["15", "16", "17", "18", "19"] as const;

/** A Postgres major the harness knows how to run. */
export type PostgresVersion = (typeof POSTGRES_VERSIONS)[number];

/**
 * Accepts a Postgres major from {@link POSTGRES_VERSIONS}.
 *
 * @param version - Major version string, for example `17`
 * @returns The same version when it is in range
 */
export function assertPostgresVersion(version: string): PostgresVersion {
  if ((POSTGRES_VERSIONS as readonly string[]).includes(version)) {
    return version as PostgresVersion;
  }
  const oldest = POSTGRES_VERSIONS[0];
  const newest = POSTGRES_VERSIONS[POSTGRES_VERSIONS.length - 1];
  throw new Error(`Postgres version '${version}' is outside ${oldest}–${newest}.`);
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
