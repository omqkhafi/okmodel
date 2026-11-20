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
 * Accepts a Postgres major.
 *
 * A major in {@link POSTGRES_VERSIONS} is the tested list. Any other integer
 * major is accepted too. A value that is not an integer major throws.
 *
 * @param version - Major version string, for example `17`
 * @returns The same version
 */
export function assertPostgresVersion(version: string): string {
  if ((POSTGRES_VERSIONS as readonly string[]).includes(version)) return version;
  if (/^[1-9]\d*$/.test(version)) return version;
  const oldest = POSTGRES_VERSIONS[0];
  const newest = POSTGRES_VERSIONS[POSTGRES_VERSIONS.length - 1];
  throw new Error(`Postgres version '${version}' is outside ${oldest}–${newest}.`);
}

/**
 * Reads `POSTGRES_VERSION`, defaulting to 17.
 *
 * An integer major outside {@link POSTGRES_VERSIONS} runs, and this prints
 * one line. CI matrices still name the tested majors.
 *
 * @param env - Environment to read. Defaults to `process.env`
 * @returns The selected major
 */
export function postgresVersionFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const version = assertPostgresVersion(env.POSTGRES_VERSION ?? "17");
  if (!(POSTGRES_VERSIONS as readonly string[]).includes(version)) {
    const oldest = POSTGRES_VERSIONS[0];
    const newest = POSTGRES_VERSIONS[POSTGRES_VERSIONS.length - 1];
    console.error(
      `Postgres ${version} is outside the tested range ${oldest} to ${newest}; running it.`,
    );
  }
  return version;
}
