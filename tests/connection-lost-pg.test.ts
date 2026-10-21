/**
 * A backend that dies inside `tx()` must not crash the process.
 *
 * postgres.js queues a small write with `setImmediate`. After the socket is
 * null, `nextWrite` throws off the query promise. A lost reserved connection
 * is not written again, so that timer is never scheduled. `setImmediate`
 * stays the function the process installed.
 */

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";

const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });
const app = schema({ tables: [notes] });

const gate = await loadPostgresGate();

type Driver = "postgresjs" | "pg" | "bun";
type Db = {
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  notes: { find(options?: { limit?: number }): Promise<readonly unknown[]> };
  close(): Promise<void>;
};
type Tx = {
  notes: {
    find(options?: { limit?: number }): Promise<readonly unknown[]>;
    insert(row: { id: number; title: string }): Promise<unknown>;
  };
};

const connectors: Record<Driver, (url: string) => Db> = {
  postgresjs: (url) => connectPostgres(url, { schema: app, max: 1 }) as unknown as Db,
  pg: (url) => connectPg(url, { schema: app, max: 1 }) as unknown as Db,
  bun: (url) => connectBun(url, { schema: app, max: 1 }) as unknown as Db,
};

for (const driver of ["postgresjs", "pg", "bun"] as const) {
  postgresTest(
    gate,
    `${driver}: a lost backend inside tx does not escape the promise`,
    async () => {
      if (driver === "bun" && (typeof Bun === "undefined" || typeof Bun.SQL !== "function")) return;
      const database = await createIsolatedDatabase();
      const admin = openPostgres(database.url);
      const crashes: unknown[] = [];
      const onUncaught = (error: unknown): void => {
        crashes.push(error);
      };
      const onRejection = (error: unknown): void => {
        crashes.push(error);
      };
      process.on("uncaughtException", onUncaught);
      process.on("unhandledRejection", onRejection);
      const warnings: string[] = [];
      const onWarning = (warning: Error): void => {
        warnings.push(warning.name);
      };
      process.on("warning", onWarning);
      try {
        await admin.unsafe("create table notes (id int primary key, title text not null)");
        await admin.unsafe(
          `create function okm_delay() returns trigger language plpgsql as $$ begin perform pg_sleep(8); return new; end $$`,
        );
        await admin.unsafe(
          `create constraint trigger okm_delay after insert on notes deferrable initially deferred for each row execute function okm_delay()`,
        );
        const db = connectors[driver](database.url);
        const schedule = globalThis.setImmediate;
        try {
          if (driver === "postgresjs") {
            await db.tx(async (tx) => {
              await tx.notes.find({ limit: 1 });
            });
            expect(globalThis.setImmediate).toBe(schedule);
          }
          await expectLost(db, () => killIdle(admin), "unavailable");
          if (driver === "postgresjs") expect(globalThis.setImmediate).toBe(schedule);
          await db.notes.find({ limit: 1 });

          await admin.unsafe("begin");
          await admin.unsafe("lock table notes in access exclusive mode");
          const waiting = rejection(
            db.tx(async (tx) => {
              await tx.notes.find({ limit: 1 });
            }),
          );
          await Bun.sleep(300);
          await killApp(admin);
          const mid = await waiting;
          expect(kindOf(mid)).toBe("unavailable");
          await admin.unsafe("rollback");
          await db.notes.find({ limit: 1 });

          const committing = rejection(
            db.tx(async (tx) => {
              await tx.notes.insert({ id: 7, title: "commit" });
            }),
          );
          await killWhen(admin, "commit");
          const commit = await committing;
          expect(codeOf(commit)).toBe("OKM1401");
          expect(kindOf(commit)).toBe("outcome_unknown");
          await db.notes.find({ limit: 1 });
        } finally {
          await db.close();
        }
        if (driver === "postgresjs") expect(globalThis.setImmediate).toBe(schedule);
        await Bun.sleep(50);
        expect(crashes).toEqual([]);
        expect(warnings).not.toContain("MaxListenersExceededWarning");
      } finally {
        process.off("warning", onWarning);
        process.off("uncaughtException", onUncaught);
        process.off("unhandledRejection", onRejection);
        await admin.unsafe("rollback").catch(() => undefined);
        await admin.end({ timeout: 5 });
        await database.close();
      }
    },
    90_000,
  );
}

postgresTest(
  gate,
  "postgres.js does not swallow a TypeError from the application's setImmediate",
  async () => {
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    try {
      await admin.unsafe("create table notes (id int primary key, title text not null)");
      expectTimer(Bun.spawnSync(["bun", "tests/connection-lost-timer.worker.ts", database.url]));
      const node = node24();
      if (node !== undefined) {
        const dir = mkdtempSync(join(tmpdir(), "okm-timer-"));
        const outfile = join(dir, "timer.mjs");
        const built = Bun.spawnSync(
          [
            "bun",
            "build",
            "tests/connection-lost-timer.worker.ts",
            "--target",
            "node",
            "--outfile",
            outfile,
          ],
          { cwd: process.cwd() },
        );
        expect(built.exitCode).toBe(0);
        expectTimer(Bun.spawnSync([node, outfile, database.url]));
      }
    } finally {
      await admin.end({ timeout: 5 });
      await database.close();
    }
  },
);

async function expectLost(db: Db, kill: () => Promise<void>, kind: string): Promise<void> {
  const error = await rejection(
    db.tx(async (tx) => {
      await tx.notes.find({ limit: 1 });
      await kill();
      await tx.notes.find({ limit: 1 });
    }),
  );
  expect(kindOf(error)).toBe(kind);
}

async function killIdle(admin: ReturnType<typeof openPostgres>): Promise<void> {
  await killWhen(admin, "idle");
}

async function killWhen(admin: ReturnType<typeof openPostgres>, needle: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await admin<{ pid: string; state: string; query: string }[]>`
      select pid::text as pid, state, query
      from pg_stat_activity
      where application_name = 'okmodel'
        and datname = current_database()
        and pid <> pg_backend_pid()
    `;
    const match = rows.find((row) => {
      if (needle === "idle") return row.state === "idle in transaction";
      const query = row.query.toLowerCase();
      return query.includes("commit") || query.includes("pg_sleep");
    });
    if (match !== undefined) {
      await admin.unsafe(`select pg_terminate_backend(${match.pid})`);
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`no okmodel backend matched ${needle}`);
}

async function killApp(admin: ReturnType<typeof openPostgres>): Promise<void> {
  const rows = await admin<{ pid: string }[]>`
    select pid::text as pid
    from pg_stat_activity
    where application_name = 'okmodel'
      and datname = current_database()
      and pid <> pg_backend_pid()
  `;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error("no okmodel backend");
  await admin.unsafe(`select pg_terminate_backend(${pid})`);
}

async function rejection(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
    return undefined;
  } catch (error) {
    return error;
  }
}

function kindOf(error: unknown): string | undefined {
  return error instanceof OkmError ? error.kind : undefined;
}

function codeOf(error: unknown): string | undefined {
  return error instanceof OkmError ? error.code : undefined;
}

/** A v24 Node binary, when this machine has one. CI without it still runs the Bun child. */
function node24(): string | undefined {
  const fromEnv = process.env.OKM_NODE24;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const home = process.env.HOME;
  if (home === undefined) return undefined;
  const root = join(home, ".nvm/versions/node");
  if (!existsSync(root)) return undefined;
  const latest = readdirSync(root)
    .filter((name) => name.startsWith("v24."))
    .sort()
    .at(-1);
  if (latest === undefined) return undefined;
  const bin = join(root, latest, "bin", "node");
  return existsSync(bin) ? bin : undefined;
}

function expectTimer(proc: ReturnType<typeof Bun.spawnSync>): void {
  const out = proc.stdout?.toString() ?? "";
  const err = proc.stderr?.toString() ?? "";
  if (proc.exitCode !== 0) {
    throw new Error(`timer child ${String(proc.exitCode)}\n${out}\n${err}`);
  }
  expect(out).toContain("schedule-same");
  expect(out).toContain("uncaught");
}

postgresTest(
  gate,
  "postgres.js rejects an idle lost connection inside tx, a savepoint, and before commit",
  async () => {
    const database = await createIsolatedDatabase();
    try {
      expectIdle(Bun.spawnSync(["bun", "tests/connection-lost-idle.worker.ts", database.url]));
      const node = node24();
      if (node !== undefined) {
        const dir = mkdtempSync(join(tmpdir(), "okm-idle-"));
        const outfile = join(dir, "idle.mjs");
        const built = Bun.spawnSync(
          [
            "bun",
            "build",
            "tests/connection-lost-idle.worker.ts",
            "--target",
            "node",
            "--outfile",
            outfile,
          ],
          { cwd: process.cwd() },
        );
        expect(built.exitCode).toBe(0);
        const nodeChild = Bun.spawnSync([node, outfile, database.url], { timeout: 20_000 });
        if (nodeChild.exitCode !== 0) {
          throw new Error(
            `node idle ${String(nodeChild.exitCode)} ${String(nodeChild.signalCode)}\n${nodeChild.stdout?.toString() ?? ""}\n${nodeChild.stderr?.toString() ?? ""}`,
          );
        }
        expectIdle(nodeChild);
      }
    } finally {
      await database.close();
    }
  },
  90_000,
);

function expectIdle(proc: ReturnType<typeof Bun.spawnSync>): void {
  const out = proc.stdout?.toString() ?? "";
  const err = proc.stderr?.toString() ?? "";
  if (proc.exitCode !== 0) {
    throw new Error(`idle child ${String(proc.exitCode)}\n${out}\n${err}`);
  }
  expect(out).toContain("idle unavailable");
  expect(out).toContain("savepoint unavailable");
  expect(out).toContain("commit OKM1401 outcome_unknown");
  expect(out).toContain("next ok");
  expect(out).toContain("crashes 0");
}

for (const driver of ["pg", "postgresjs"] as const) {
  postgresTest(
    gate,
    `${driver} keeps the process up when an idle pooled backend is terminated`,
    async () => {
      const database = await createIsolatedDatabase();
      try {
        expectPool(
          Bun.spawnSync(["bun", "tests/connection-lost-pool.worker.ts", database.url, driver]),
        );
        const node = node24();
        if (node !== undefined) {
          const dir = mkdtempSync(join(tmpdir(), "okm-pool-"));
          const outfile = join(dir, "pool.mjs");
          const built = Bun.spawnSync(
            [
              "bun",
              "build",
              "tests/connection-lost-pool.worker.ts",
              "--target",
              "node",
              "--outfile",
              outfile,
            ],
            { cwd: process.cwd() },
          );
          expect(built.exitCode).toBe(0);
          const nodeChild = Bun.spawnSync([node, outfile, database.url, driver], {
            timeout: 20_000,
          });
          if (nodeChild.exitCode !== 0) {
            throw new Error(
              `node pool ${driver} ${String(nodeChild.exitCode)} ${String(nodeChild.signalCode)}\n${nodeChild.stdout?.toString() ?? ""}\n${nodeChild.stderr?.toString() ?? ""}`,
            );
          }
          expectPool(nodeChild);
        }
      } finally {
        await database.close();
      }
    },
    90_000,
  );
}

postgresTest(
  gate,
  "Bun.sql keeps the process up when an idle pooled backend is terminated",
  async () => {
    const database = await createIsolatedDatabase();
    try {
      expectPool(
        Bun.spawnSync(["bun", "tests/connection-lost-pool-bun.worker.ts", database.url], {
          timeout: 20_000,
        }),
      );
    } finally {
      await database.close();
    }
  },
  60_000,
);

for (const driver of ["pg", "postgresjs"] as const) {
  postgresTest(
    gate,
    `${driver} listen does not crash when the server closes that backend`,
    async () => {
      const database = await createIsolatedDatabase();
      try {
        expectPool(
          Bun.spawnSync(["bun", "tests/connection-lost-listen.worker.ts", database.url, driver], {
            timeout: 20_000,
          }),
        );
        const node = node24();
        if (node !== undefined) expectPool(nodeListen(node, database.url, driver));
      } finally {
        await database.close();
      }
    },
    60_000,
  );
}

function expectPool(proc: ReturnType<typeof Bun.spawnSync>): void {
  const out = proc.stdout?.toString() ?? "";
  const err = proc.stderr?.toString() ?? "";
  if (proc.exitCode !== 0) {
    throw new Error(
      `pool child ${String(proc.exitCode)} ${String(proc.signalCode)}\n${out}\n${err}`,
    );
  }
  expect(out).toContain("next ok");
  expect(out).toContain("crashes 0");
}

function nodeListen(node: string, url: string, driver: string): ReturnType<typeof Bun.spawnSync> {
  const dir = mkdtempSync(join(tmpdir(), "okm-listen-"));
  const outfile = join(dir, "listen.mjs");
  const built = Bun.spawnSync(
    [
      "bun",
      "build",
      "tests/connection-lost-listen.worker.ts",
      "--target",
      "node",
      "--outfile",
      outfile,
    ],
    { cwd: process.cwd() },
  );
  expect(built.exitCode).toBe(0);
  return Bun.spawnSync([node, outfile, url, driver], { timeout: 20_000 });
}
