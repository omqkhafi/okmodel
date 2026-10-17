/**
 * Bun.sql session isolation under backend kills (B-03) and committed-write
 * reporting when reset fails on release (B-04).
 *
 * Stress: concurrent scoped reads and writes while backends are terminated.
 * After the fix: short=0, leaks=0, after=ok, no nested begins, no read_only writes.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { OkmError } from "../src/contracts/error.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { startCutProxy } from "../packages/harness/src/proxy.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPostgresJs } from "../src/adapters/pg/postgresjs.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgresJs } from "../src/runtime/pg/postgresjs.js";
import { rlsTenancy } from "../src/runtime/tenancy/index.js";

const gate = await loadPostgresGate();
const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
const PASSWORD = "rlsappsecret";
const STRESS_MS = 8_000;
const CALL_MS = 2_000;

const projects = table("projects", {
  id: id(),
  name: text(),
});
const app = schema({
  casing: "snake",
  tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
  tables: [projects],
});

type OpenPool = (config: {
  readonly url: string;
  readonly searchPath: string;
  readonly max: number;
}) => DriverPool;

type ConnectFn = typeof connectBun;

async function withAppRole<T>(
  run: (admin: Sql, schemaName: string, role: string, appUrl: string) => Promise<T>,
): Promise<T> {
  return withPostgresSchema(async (admin, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await admin.unsafe(statement);
    }
    const role = `r_${schemaName}`;
    try {
      await admin.unsafe(
        `create role ${role} login password '${PASSWORD}' nosuperuser nobypassrls`,
      );
      await admin.unsafe(`grant connect on database okm to ${role}`);
      await admin.unsafe(`grant usage on schema ${schemaName} to ${role}`);
      await admin.unsafe(
        `grant select, insert, update, delete on all tables in schema ${schemaName} to ${role}`,
      );
      for (let i = 0; i < 5; i += 1) {
        await admin.unsafe(
          `insert into ${schemaName}.projects (tenant_id, name) values ('${TENANT_A}', 'A${String(i)}')`,
        );
      }
      for (let i = 0; i < 7; i += 1) {
        await admin.unsafe(
          `insert into ${schemaName}.projects (tenant_id, name) values ('${TENANT_B}', 'B${String(i)}')`,
        );
      }
      const url = new URL(primaryUrl());
      url.username = role;
      url.password = PASSWORD;
      return await run(admin, schemaName, role, url.toString());
    } finally {
      await admin.unsafe(`drop owned by ${role} cascade`).catch(() => undefined);
      await admin.unsafe(`drop role if exists ${role}`);
    }
  });
}

function timed<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`call timed out after ${String(ms)}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function safe<T>(
  work: Promise<T>,
  ms = CALL_MS,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return timed(work, ms).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/** Post-storm pool recovery: retry only unavailable/closed, bounded for CI. */
const AFTER_STORM_ATTEMPTS = 8;

function recoverableAfterStorm(error: unknown): boolean {
  if (error instanceof OkmError) return error.kind === "unavailable";
  if (!(error instanceof Error)) return false;
  return (
    error.message === "Connection closed" ||
    error.message === "connection must be a PostgresSQLConnection" ||
    /call timed out after/i.test(error.message)
  );
}

async function untilAfterStorm<T>(work: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= AFTER_STORM_ATTEMPTS; attempt += 1) {
    const result = await safe(work());
    if (result.ok) return result.value;
    last = result.error;
    if (!recoverableAfterStorm(last)) throw last;
  }
  throw last;
}

async function dockerPrimaryLogsSince(sinceIso: string): Promise<string> {
  const proc = Bun.spawn(["docker", "logs", "okmodel-primary-1", "--since", sinceIso], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const read = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([stdout, stderr]) => `${stdout}\n${stderr}`);
  const logs = await timed(read, 10_000).catch(() => "");
  await timed(proc.exited, 2_000).catch(() => undefined);
  return logs;
}

postgresTest(
  gate,
  "Bun.sql kill storm keeps scoped reads full and writes outside read-only (B-03)",
  async () => {
    await withAppRole(async (admin, schemaName, role, appUrl) => {
      // Nested begins surface as WARNING regardless of log_statement.
      const since = new Date().toISOString();
      const pool = openBun({ url: appUrl, searchPath: schemaName, max: 4 });
      const db = connectBun(pool, { schema: app });
      const dA = db.for({ tenantId: TENANT_A });
      const dB = db.for({ tenantId: TENANT_B });
      let short = 0;
      let leaks = 0;
      let writes = 0;
      let readOnly = 0;
      let n = 0;
      let killer = true;
      try {
        await db.connected;
        const killLoop = (async () => {
          while (killer) {
            await timed(
              admin.unsafe(
                `select pg_terminate_backend(pid) from pg_stat_activity where usename = '${role}'`,
              ),
              CALL_MS,
            ).catch(() => undefined);
            await Bun.sleep(15 + Math.floor(Math.random() * 30));
          }
        })();
        const deadline = Date.now() + STRESS_MS;
        while (Date.now() < deadline) {
          n += 1;
          const [findA, countB] = await Promise.all([
            safe(dA.projects.find({ limit: 50 })),
            safe(dB.projects.count()),
          ]);
          if (findA.ok) {
            if (findA.value.length < 5) short += 1;
          } else {
            const err = findA.error;
            if (!(err instanceof OkmError) || err.kind !== "unavailable") leaks += 1;
          }
          if (countB.ok) {
            if (countB.value !== 7) short += 1;
          } else {
            const err = countB.error;
            if (!(err instanceof OkmError) || err.kind !== "unavailable") leaks += 1;
          }
          const write = await safe(dA.projects.insert({ name: `W${String(n)}` }));
          if (write.ok) writes += 1;
          else {
            const err = write.error;
            const message = err instanceof Error ? err.message : String(err);
            if (/read.only|read only/i.test(message)) readOnly += 1;
            else if (
              !(err instanceof OkmError) ||
              (err.kind !== "unavailable" && err.kind !== "outcome_unknown")
            ) {
              if (!(err instanceof OkmError && err.kind === "driver")) leaks += 1;
            }
          }
        }
        killer = false;
        await timed(killLoop, 5_000).catch(() => undefined);
        // Nested begins are observed on the primary log. A primary that was
        // started with log_statement=all (CI) or that inherits the session
        // setting still records the warning when it fires.
        const logs = await dockerPrimaryLogsSince(since);
        const nested = (logs.match(/there is already a transaction in progress/g) ?? []).length;
        expect(short).toBe(0);
        expect(leaks).toBe(0);
        expect(readOnly).toBe(0);
        expect(nested).toBe(0);
        // After the storm the pool may still hold a dying handle; retry only
        // unavailable/closed until the scoped reads succeed (bounded for CI).
        const afterA = await untilAfterStorm(() => dA.projects.find({ limit: 50 }));
        const afterB = await untilAfterStorm(() => dB.projects.count());
        expect(afterA.length).toBeGreaterThanOrEqual(5);
        expect(afterB).toBe(7);
        expect(writes).toBeGreaterThan(0);
      } finally {
        killer = false;
        await timed(db.close(), 5_000).catch(() => undefined);
        await timed(pool.close(), 5_000).catch(() => undefined);
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "two concurrent scoped units after a write keep their own tenant settings",
  async () => {
    await withAppRole(async (_admin, schemaName, _role, appUrl) => {
      const pool = openBun({ url: appUrl, searchPath: schemaName, max: 4 });
      const db = connectBun(pool, { schema: app });
      const dA = db.for({ tenantId: TENANT_A });
      const dB = db.for({ tenantId: TENANT_B });
      try {
        await db.connected;
        await dA.projects.insert({ name: "seed-write" });
        const [rowsA, countB] = await Promise.all([
          dA.projects.find({ limit: 50 }),
          dB.projects.count(),
        ]);
        expect(rowsA.length).toBeGreaterThanOrEqual(5);
        expect(rowsA.every((row) => typeof row.name === "string")).toBe(true);
        expect(countB).toBe(7);
        const onlyB = await dB.projects.find({ limit: 50 });
        expect(onlyB.length).toBe(7);
        expect(onlyB.every((row) => String(row.name).startsWith("B"))).toBe(true);
      } finally {
        await db.close();
        await pool.close();
      }
    });
  },
  60_000,
);

for (const driver of [
  {
    name: "Bun.sql",
    open: openBun as OpenPool,
    connect: connectBun as ConnectFn,
  },
  {
    name: "node-postgres",
    open: openPg as OpenPool,
    connect: connectPg as ConnectFn,
  },
  {
    name: "postgres.js",
    open: openPostgresJs as OpenPool,
    connect: connectPostgresJs as ConnectFn,
  },
] as const) {
  postgresTest(
    gate,
    `${driver.name}: release after a killed post-COMMIT reset returns success and runs afterCommit (B-04)`,
    async () => {
      await withAppRole(async (admin, schemaName, _role, appUrl) => {
        const base = driver.open({ url: appUrl, searchPath: schemaName, max: 2 });
        const pool: DriverPool = {
          ...base,
          reserve: async () => {
            const conn = await base.reserve!();
            let pid: string | undefined;
            return {
              ...conn,
              execute: async (text, params, options) => {
                const result = await conn.execute(text, params, options);
                const head = text.trimStart().toLowerCase();
                if (head.startsWith("begin")) {
                  const row = await conn.execute("select pg_backend_pid()::text");
                  pid = String(row.rows[0]?.[0] ?? "");
                }
                if (head === "commit" && pid !== undefined && pid.length > 0) {
                  await admin.unsafe(`select pg_terminate_backend(${pid}::int)`);
                  await Bun.sleep(20);
                }
                return result;
              },
              release: () => conn.release(),
            };
          },
        };
        const db = driver.connect(pool, { schema: app });
        let hooked = 0;
        try {
          await db.connected;
          const countTenant = async (): Promise<number> => {
            const rows = (await admin.unsafe(
              `select count(*)::int as n from ${schemaName}.projects where tenant_id = '${TENANT_A}'`,
            )) as unknown as readonly { readonly n: number }[];
            return rows[0]?.n ?? 0;
          };
          const prior = await countTenant();
          await db.for({ tenantId: TENANT_A }).tx(async (tx) => {
            tx.afterCommit(() => {
              hooked += 1;
            });
            await tx.projects.insert({ name: "committed-then-kill" });
          });
          expect(hooked).toBe(1);
          const landed = (await admin.unsafe(
            `select count(*)::int as n from ${schemaName}.projects where tenant_id = '${TENANT_A}' and name = 'committed-then-kill'`,
          )) as unknown as readonly { readonly n: number }[];
          expect(landed[0]?.n ?? 0).toBe(1);
          expect(await countTenant()).toBe(prior + 1);
          const rows = await db.for({ tenantId: TENANT_A }).projects.find({ limit: 50 });
          expect(rows.length).toBeGreaterThanOrEqual(6);
        } finally {
          await db.close();
          await base.close();
        }
      });
    },
    60_000,
  );

  postgresTest(
    gate,
    `${driver.name}: COMMIT cut on the wire is OKM1401 and afterCommit does not run`,
    async () => {
      await withAppRole(async (_admin, schemaName, _role, appUrl) => {
        const proxy = await startCutProxy(appUrl);
        try {
          const pool = driver.open({ url: proxy.url, searchPath: schemaName, max: 2 });
          const db = driver.connect(pool, { schema: app });
          let hooked = 0;
          try {
            await db.connected;
            proxy.cutNextCommit();
            let error: unknown;
            try {
              await db.for({ tenantId: TENANT_A }).tx(async (tx) => {
                tx.afterCommit(() => {
                  hooked += 1;
                });
                await tx.projects.insert({ name: "cut-commit" });
              });
            } catch (caught) {
              error = caught;
            }
            expect(error).toBeInstanceOf(OkmError);
            expect((error as OkmError).code).toBe("OKM1401");
            expect((error as OkmError).kind).toBe("outcome_unknown");
            expect((error as OkmError).retryable).toBe(false);
            expect(hooked).toBe(0);
          } finally {
            await db.close();
            await pool.close();
          }
        } finally {
          await proxy.close();
        }
      });
    },
    60_000,
  );
}
