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
    await withGuideRoles("superuser", async ({ url, sql, roles }) => {
      await applyGuide(url, roles);
      await assertFunctionAcls(sql, roles);
    });
    await withGuideRoles("createrole", async ({ url, sql, roles }) => {
      await applyGuide(url, roles);
      await assertFunctionAcls(sql, roles);
    });
  },
  120_000,
);

postgresTest(
  gate,
  "a failing role step leaves a re-runnable target",
  async () => {
    await withGuideRoles("superuser", async ({ url, sql, roles }) => {
      const steps = guideSteps(roles);
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
          migrationRole: roles.migrate,
          appRole: roles.app,
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
      await applyGuide(url, roles);
      await assertFunctionAcls(sql, roles);
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
          // Warm two backends, then hold one between pid reads so LIFO
          // (`server_round_robin=0`) cannot reuse a single server.
          const warmA = open({ url, max: 1 });
          const warmB = open({ url, max: 1 });
          try {
            await Promise.all([
              warmA.execute("select pg_sleep(0.25)"),
              warmB.execute("select pg_sleep(0.25)"),
            ]);
          } finally {
            await Promise.all([warmA.close(), warmB.close()]);
          }
          const pool = open({ url, max: 1 });
          const disrupt = open({ url, max: 1 });
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
                {
                  holdBackend: async () => {
                    const held = await disrupt.reserve!();
                    await held.execute("begin");
                    return async () => {
                      await held.execute("rollback").catch(() => undefined);
                      await held.release();
                    };
                  },
                },
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
            await Promise.all([pool.close(), disrupt.close()]);
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

type GuideRoles = {
  readonly migrate: string;
  readonly app: string;
  readonly report: string;
  readonly admin: string;
};

function freshGuideRoles(): GuideRoles {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return {
    migrate: `okm_m_${id}`,
    app: `okm_a_${id}`,
    report: `okm_r_${id}`,
    admin: `okm_d_${id}`,
  };
}

async function applyGuide(url: string, roles: GuideRoles): Promise<void> {
  await applyTarget({
    url,
    target: "default",
    protected: false,
    migrationRole: roles.migrate,
    appRole: roles.app,
    migrations: [{ id: "0001_init", catalogHash: "x", steps: guideSteps(roles) }],
  });
}

function guideSteps(roles: GuideRoles) {
  return planMigration({ before: catalog([]), after: guideCatalog(roles), name: "init" }).steps;
}

function guideCatalog(roles: GuideRoles) {
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
      migration: roles.migrate,
      app: roles.app,
      reporting: roles.report,
      managed: [{ name: roles.migrate }, { name: roles.report, login: true }],
      columns: [{ role: roles.report, on: "tasks", select: ["title"] }],
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

async function assertFunctionAcls(
  sql: ReturnType<typeof openPostgres>,
  roles: GuideRoles,
): Promise<void> {
  const rows = (await sql.unsafe(`
    select
      has_function_privilege('public', 'is_open(text)', 'execute') as p,
      has_function_privilege(${sqlLiteral(roles.app)}, 'is_open(text)', 'execute') as a,
      has_function_privilege(${sqlLiteral(roles.report)}, 'is_open(text)', 'execute') as r
  `)) as { p: boolean; a: boolean; r: boolean }[];
  expect(rows[0]?.p).toBe(false);
  expect(rows[0]?.a).toBe(true);
  expect(rows[0]?.r).toBe(false);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function withGuideRoles(
  mode: "superuser" | "createrole",
  body: (context: {
    url: string;
    sql: ReturnType<typeof openPostgres>;
    roles: GuideRoles;
  }) => Promise<void>,
): Promise<void> {
  const roles = freshGuideRoles();
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await sql.unsafe(
      `create role ${quoteIdent(roles.app)} login password 'secret' nosuperuser nocreatedb nocreaterole`,
    );
    let url = database.url;
    if (mode === "createrole") {
      await sql.unsafe(
        `create role ${quoteIdent(roles.admin)} login password 'admin' nosuperuser createdb createrole`,
      );
      const dbname = new URL(database.url).pathname.slice(1);
      await sql.unsafe(
        `grant connect, create on database ${quoteIdent(dbname)} to ${quoteIdent(roles.admin)}`,
      );
      await sql.unsafe(`alter schema public owner to ${quoteIdent(roles.admin)}`);
      const parsed = new URL(database.url);
      parsed.username = roles.admin;
      parsed.password = "admin";
      url = parsed.toString();
    }
    await body({ url, sql, roles });
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
    await dropGuideRoles(roles);
  }
}

async function dropGuideRoles(roles: GuideRoles): Promise<void> {
  const sql = openPostgres(primaryUrl());
  try {
    for (const role of [roles.migrate, roles.app, roles.report, roles.admin]) {
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
