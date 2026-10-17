/**
 * Guide roles apply (B-30), PUBLIC EXECUTE (B-31), pooler URL (B-25), and
 * the multi-read pid probe (B-41) on real Postgres.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import { quoteIdent } from "../src/dialects/pg/ddl.js";
import { fn } from "../src/dialects/pg/fn/index.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { driverUrl } from "../src/tooling/migrate/driver-url.js";
import { assertDirectConnection, assertStableBackend } from "../src/tooling/migrate/policy.js";
import { probeStableBackend } from "../src/tooling/migrate/pooler-probe.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { poolerConfig, POOLER_PORT } from "../scripts/pooler-proof.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "guide roles apply as superuser and as CREATEROLE; PUBLIC has no execute",
  async () => {
    await withGuideRoles("superuser", async ({ url, sql }) => {
      await applyGuide(url);
      await assertFunctionAcls(sql);
    });
    await withGuideRoles("createrole", async ({ url, sql }) => {
      await applyGuide(url);
      await assertFunctionAcls(sql);
    });
  },
  120_000,
);

postgresTest(
  gate,
  "a failing role step leaves a re-runnable target",
  async () => {
    await withGuideRoles("superuser", async ({ url, sql }) => {
      const steps = guideSteps();
      const broken = steps.map((step, index) =>
        index === steps.findIndex((item) => /grant usage on schema/i.test(item.sql))
          ? { ...step, sql: "grant usage on schema public to okm_missing_role" }
          : step,
      );
      let failed: unknown;
      try {
        await applyTarget({
          url,
          target: "default",
          protected: false,
          migrationRole: "okm_migrate",
          appRole: "okm_app",
          migrations: [{ id: "0001_init", catalogHash: "x", steps: broken }],
        });
      } catch (error) {
        failed = error;
      }
      expect(failed).toBeInstanceOf(OkmError);
      const history = await sql<{ n: string }[]>`
        select count(*)::text as n from okm_history
      `.catch(() => [{ n: "0" }]);
      expect(history[0]?.n ?? "0").toBe("0");
      await applyGuide(url);
      await assertFunctionAcls(sql);
    });
  },
  120_000,
);

postgresTest(
  gate,
  "without roles config PUBLIC execute is unchanged",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const tasks = table("tasks", { id: t.identity(), title: t.text() });
      const isOpen = fn("is_open", {
        arguments: [{ name: "status", type: "text" }],
        returns: "boolean",
        language: "sql",
        volatility: "immutable",
        body: "select status <> 'done'",
      });
      const declared = schema({ tables: [tasks], functions: [isOpen] }).catalog;
      await applyTarget({
        url: database.url,
        target: "default",
        protected: false,
        migrations: [
          {
            id: "0001_init",
            catalogHash: "x",
            steps: planMigration({ before: catalog([]), after: declared, name: "init" }).steps,
          },
        ],
      });
      const pub = await sql<{ p: boolean }[]>`
        select has_function_privilege('public', 'is_open(text)', 'execute') as p
      `;
      expect(pub[0]?.p).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a URL with ?pgbouncer=true connects after the hint is stripped",
  async () => {
    const database = await createIsolatedDatabase();
    try {
      const withHint = `${database.url}${database.url.includes("?") ? "&" : "?"}pgbouncer=true`;
      expect(() => assertDirectConnection(withHint, false)).toThrow(OkmError);
      expect(() => assertDirectConnection(withHint, true)).not.toThrow();
      expect(driverUrl(withHint)).not.toContain("pgbouncer");
      await applyTarget({
        url: withHint,
        target: "default",
        protected: false,
        allowPooler: true,
        migrations: [],
      });
    } finally {
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "pid probe refuses PgBouncer with server_round_robin 0 and 1",
  async () => {
    if (Bun.which("pgbouncer") === null) return;
    const version = await pgbouncerVersion();
    if (version === undefined || version.major !== 1 || version.minor < 26) return;
    for (const roundRobin of [0, 1] as const) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await withPgbouncer(roundRobin, async (url) => {
          const pool = open({ url, max: 1 });
          try {
            const reserved = await pool.reserve!();
            try {
              const error = await probeStableBackend(
                url,
                async () => {
                  const result = await reserved.execute("select pg_backend_pid()::text");
                  return String(result.rows[0]?.[0] ?? "");
                },
                false,
              ).then(
                () => undefined,
                (caught: unknown) => caught,
              );
              expect(error).toBeInstanceOf(OkmError);
              if (error instanceof OkmError) expect(error.code).toBe("OKM1854");
            } finally {
              await reserved.release();
            }
          } finally {
            await pool.close();
          }
        });
      }
    }
    // A direct connection must never be a false positive.
    const direct = open({ url: primaryUrl(), max: 1 });
    try {
      const reserved = await direct.reserve!();
      try {
        await probeStableBackend(
          primaryUrl(),
          async () => {
            const result = await reserved.execute("select pg_backend_pid()::text");
            return String(result.rows[0]?.[0] ?? "");
          },
          false,
        );
      } finally {
        await reserved.release();
      }
    } finally {
      await direct.close();
    }
  },
  300_000,
);

postgresTest(gate, "assertStableBackend still fails when two of eight pids differ", async () => {
  let n = 0;
  const error = await assertStableBackend(async () => {
    n += 1;
    return n === 3 ? "22" : "11";
  }, false).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OkmError);
  if (error instanceof OkmError) expect(error.code).toBe("OKM1854");
});

async function applyGuide(url: string): Promise<void> {
  await applyTarget({
    url,
    target: "default",
    protected: false,
    migrationRole: "okm_migrate",
    appRole: "okm_app",
    migrations: [{ id: "0001_init", catalogHash: "x", steps: guideSteps() }],
  });
}

function guideSteps() {
  return planMigration({ before: catalog([]), after: guideCatalog(), name: "init" }).steps;
}

function guideCatalog() {
  const tasks = table("tasks", {
    id: t.identity(),
    title: t.text().hidden(),
    status: t.text(),
  });
  const isOpen = fn("is_open", {
    arguments: [{ name: "status", type: "text" }],
    returns: "boolean",
    language: "sql",
    volatility: "immutable",
    body: "select status <> 'done'",
  });
  return attachRoles(
    schema({ tables: [tasks], functions: [isOpen] }).catalog,
    {
      migration: "okm_migrate",
      app: "okm_app",
      reporting: "okm_report",
      managed: [{ name: "okm_migrate" }, { name: "okm_report", login: true }],
      columns: [{ role: "okm_report", on: "tasks", select: ["title"] }],
    },
    [
      {
        table: "tasks",
        columns: [
          { field: "id", sql: "id", hidden: false },
          { field: "title", sql: "title", hidden: true },
          { field: "status", sql: "status", hidden: false },
        ],
      },
    ],
  );
}

async function assertFunctionAcls(sql: ReturnType<typeof openPostgres>): Promise<void> {
  const rows = await sql<{ p: boolean; a: boolean; r: boolean }[]>`
    select
      has_function_privilege('public', 'is_open(text)', 'execute') as p,
      has_function_privilege('okm_app', 'is_open(text)', 'execute') as a,
      has_function_privilege('okm_report', 'is_open(text)', 'execute') as r
  `;
  expect(rows[0]?.p).toBe(false);
  expect(rows[0]?.a).toBe(true);
  expect(rows[0]?.r).toBe(false);
}

async function withGuideRoles(
  mode: "superuser" | "createrole",
  body: (context: { url: string; sql: ReturnType<typeof openPostgres> }) => Promise<void>,
): Promise<void> {
  await dropGuideRoles();
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await sql.unsafe(
      `create role okm_app login password 'secret' nosuperuser nocreatedb nocreaterole`,
    );
    let url = database.url;
    if (mode === "createrole") {
      await sql.unsafe(
        `create role okm_admin login password 'admin' nosuperuser createdb createrole`,
      );
      const dbname = new URL(database.url).pathname.slice(1);
      await sql.unsafe(`grant connect, create on database ${quoteIdent(dbname)} to okm_admin`);
      await sql.unsafe(`alter schema public owner to okm_admin`);
      const parsed = new URL(database.url);
      parsed.username = "okm_admin";
      parsed.password = "admin";
      url = parsed.toString();
    }
    await body({ url, sql });
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
    await dropGuideRoles();
  }
}

async function dropGuideRoles(): Promise<void> {
  const sql = openPostgres(primaryUrl());
  try {
    for (const role of ["okm_migrate", "okm_app", "okm_report", "okm_admin"]) {
      await sql.unsafe(`reassign owned by ${quoteIdent(role)} to current_user`).catch(() => {});
      await sql.unsafe(`drop owned by ${quoteIdent(role)}`).catch(() => {});
      await sql.unsafe(`drop role if exists ${quoteIdent(role)}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function withPgbouncer(
  roundRobin: 0 | 1,
  body: (url: string) => Promise<void>,
): Promise<void> {
  const primary = new URL(primaryUrl());
  const dir = mkdtempSync(join(tmpdir(), "okm-roles-pooler-"));
  const port = POOLER_PORT + 10 + roundRobin;
  writeFileSync(join(dir, "users.txt"), '"okm" ""\n');
  const ini = poolerConfig(
    primary.hostname,
    primary.port,
    decodeURIComponent(primary.username),
    decodeURIComponent(primary.password),
    dir,
  ).replace(`listen_port = ${String(POOLER_PORT)}`, `listen_port = ${String(port)}`);
  writeFileSync(
    join(dir, "pgbouncer.ini"),
    ini.replace(/server_round_robin = 1/, `server_round_robin = ${String(roundRobin)}`),
  );
  const child = Bun.spawn(["pgbouncer", join(dir, "pgbouncer.ini")], {
    cwd: dir,
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitForPort(port);
    await body(`postgres://okm:okm@127.0.0.1:${String(port)}/okm`);
  } finally {
    child.kill();
    await child.exited.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    }).catch(() => undefined);
    if (socket !== undefined) {
      socket.end();
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`pgbouncer did not open 127.0.0.1:${String(port)}`);
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
