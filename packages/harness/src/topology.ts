/** Streaming replica in the compose topology. */
export type ReplicaName = "a" | "b";

const USER = "okm";
const PASSWORD = "okm";
const DATABASE = "okm";
const HOST = "127.0.0.1";

/**
 * Connection URL for the primary.
 *
 * The published port defaults to 55432 and follows `OKM_PRIMARY_PORT`.
 *
 * @param env - Environment used for the port override
 * @returns A `postgres://` URL
 */
export function primaryUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return postgresUrl(env.OKM_PRIMARY_PORT ?? "55432");
}

/**
 * Connection URL for one streaming replica.
 *
 * Replica `a` defaults to port 55433 (`OKM_REPLICA_A_PORT`). Replica `b`
 * defaults to 55434 (`OKM_REPLICA_B_PORT`).
 *
 * @param replica - Which replica
 * @param env - Environment used for the port override
 * @returns A `postgres://` URL
 */
export function replicaUrl(
  replica: ReplicaName,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const port =
    replica === "a" ? (env.OKM_REPLICA_A_PORT ?? "55433") : (env.OKM_REPLICA_B_PORT ?? "55434");
  return postgresUrl(port);
}

function postgresUrl(port: string): string {
  return `postgres://${USER}:${PASSWORD}@${HOST}:${port}/${DATABASE}`;
}
