/**
 * Connections for the project tracker.
 *
 * One URL is the primary on its own. A primary with named replicas routes
 * reads to the replicas and keeps read-your-writes inside the client.
 */

import { connect, type PostgresConnectOptions } from "okmodel/pg/postgresjs";

import app from "./schema.js";

/** Options every app connection accepts besides the schema. */
export type AppConnectOptions = Omit<PostgresConnectOptions<typeof app>, "schema">;

/** A hot standby the client may read from. */
export type ReplicaEndpoint = {
  /** The name `onRoute` reports, such as `a`. */
  readonly name: string;
  readonly url: string;
};

/**
 * Connects to one database.
 *
 * @param url - Primary URL
 * @param options - Driver and routing options
 * @returns The client for the app schema
 */
export function openPrimary(url: string, options: AppConnectOptions = {}) {
  return connect(url, { ...options, schema: app });
}

/**
 * Connects to a primary and its hot standbys.
 *
 * @param primary - Primary URL
 * @param replicas - Standbys, each with a name
 * @param options - Driver and routing options, such as `onRoute`
 * @returns The routed client for the app schema
 */
export function openTopology(
  primary: string,
  replicas: readonly ReplicaEndpoint[],
  options: AppConnectOptions = {},
) {
  return connect(
    { primary, replicas: replicas.map((replica) => ({ url: replica.url, name: replica.name })) },
    { ...options, schema: app },
  );
}

/** A client for the app schema, from {@link openPrimary} or `okmodel/testing`. */
export type AppDb = ReturnType<typeof openPrimary>;

/** A client scoped to one workspace. */
export type WorkspaceDb = ReturnType<AppDb["for"]>;
