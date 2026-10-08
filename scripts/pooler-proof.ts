/**
 * Proves the apply pid probe (D215) refuses a transaction-mode pooler.
 *
 * Starts pgbouncer (binary on PATH) fronting the topology primary with
 * `server_round_robin`, warms two backends concurrently so sequential
 * statements strictly alternate servers, then runs `applyTarget` through the
 * pooler and requires OKM1854. The pooler listens on 127.0.0.1:6433, which
 * the static pooler check does not flag, so only the pid probe can refuse.
 *
 *   REQUIRE_DOCKER=1 bun ./scripts/pooler-proof.ts
 *
 * Needs the topology up (`bun run db:up`) and a pgbouncer 1.21 or newer
 * binary (CI installs it with apt; macOS: `brew install pgbouncer`).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

import { OkmError } from "../src/contracts/error.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { repoRoot } from "./root.js";

/** Pooler listen port. 6432 would trip the static pooler check; this one does not. */
export const POOLER_PORT = 6433;

/**
 * Renders the pgbouncer config fronting one Postgres.
 *
 * @param host - Primary host
 * @param port - Primary port
 * @param dir - Directory for the auth file
 * @returns The ini text
 */
export function poolerConfig(host: string, port: string, dir: string): string {
  return [
    "[databases]",
    `okm = host=${host} port=${port} dbname=okm`,
    "[pgbouncer]",
    "listen_addr = 127.0.0.1",
    `listen_port = ${String(POOLER_PORT)}`,
    "auth_type = trust",
    `auth_file = ${join(dir, "users.txt")}`,
    "pool_mode = transaction",
    "server_round_robin = 1",
    "",
  ].join("\n");
}

if (import.meta.main) {
  await poolerProof(repoRoot());
}

/**
 * Runs the pooler refusal proof end to end.
 *
 * @param _root - Repository root (reserved for future fixtures)
 */
export async function poolerProof(_root: string): Promise<void> {
  const version = await pgbouncerVersion();
  if (version === undefined) {
    throw new Error("pooler-proof: no pgbouncer binary on PATH (CI installs it with apt; macOS: brew install pgbouncer)");
  }
  if (version < 1.21) {
    throw new Error(`pooler-proof: pgbouncer ${String(version)} is older than the 1.21 round-robin setting`);
  }
  const primary = new URL(primaryUrl());
  const dir = mkdtempSync(join(tmpdir(), "okm-pooler-"));
  writeFileSync(join(dir, "users.txt"), '"okm" ""\n');
  writeFileSync(join(dir, "pgbouncer.ini"), poolerConfig(primary.hostname, primary.port, dir));
  const pgbouncer = Bun.spawn(["pgbouncer", join(dir, "pgbouncer.ini")], {
    cwd: dir,
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitForPooler();
    await warmTwoBackends();
    await expectPidRefusal();
    console.error("[pooler-proof] apply through pgbouncer refused with OKM1854");
  } finally {
    pgbouncer.kill();
    await pgbouncer.exited.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pgbouncerVersion(): Promise<number | undefined> {
  try {
    const proc = Bun.spawn(["pgbouncer", "--version"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const match = /PgBouncer (\d+)\.(\d+)/.exec(out);
    if (match?.[1] === undefined || match?.[2] === undefined) return undefined;
    return Number(match[1]) + Number(match[2]) / 100;
  } catch {
    return undefined;
  }
}

async function waitForPooler(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port: POOLER_PORT,
        socket: {
          data() {},
          error() {},
        },
      });
      socket.end();
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error("pooler-proof: pgbouncer did not open 127.0.0.1:6433 within 10 seconds");
}

/**
 * Opens two concurrent sleepers so the pool holds two backends.
 *
 * One client alone only ever creates one server connection, on which
 * sequential statements land on the same pid. Two concurrent statements
 * force two servers; round-robin then alternates every later statement.
 */
async function warmTwoBackends(): Promise<void> {
  const url = poolerUrl();
  const first = postgres(url, { max: 1 });
  const second = postgres(url, { max: 1 });
  try {
    await Promise.all([first`select pg_sleep(2)`, second`select pg_sleep(2)`]);
  } finally {
    await Promise.all([first.end(), second.end()]);
  }
  const check = postgres(url, { max: 1 });
  try {
    const one = await check`select pg_backend_pid() as pid`;
    const two = await check`select pg_backend_pid() as pid`;
    if (String(one[0]?.pid) === String(two[0]?.pid)) {
      throw new Error(
        "pooler-proof: the pooler did not rotate backends; sequential statements share one pid",
      );
    }
  } finally {
    await check.end();
  }
}

function poolerUrl(): string {
  return "postgres://okm:okm@127.0.0.1:6433/okm";
}

async function expectPidRefusal(): Promise<void> {
  const schemaName = `poolproof_${String(process.pid)}`;
  const direct = postgres(primaryUrl(), { max: 1 });
  try {
    await direct.unsafe(`create schema ${schemaName}`);
  } finally {
    await direct.end();
  }
  const migration: StoredMigration = {
    id: "0001_items",
    catalogHash: "hash-pooler-proof",
    steps: [{ sql: `create table ${schemaName}.items (id integer)`, class: "expand", action: "ddl", lock: "ACCESS EXCLUSIVE", transactional: true }],
  };
  let error: unknown;
  try {
    await applyTarget({
      url: poolerUrl(),
      target: schemaName,
      protected: false,
      searchPath: schemaName,
      migrations: [migration],
    });
  } catch (thrown) {
    error = thrown;
  } finally {
    const cleanup = postgres(primaryUrl(), { max: 1 });
    try {
      await cleanup.unsafe(`drop schema if exists ${schemaName} cascade`);
    } finally {
      await cleanup.end();
    }
  }
  if (!(error instanceof OkmError) || error.code !== "OKM1854") {
    throw new Error(
      `pooler-proof: expected the OKM1854 pid refusal, got ${error instanceof Error ? error.message : "an apply that succeeded"}`,
    );
  }
}
