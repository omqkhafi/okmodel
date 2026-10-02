/**
 * Private test harness barrel.
 *
 * This file does not re-export Postgres, PGlite, or the Docker gate. Importing
 * it must not pull those npm packages into a bundle. Open a driver from
 * `./postgres.js` or `./pglite.js` directly.
 */

export { compareLsn, lsnToBigInt } from "./lsn.js";
export { isolatedSchemaName } from "./schema-name.js";
export { primaryUrl, replicaUrl, type ReplicaName } from "./topology.js";
export {
  assertPostgresVersion,
  POSTGRES_VERSIONS,
  postgresVersionFromEnv,
  type PostgresVersion,
} from "./version.js";
