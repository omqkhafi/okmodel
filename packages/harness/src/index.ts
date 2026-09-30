/**
 * Private test harness. Nothing here is part of the published `okmodel` package.
 */

export {
  decideDocker,
  dockerDaemonRunning,
  postgresDecision,
  type DockerDecision,
} from "./docker-gate.js";
export { compareLsn, lsnToBigInt } from "./lsn.js";
export { openPglite, withPglite, withPgliteSchema } from "./pglite.js";
export { openPostgres, postgresReachable, withPostgres, withPostgresSchema } from "./postgres.js";
export {
  pauseWalReplay,
  readInsertLsn,
  readReplayLsn,
  resumeWalReplay,
  waitForReplayLsn,
} from "./replication.js";
export { isolatedSchemaName } from "./schema-name.js";
export { primaryUrl, replicaUrl, type ReplicaName } from "./topology.js";
export {
  assertPostgresVersion,
  POSTGRES_VERSIONS,
  postgresVersionFromEnv,
  type PostgresVersion,
} from "./version.js";
