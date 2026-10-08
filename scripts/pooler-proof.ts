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
 * Needs the topology up (`bun run db:up`) and a pgbouncer 1.26 or newer
 * binary: older releases reuse one server per client (LIFO), so sequential
 * statements never alternate and the rotation check fails. CI installs 1.26
 * from apt.postgresql.org (the Ubuntu archive is still 1.22); macOS:
 * `brew install pgbouncer`.
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
 * The server connection carries the primary password parsed from the URL:
 * client `trust` only covers the client side, and a server with password
 * authentication rejects an empty one.
 *
 * @param host - Primary host
 * @param port - Primary port
 * @param user - Primary user, forced for every server connection
 * @param password - Primary password, percent-decoded
 * @param dir - Directory for the auth file
 * @returns The ini text
 */
export function poolerConfig(
  host: string,
  port: string,
  user: string,
  password: string,
  dir: string,
): string {
  const secret = password === "" ? "" : ` password=${password}`;
  // `user=` is load-bearing, not cosmetic: without it pgbouncer logs into
  // the server as the client user but takes the server password from
  // auth_file (empty under trust) instead of this database line, and the
  // SCRAM login fails. With `user=` there is one pool, which is all the
  // proof needs.
  return [
    "[databases]",
    `okm = host=${host} port=${port} dbname=okm user=${user}${secret}`,
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

/** The pgbouncer child and its config dir, for the exit hook when the proof times out. */
let activeChild: Bun.Subprocess | undefined;
let activeDir: string | undefined;

process.on("exit", () => {
  // Plain `bun` runs exit hooks. A timed-out proof leaves pgbouncer and its
  // temp dir behind; the process exit is the backstop that reaps them.
  try {
    activeChild?.kill();
  } catch {
    // Already gone.
  }
  if (activeDir !== undefined) rmSync(activeDir, { recursive: true, force: true });
});

if (import.meta.main) {
  const done = poolerProof(repoRoot());
  // The proof must fail, never hang: a broken pooler can park apply on a lock.
  // The timer is cleared on settle: a pending timer keeps the event loop
  // alive, which would park a finished proof here for the full two minutes.
  const timer = setTimeout(() => {
    console.error("pooler-proof: timed out after 120 seconds");
    process.exit(1);
  }, 120_000);
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the pooler refusal proof end to end.
 *
 * @param _root - Repository root (reserved for future fixtures)
 */
export async function poolerProof(_root: string): Promise<void> {
  const version = await pgbouncerVersion();
  if (version === undefined) {
    throw new Error(
      "pooler-proof: no pgbouncer binary on PATH (CI installs 1.26 from apt.postgresql.org; macOS: brew install pgbouncer)",
    );
  }
  if (version.major !== 1 || version.minor < 26) {
    throw new Error(
      `pooler-proof: pgbouncer ${String(version.major)}.${String(version.minor)} rotates per client, not per statement; the proof needs 1.26 or newer`,
    );
  }
  const primary = new URL(primaryUrl());
  const dir = mkdtempSync(join(tmpdir(), "okm-pooler-"));
  writeFileSync(join(dir, "users.txt"), '"okm" ""\n');
  writeFileSync(
    join(dir, "pgbouncer.ini"),
    poolerConfig(
      primary.hostname,
      primary.port,
      decodeURIComponent(primary.username),
      decodeURIComponent(primary.password),
      dir,
    ),
  );
  const pgbouncer = Bun.spawn(["pgbouncer", join(dir, "pgbouncer.ini")], {
    cwd: dir,
    stdout: "ignore",
    stderr: "pipe",
  });
  activeChild = pgbouncer;
  activeDir = dir;
  try {
    await waitForPooler(pgbouncer);
    console.error("[pooler-proof] pooler is listening; warming two backends");
    await warmTwoBackends();
    console.error("[pooler-proof] backends rotate; running apply for the pid refusal");
    await expectPidRefusal();
    console.error("[pooler-proof] apply through pgbouncer refused with OKM1854");
  } finally {
    activeChild = undefined;
    activeDir = undefined;
    pgbouncer.kill();
    await pgbouncer.exited.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pgbouncerVersion(): Promise<{ major: number; minor: number } | undefined> {
  try {
    const proc = Bun.spawn(["pgbouncer", "--version"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const match = /PgBouncer (\d+)\.(\d+)/.exec(out);
    if (match?.[1] === undefined || match?.[2] === undefined) return undefined;
    return { major: Number(match[1]), minor: Number(match[2]) };
  } catch {
    return undefined;
  }
}

async function waitForPooler(pgbouncer: Bun.Subprocess): Promise<void> {
  // A pgbouncer that cannot bind (stale daemon, clashing service) exits at
  // once; surfacing that beats ten seconds of refused connections.
  const exited = pgbouncer.exited.then(async () => {
    const stderr = pgbouncer.stderr;
    const text =
      stderr instanceof ReadableStream ? await new Response(stderr).text().catch(() => "") : "";
    const last = text.trim().split("\n").pop() ?? "";
    throw new Error(
      `pooler-proof: pgbouncer exited before opening 127.0.0.1:${String(POOLER_PORT)}${last === "" ? "" : `: ${last}`}`,
    );
  });
  await Promise.race([pollPooler(), exited]);
}

async function pollPooler(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // No `error` handler: a refused connection must reject so the loop can
    // retry. With one, Bun routes the failure to the handler and this
    // await never settles.
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: POOLER_PORT,
      socket: {
        data() {},
      },
    }).catch(() => undefined);
    if (socket !== undefined) {
      socket.end();
      return;
    }
    await Bun.sleep(200);
  }
  throw new Error(
    `pooler-proof: pgbouncer did not open 127.0.0.1:${String(POOLER_PORT)} within 10 seconds`,
  );
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
  const first = postgres(url, { max: 1, connect_timeout: 10 });
  const second = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    await Promise.all([first`select pg_sleep(2)`, second`select pg_sleep(2)`]);
  } finally {
    await Promise.all([first.end(), second.end()]);
  }
  const check = postgres(url, { max: 1, connect_timeout: 10 });
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
  const direct = postgres(primaryUrl(), { max: 1, connect_timeout: 10 });
  try {
    await direct.unsafe(`create schema ${schemaName}`);
  } finally {
    await direct.end();
  }
  const migration: StoredMigration = {
    id: "0001_items",
    catalogHash: "hash-pooler-proof",
    steps: [
      {
        sql: `create table ${schemaName}.items (id integer)`,
        class: "expand",
        action: "ddl",
        lock: "ACCESS EXCLUSIVE",
        transactional: true,
      },
    ],
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
    const cleanup = postgres(primaryUrl(), { max: 1, connect_timeout: 10 });
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
