/**
 * `close` is idempotent, `await using` ends the pool, and a finished
 * postgres.js script does not wait out an idle timer.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DriverPool, ExecuteResult } from "../src/contracts/driver.js";
import { POSTGRESJS_CAPABILITIES } from "../src/adapters/capabilities.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { repoRoot } from "../scripts/root.js";
import { createClient } from "../src/runtime/client.js";

const notes = table("notes", { title: t.text() });
const app = schema({ tables: [notes] });
const root = repoRoot();
const gate = await loadPostgresGate();

const VERSION: ExecuteResult = {
  rows: [["170000", "PostgreSQL 17.0", null]],
  count: 1,
  notices: [],
};

test("close is idempotent and await using calls it once", async () => {
  let closes = 0;
  const pool = fakePool(() => {
    closes += 1;
  });
  const db = createClient(app, pool, { ownsPool: true });
  await db.connected;
  await db.close();
  await db.close();
  expect(closes).toBe(1);

  closes = 0;
  {
    await using scoped = createClient(app, pool, { ownsPool: true });
    await scoped.connected;
  }
  expect(closes).toBe(1);
});

test("a client that adopted a pool does not close it", async () => {
  let closes = 0;
  const pool = fakePool(() => {
    closes += 1;
  });
  const db = createClient(app, pool, { ownsPool: false });
  await db.connected;
  await db.close();
  const dispose = asyncDispose(db);
  expect(dispose).toBeDefined();
  await dispose?.();
  expect(closes).toBe(0);
});

test("pglite exits without close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-pglite-"));
  const script = `import { PGlite } from ${JSON.stringify(pgliteEntry())};
const db = new PGlite("memory://");
await db.waitReady;
await db.query("select 1");
`;
  writeFileSync(join(dir, "run.mjs"), script);
  const bun = await runWithin(["bun", "run.mjs"], dir, 8_000);
  const node = await runWithin(["node", "run.mjs"], dir, 8_000);
  expect(bun).toBeLessThan(8_000);
  expect(node).toBeLessThan(8_000);
});

postgresTest(
  gate,
  "a live process keeps the postgres connection",
  async () => {
    const pool = open({ url: primaryUrl() });
    try {
      const first = await pool.execute("select pg_backend_pid()");
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const second = await pool.execute("select pg_backend_pid()");
      expect(second.rows[0]?.[0]).toBe(first.rows[0]?.[0]);
      expect(second.rows[0]?.[0]).not.toBe(null);
    } finally {
      await pool.close();
    }
  },
  15_000,
);

postgresTest(
  gate,
  "a finished postgres script exits on bun and node",
  async () => {
    const dist = join(root, "dist", "runtime", "pg", "postgresjs.js");
    const dir = mkdtempSync(join(tmpdir(), "okm-exit-"));
    writeFileSync(join(dir, "bun.ts"), bunScript());
    writeFileSync(join(dir, "node.mjs"), nodeScript(dist));
    const bun = await runWithin(["bun", join(dir, "bun.ts")], dir, 5_000);
    const node = await runWithin(["node", join(dir, "node.mjs")], dir, 5_000);
    expect(bun).toBeLessThan(5_000);
    expect(node).toBeLessThan(5_000);
  },
  20_000,
);

/**
 * A pool whose only job is the startup check and counting closes.
 *
 * @param onClose - Called from `close`
 * @returns The pool
 */
function fakePool(onClose: () => void): DriverPool {
  return {
    capabilities: POSTGRESJS_CAPABILITIES,
    execute: () => Promise.resolve(VERSION),
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => {
      onClose();
      return Promise.resolve();
    },
  };
}

/**
 * The dispose method, when the runtime defines the symbol.
 *
 * @param client - A connected client
 * @returns The method, or undefined when the symbol is absent
 */
function asyncDispose(client: object): (() => Promise<void>) | undefined {
  const symbol = (Symbol as { readonly asyncDispose?: symbol }).asyncDispose;
  if (symbol === undefined) return undefined;
  const value = (client as Record<symbol, unknown>)[symbol];
  return typeof value === "function" ? (value as () => Promise<void>) : undefined;
}

/**
 * Absolute entry for PGlite, so a script outside the repo can import it.
 *
 * @returns The package entry path
 */
function pgliteEntry(): string {
  return join(root, "node_modules", "@electric-sql", "pglite", "dist", "index.js");
}

/**
 * Bun script that connects through the TypeScript source and does not close.
 *
 * @returns The script
 */
function bunScript(): string {
  return `import { connect } from ${JSON.stringify(join(root, "src/runtime/pg/postgresjs.ts"))};
import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};

const notes = table("notes", { title: t.text() });
const app = schema({ tables: [notes] });
const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");
const db = connect(url, { schema: app });
await db.connected;
`;
}

/**
 * Node script that connects through the built entry and does not close.
 *
 * @param dist - Built `okmodel/pg/postgresjs` entry
 * @returns The script
 */
function nodeScript(dist: string): string {
  const pg = join(root, "dist", "dialects", "pg", "index.js");
  return `import { connect } from ${JSON.stringify(dist)};
import { schema, table, t } from ${JSON.stringify(pg)};

const notes = table("notes", { title: t.text() });
const app = schema({ tables: [notes] });
const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is not set");
const db = connect(url, { schema: app });
await db.connected;
`;
}

/**
 * Runs a command and returns how long it took to exit.
 *
 * @param args - Command and arguments
 * @param cwd - Working directory
 * @param limitMs - Kill the process after this long
 * @returns Elapsed milliseconds
 */
async function runWithin(args: readonly string[], cwd: string, limitMs: number): Promise<number> {
  const started = Date.now();
  let killed = false;
  const proc = Bun.spawn([...args], {
    cwd,
    env: { ...process.env, DATABASE_URL: primaryUrl() },
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => {
    killed = true;
    proc.kill();
  }, limitMs);
  const code = await proc.exited;
  clearTimeout(killer);
  const elapsed = Date.now() - started;
  if (killed) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${args.join(" ")} still alive after ${String(limitMs)}ms\n${stderr}`);
  }
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    throw new Error(`${args.join(" ")} exited ${String(code)}\n${stderr}\n${stdout}`);
  }
  return elapsed;
}
