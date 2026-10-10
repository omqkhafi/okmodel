/**
 * Row-level security on real Postgres, as a role that does not own the tables.
 *
 * The application role is not the owner, not a superuser, and not BYPASSRLS.
 * Statements that skip the query builder still cannot see another tenant.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";

import type { DriverPool } from "../src/contracts/driver.js";
import { catalogHash } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, many, one, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { view } from "../src/dialects/pg/view/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl, replicaUrl } from "../packages/harness/src/topology.js";
import { open, connect } from "../src/runtime/pg/postgresjs.js";
import { RlsRoleError } from "../src/runtime/tenancy/rls.js";
import { global, rlsTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { testing } from "../src/tooling/testing/index.js";
import { app as columnApp } from "./tenancy-schema.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
const ORG = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c01";
const ORG_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02";
const NOTE_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
const NOTE_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";
const PASSWORD = "rlsappsecret";

const orgs = table(
  "orgs",
  { id: id({ default: "none" }), name: text() },
  { relations: { notes: many("notes") } },
);
const notes = table(
  "notes",
  {
    id: id({ default: "none" }),
    title: text().unique(),
    orgId: uuid().references("orgs"),
  },
  { relations: { org: one("orgs", "orgId") }, traits: [archivable()] },
);
const countries = table(
  "countries",
  { id: id({ default: "none" }), name: text() },
  { tenancy: global("shared") },
);
const openNotes = view("open_notes", {
  columns: [
    { name: "id", type: "uuid" },
    { name: "tenant_id", type: "uuid" },
    { name: "title", type: "text" },
  ],
  query: "select id, tenant_id, title from notes",
});

const built = schema({
  casing: "snake",
  tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
  tables: [orgs, notes, countries],
  views: [openNotes],
});

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "rls isolates a non-owner role, refuses a bypass, and replays",
  async () => {
    await withPostgresSchema(async (admin, schemaName) => {
      for (const statement of renderCatalog(built.catalog, schemaName)) {
        await admin.unsafe(statement);
      }
      const appRole = `a_${schemaName}`;
      const ownerRole = `o_${schemaName}`;
      const superRole = `s_${schemaName}`;
      const bypassRole = `b_${schemaName}`;
      const roles = [appRole, ownerRole, superRole, bypassRole];
      try {
        await admin.unsafe(
          `create role ${appRole} login password '${PASSWORD}' nosuperuser nobypassrls`,
        );
        await admin.unsafe(
          `create role ${ownerRole} login password '${PASSWORD}' nosuperuser nobypassrls`,
        );
        await admin.unsafe(`create role ${superRole} login password '${PASSWORD}' superuser`);
        await admin.unsafe(
          `create role ${bypassRole} login password '${PASSWORD}' nosuperuser bypassrls`,
        );
        for (const role of roles) {
          await admin.unsafe(`grant connect on database okm to ${role}`);
          await admin.unsafe(`grant usage on schema ${schemaName} to ${role}`);
          await admin.unsafe(
            `grant select, insert, update, delete on all tables in schema ${schemaName} to ${role}`,
          );
          await admin.unsafe(`alter role ${role} set search_path to ${schemaName}`);
        }
        await admin.unsafe(`alter table ${schemaName}.notes owner to ${ownerRole}`);
        await admin.unsafe(`alter table ${schemaName}.orgs owner to ${ownerRole}`);
        await admin.unsafe(
          `insert into ${schemaName}.orgs (id, tenant_id, name) values ('${ORG}', '${TENANT_A}', 'Acme'), ('${ORG_B}', '${TENANT_B}', 'Beta')`,
        );
        await admin.unsafe(
          `insert into ${schemaName}.notes (id, tenant_id, title, org_id) values ('${NOTE_A}', '${TENANT_A}', 'alpha', '${ORG}')`,
        );
        await admin.unsafe(
          `insert into ${schemaName}.notes (id, tenant_id, title, org_id) values ('${NOTE_B}', '${TENANT_B}', 'beta', '${ORG_B}')`,
        );

        const appUrl = roleUrl(primaryUrl(), appRole);
        const raw = postgres(appUrl, { max: 1, connect_timeout: 10 });
        try {
          const none = await raw<{ count: string }[]>`select count(*)::text as count from notes`;
          expect(none[0]?.count).toBe("0");
          await raw.begin(async (tx) => {
            await tx`select set_config('app.tenant', ${TENANT_A}, true)`;
            const onlyA = await tx<{ id: string }[]>`select id from notes order by title`;
            expect(onlyA.map((row) => row.id)).toEqual([NOTE_A]);
            const removed = await tx<{ count: string }[]>`
              with deleted as (
                delete from notes where tenant_id = ${TENANT_B} returning 1
              )
              select count(*)::text as count from deleted
            `;
            expect(removed[0]?.count).toBe("0");
          });
          await expectPolicy(
            raw.begin(async (tx) => {
              await tx`select set_config('app.tenant', ${TENANT_A}, true)`;
              await tx`insert into notes (id, tenant_id, title, org_id) values (${crypto.randomUUID()}, ${TENANT_B}, 'smuggle', ${ORG_B})`;
            }),
          );
          await expectPolicy(
            raw.begin(async (tx) => {
              await tx`select set_config('app.tenant', ${TENANT_A}, true)`;
              await tx`update notes set tenant_id = ${TENANT_B}, org_id = ${ORG_B} where id = ${NOTE_A}`;
            }),
          );
        } finally {
          await raw.end();
        }

        const seen: string[] = [];
        const db = connect(probePool(open({ url: appUrl, max: 2, searchPath: schemaName }), seen), {
          schema: built,
          searchPath: schemaName,
        });
        try {
          const a = db.for({ tenantId: TENANT_A });
          const b = db.for({ tenantId: TENANT_B });
          expect((await a.notes.find({ limit: 10 })).map((row) => row.id)).toEqual([NOTE_A]);
          expect(seen).toEqual([""]);
          expect((await a.notes.one({ where: { id: NOTE_A } }))?.title).toBe("alpha");
          expect(await a.notes.count()).toBe(1);
          expect((await a.notes.aggregate({ count: true })).at(0)?.count).toBe(1);
          expect((await a.notes.page({ orderBy: { title: "asc" }, limit: 10 })).items).toHaveLength(
            1,
          );
          const streamed: string[] = [];
          for await (const row of a.notes.find({ limit: 10 }).stream()) streamed.push(row.id);
          expect(streamed).toEqual([NOTE_A]);
          expect((await a.notes.find({ limit: 1, include: { org: true } }))[0]?.org?.name).toBe(
            "Acme",
          );

          const inserted = await a.notes.insert({
            id: crypto.randomUUID(),
            title: "gamma",
            orgId: ORG,
          });
          expect(inserted.tenantId).toBe(TENANT_A);
          await a.notes.update({ where: { id: inserted.id }, set: { title: "gamma-2" } });
          expect(await b.notes.count({ where: { id: inserted.id } })).toBe(0);
          expect(await a.notes.delete({ where: { id: inserted.id } })).toEqual({ count: 1 });
          const archived = await a.notes.insert({
            id: crypto.randomUUID(),
            title: "old",
            orgId: ORG,
          });
          expect((await a.notes.archive({ where: { id: archived.id } })).count).toBe(1);
          const again = crypto.randomUUID();
          await a.notes.insert(
            { id: again, title: "alpha", orgId: ORG },
            { onConflict: { on: "title", update: ["title"] } },
          );
          expect(await a.notes.count({ where: { title: "alpha" } })).toBe(1);
          await a.tx(async (tx) => {
            expect(await tx.notes.count()).toBe(1);
            expect(await tx.notes.count({ where: { id: NOTE_B } })).toBe(0);
            expect(await tx.orgs.count()).toBe(1);
          });
          await a.batch([
            a.notes.insert({ id: crypto.randomUUID(), title: "batched", orgId: ORG }),
          ]);
          expect(await b.notes.count({ where: { title: "batched" } })).toBe(0);

          const [left, right] = await Promise.all([
            a.notes.find({ limit: 10 }),
            b.notes.find({ limit: 10 }),
          ]);
          expect(left.every((row) => row.tenantId === TENANT_A)).toBe(true);
          expect(right.every((row) => row.tenantId === TENANT_B)).toBe(true);
          expect(left.some((row) => row.id === NOTE_B)).toBe(false);

          const across = await db.unscoped("audit").notes.find({ limit: 20 });
          expect(new Set(across.map((row) => row.tenantId))).toEqual(new Set([TENANT_A, TENANT_B]));
          let unscopedWrite: unknown;
          try {
            await db.unscoped("audit").notes.insert({
              id: crypto.randomUUID(),
              title: "cross",
              orgId: ORG,
            });
          } catch (error) {
            unscopedWrite = error;
          }
          expect(unscopedWrite).toBeInstanceOf(OkmError);
          if (unscopedWrite instanceof OkmError) expect(unscopedWrite.code).toBe("OKM1701");

          const lookup = await a.notes.find({ where: { title: "alpha" }, limit: 1 }).sql();
          const plan = await rawExplain(appUrl, schemaName, lookup.text, lookup.params);
          expect(plan.toLowerCase(), plan).toContain("index");
          expect(plan.toLowerCase(), plan).not.toContain("seq scan");

          const viewSql = postgres(appUrl, { max: 1, connect_timeout: 10 });
          try {
            await viewSql.unsafe(`set search_path to ${schemaName}`);
            const hidden = await viewSql<{ count: string }[]>`
              select count(*)::text as count from open_notes
            `;
            expect(hidden[0]?.count).toBe("0");
            await viewSql.begin(async (tx) => {
              await tx`select set_config('app.tenant', ${TENANT_A}, true)`;
              const rows = await tx<{ id: string; tenant_id: string }[]>`
                select id, tenant_id from open_notes
              `;
              expect(rows.some((row) => row.id === NOTE_A)).toBe(true);
              expect(rows.some((row) => row.tenant_id === TENANT_B)).toBe(false);
            });
          } finally {
            await viewSql.end();
          }
          const options = await admin<{ options: string | null }[]>`
            select array_to_string(c.reloptions, ',') as options
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = ${schemaName} and c.relname = 'open_notes'
          `;
          expect(options[0]?.options ?? "").toContain("security_invoker=true");
        } finally {
          await db.close();
        }

        await expectRole(ownerRole, schemaName, built, "owner");
        await expectRole(superRole, schemaName, built, "superuser");
        await expectRole(bypassRole, schemaName, built, "bypassrls");

        const harness = await testing(built, {
          driver: open({ url: appUrl, max: 4, searchPath: schemaName }),
          migrate: false,
        });
        try {
          const report = await harness.isolation();
          expect(report.checked).toContain("notes");
          expect(report.skipped.map((item) => item.table)).toContain("countries");
        } finally {
          await harness.close();
        }
        await admin.unsafe(`drop policy if exists notes_tenant on ${schemaName}.notes`);
        await admin.unsafe(`drop policy if exists notes_unscoped_select on ${schemaName}.notes`);
        await admin.unsafe(`alter table ${schemaName}.notes disable row level security`);
        const broken = await testing(built, {
          driver: open({ url: appUrl, max: 2, searchPath: schemaName }),
          migrate: false,
        });
        try {
          let missing: unknown;
          try {
            await broken.isolation();
          } catch (error) {
            missing = error;
          }
          expect(missing).toBeInstanceOf(OkmError);
          if (missing instanceof OkmError) expect(missing.message).toContain("row-level security");
        } finally {
          await broken.close();
        }

        const replica = await connect(
          {
            primary: appUrl,
            replicas: [{ url: roleUrl(replicaUrl("a"), appRole), name: "a" }],
          },
          { schema: built, searchPath: schemaName },
        );
        try {
          const routed = await replica.for({ tenantId: TENANT_A }).notes.find({
            route: "replica",
            limit: 10,
          });
          expect(routed.every((row) => row.tenantId === TENANT_A)).toBe(true);
          expect(routed.some((row) => row.id === NOTE_A)).toBe(true);
        } finally {
          await replica.close();
        }

        await provePooler(appUrl, appRole, schemaName);
      } finally {
        for (const role of roles) {
          await admin.unsafe(`drop owned by ${role} cascade`).catch(() => undefined);
          await admin.unsafe(`drop role if exists ${role}`).catch(() => undefined);
        }
      }
    });
  },
  120_000,
);

postgresTest(
  gate,
  "okm migrate check replays rls policies and a column schema does not grow them",
  async () => {
    expect(catalogHash(columnApp.catalog)).toBe(
      "12bdf154322bd0f113aabd10055763e74781458a9d5bd1589d18f291b336e445",
    );
    await withProject(async (cwd) => {
      writeRlsSchema(cwd);
      await cli(cwd, ["generate", "init"]);
      const sql = await Bun.file(migrationSql(cwd)).text();
      expect(sql).toContain("enable row level security");
      expect(sql).toContain("security_invoker = true");
      const text = await capture(cwd, ["migrate", "check"]);
      expect(text).toContain("ok");
    });
  },
  60_000,
);

async function expectPolicy(pending: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }
  const message = thrown instanceof Error ? thrown.message : "";
  expect(message).toContain("row-level security policy");
}

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = PASSWORD;
  return url.toString();
}

function probePool(inner: DriverPool, seen: string[]): DriverPool {
  if (inner.reserve === undefined) return inner;
  return {
    ...inner,
    reserve: async () => {
      const conn = await inner.reserve!();
      let committed = false;
      return {
        ...conn,
        execute: async (text, params, options) => {
          if (text.trim().toLowerCase() === "commit") committed = true;
          return conn.execute(text, params, options);
        },
        release: async () => {
          if (committed) {
            const probe = await conn.execute("select current_setting('app.tenant', true)");
            const cell = probe.rows[0]?.[0];
            seen.push(cell === null || cell === undefined ? "" : String(cell));
            committed = false;
          }
          await conn.release();
        },
      };
    },
  };
}

async function rawExplain(
  url: string,
  schemaName: string,
  text: string,
  params: readonly unknown[],
): Promise<string> {
  const sql = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe(`set search_path to ${schemaName}`);
      await tx`select set_config('app.tenant', ${TENANT_A}, true)`;
      await tx.unsafe("set local enable_seqscan = off");
      const rows = await tx.unsafe(
        `explain ${text}`,
        params.map((value) =>
          typeof value === "string" || typeof value === "number" ? value : null,
        ),
      );
      return rows.map((row) => String(row["QUERY PLAN"] ?? "")).join("\n");
    });
  } finally {
    await sql.end();
  }
}

async function expectRole(
  role: string,
  schemaName: string,
  model: typeof built,
  reason: "owner" | "superuser" | "bypassrls",
): Promise<void> {
  const db = connect(roleUrl(primaryUrl(), role), {
    schema: model,
    searchPath: schemaName,
    max: 1,
  });
  try {
    let thrown: unknown;
    try {
      await db.for({ tenantId: TENANT_A }).notes.find({ limit: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RlsRoleError);
    if (thrown instanceof RlsRoleError) {
      expect(thrown.code).toBe("OKM1707");
      expect(thrown.reason).toBe(reason);
    }
  } finally {
    await db.close();
  }
}

async function provePooler(appUrl: string, appRole: string, schemaName: string): Promise<void> {
  if (Bun.which("pgbouncer") === null) return;
  const dir = mkdtempSync(join(tmpdir(), "okm-rls-pooler-"));
  const port = 6434;
  const target = new URL(appUrl);
  writeFileSync(join(dir, "users.txt"), `"${appRole}" "${PASSWORD}"\n`);
  writeFileSync(
    join(dir, "pgbouncer.ini"),
    [
      "[databases]",
      `okm = host=${target.hostname} port=${target.port} dbname=${target.pathname.slice(1)} user=${appRole} password=${PASSWORD}`,
      "[pgbouncer]",
      "listen_addr = 127.0.0.1",
      `listen_port = ${String(port)}`,
      "auth_type = trust",
      `auth_file = ${join(dir, "users.txt")}`,
      "pool_mode = transaction",
      "server_reset_query =",
      "",
    ].join("\n"),
  );
  const child = Bun.spawn(["pgbouncer", join(dir, "pgbouncer.ini")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitForPort(port);
    const pooled = `postgres://${appRole}:${PASSWORD}@127.0.0.1:${String(port)}/okm`;
    const db = connect(pooled, { schema: built, searchPath: schemaName, max: 1 });
    try {
      await db.for({ tenantId: TENANT_A }).notes.find({ limit: 1 });
      const probe = postgres(pooled, { max: 1, connect_timeout: 10 });
      try {
        await probe.unsafe(`set search_path to ${schemaName}`);
        const rows = await probe<{ tenant: string | null }[]>`
          select current_setting('app.tenant', true) as tenant
        `;
        expect(rows[0]?.tenant ?? "").toBe("");
      } finally {
        await probe.end();
      }
    } finally {
      await db.close();
    }
  } finally {
    child.kill();
    await child.exited;
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
    await Bun.sleep(200);
  }
  throw new Error(`pgbouncer did not open 127.0.0.1:${String(port)}`);
}

const root = repoRoot();

async function withProject(body: (cwd: string) => Promise<void>): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-rls-"));
  try {
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        "export default defineConfig({",
        '  schema: "./schema.ts",',
        '  migrations: "./migrations",',
        `  database: ${JSON.stringify(database.url)},`,
        "});",
        "",
      ].join("\n"),
    );
    await body(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

function writeRlsSchema(cwd: string): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      `import { view } from ${source("src/dialects/pg/view/index.ts")};`,
      `import { global, rlsTenancy } from ${source("src/runtime/tenancy/index.ts")};`,
      'const notes = table("notes", { id: t.id({ default: "none" }), title: t.text() });',
      'const countries = table("countries", { id: t.id({ default: "none" }), name: t.text() }, { tenancy: global("shared") });',
      'const openNotes = view("open_notes", { columns: [{ name: "id", type: "uuid" }, { name: "tenant_id", type: "uuid" }], query: "select id, tenant_id from notes" });',
      'export const app = schema({ casing: "snake", tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }), tables: [notes, countries], views: [openNotes] });',
      "",
    ].join("\n"),
  );
}

function migrationSql(cwd: string): string {
  return join(cwd, "migrations", "0001_init.sql");
}

async function cli(cwd: string, argv: readonly string[]): Promise<void> {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      [
        `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
        `await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: () => {} });`,
      ].join("\n"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr);
}

async function capture(cwd: string, argv: readonly string[]): Promise<string> {
  const lines: string[] = [];
  await run(argv, { cwd, stdout: (text) => lines.push(text) });
  return lines.join("");
}
