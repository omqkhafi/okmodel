/**
 * Starts and stops the Postgres topology.
 *
 * Usage:
 *   bun ./packages/harness/src/docker-cli.ts up
 *   bun ./packages/harness/src/docker-cli.ts down
 *
 * Host ports default to 55432–55434. When one of those is already taken,
 * `up` binds three free ports instead and, on GitHub Actions, records them
 * in `GITHUB_ENV` so the next step connects to the same topology.
 */

import { type EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { postgresVersionFromEnv } from "./version.js";

const composeFile = join(import.meta.dir, "..", "docker", "compose.yml");
const repoRoot = join(import.meta.dir, "..", "..", "..");

/** Published host ports for the primary and the two replicas. */
export type TopologyPorts = {
  primary: string;
  replicaA: string;
  replicaB: string;
};

/** One ephemeral port held until every port in the set has been chosen. */
type Reservation = {
  port: number;
  close: () => Promise<void>;
};

const DEFAULT_PORTS: TopologyPorts = {
  primary: "55432",
  replicaA: "55433",
  replicaB: "55434",
};

/**
 * Host ports for one `docker compose up`.
 *
 * Keeps 55432–55434 when each can be bound. When any of them is taken,
 * reserves three ephemeral ports and releases them before returning, so
 * Docker can bind the same numbers. An explicit `OKM_*_PORT` is left as
 * the caller set it.
 *
 * @param env - Environment that may already name the ports
 * @param canBind - Reports whether a host port is free. Tests pass a stub
 * @param reserve - Allocates one ephemeral port. Tests pass a stub
 * @returns The ports compose should publish
 */
export async function chooseTopologyPorts(
  env: Readonly<Record<string, string | undefined>> = process.env,
  canBind: (port: number) => Promise<boolean> = portIsFree,
  reserve: () => Promise<Reservation> = reserveEphemeralPort,
): Promise<TopologyPorts> {
  const explicit = portsFromEnv(env);
  if (explicit !== undefined) return explicit;
  const defaults = [DEFAULT_PORTS.primary, DEFAULT_PORTS.replicaA, DEFAULT_PORTS.replicaB];
  const free = await Promise.all(defaults.map((port) => canBind(Number(port))));
  if (free.every(Boolean)) return { ...DEFAULT_PORTS };
  const held: Reservation[] = [];
  try {
    held.push(await reserve());
    held.push(await reserve());
    held.push(await reserve());
    const primary = held[0];
    const replicaA = held[1];
    const replicaB = held[2];
    if (primary === undefined || replicaA === undefined || replicaB === undefined) {
      throw new Error("could not reserve three host ports");
    }
    return {
      primary: String(primary.port),
      replicaA: String(replicaA.port),
      replicaB: String(replicaB.port),
    };
  } finally {
    await Promise.all(held.map((item) => item.close()));
  }
}

/**
 * Records the ports for later steps in the same GitHub Actions job.
 *
 * Does nothing when `GITHUB_ENV` is unset, which is the local case.
 *
 * @param ports - Ports compose was started with
 * @param env - Environment whose `GITHUB_ENV` is the file to append
 */
export function publishTopologyPorts(
  ports: TopologyPorts,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const file = env.GITHUB_ENV;
  if (file === undefined || file.length === 0) return;
  appendFileSync(
    file,
    `OKM_PRIMARY_PORT=${ports.primary}\nOKM_REPLICA_A_PORT=${ports.replicaA}\nOKM_REPLICA_B_PORT=${ports.replicaB}\n`,
  );
}

function portsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): TopologyPorts | undefined {
  const primary = env.OKM_PRIMARY_PORT;
  const replicaA = env.OKM_REPLICA_A_PORT;
  const replicaB = env.OKM_REPLICA_B_PORT;
  if (primary === undefined && replicaA === undefined && replicaB === undefined) return undefined;
  return {
    primary: primary ?? DEFAULT_PORTS.primary,
    replicaA: replicaA ?? DEFAULT_PORTS.replicaA,
    replicaB: replicaB ?? DEFAULT_PORTS.replicaB,
  };
}

/**
 * Listens on `0.0.0.0` so a port Docker cannot publish is reported as taken.
 *
 * @param port - Host port
 * @returns Whether the bind succeeded
 */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    // @types/node 26 types net.Server as implementing EventEmitter without
    // merging the methods, so the checker does not see once.
    (server as unknown as EventEmitter).once("error", () => resolve(false));
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Binds port 0 and keeps the socket until `close` runs.
 *
 * The socket stays open so the next reservation cannot receive the same port.
 *
 * @returns A held ephemeral port
 */
function reserveEphemeralPort(): Promise<Reservation> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    (server as unknown as EventEmitter).once("error", reject);
    server.listen({ port: 0, host: "0.0.0.0", exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve a host port"));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function composeEnv(base: NodeJS.ProcessEnv, ports: TopologyPorts): NodeJS.ProcessEnv {
  return {
    ...base,
    OKM_PRIMARY_PORT: ports.primary,
    OKM_REPLICA_A_PORT: ports.replicaA,
    OKM_REPLICA_B_PORT: ports.replicaB,
  };
}

type ComposeResult = { code: number; stderr: string };

async function runCompose(args: string[], env: NodeJS.ProcessEnv): Promise<ComposeResult> {
  const proc = Bun.spawn(["docker", "compose", "-f", composeFile, "-p", "okmodel", ...args], {
    cwd: repoRoot,
    env,
    stdout: "inherit",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  if (stderr.length > 0) process.stderr.write(stderr);
  return { code: await proc.exited, stderr };
}

const upArgs = ["up", "-d", "--wait", "--wait-timeout", "300"];
const downArgs = ["down", "-v", "--remove-orphans"];

/**
 * Runs `docker compose` for the topology.
 */
async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "up" && command !== "down") {
    console.error("[db] Usage: bun ./packages/harness/src/docker-cli.ts up|down");
    process.exit(2);
  }
  const version = postgresVersionFromEnv();
  const env = { ...process.env, POSTGRES_VERSION: version };
  if (command === "down") {
    const stopped = await runCompose(downArgs, env);
    if (stopped.code !== 0) throw new Error(`docker compose down exited ${String(stopped.code)}`);
    return;
  }
  let ports = await chooseTopologyPorts(env);
  publishTopologyPorts(ports, env);
  let started = await runCompose(upArgs, composeEnv(env, ports));
  if (started.code !== 0 && hostPortTaken(started.stderr) && portsFromEnv(env) === undefined) {
    console.error("[db] a host port was taken. Stopping and binding three free ports.");
    await runCompose(downArgs, env);
    ports = await chooseTopologyPorts({}, async () => false);
    publishTopologyPorts(ports, env);
    started = await runCompose(upArgs, composeEnv(env, ports));
  }
  if (started.code !== 0) throw new Error(`docker compose up exited ${String(started.code)}`);
  console.error(
    `[db] Postgres ${version} topology is up (primary ${ports.primary}, replicas ${ports.replicaA} and ${ports.replicaB}).`,
  );
}

function hostPortTaken(stderr: string): boolean {
  return stderr.includes("address already in use");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("[db]", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
