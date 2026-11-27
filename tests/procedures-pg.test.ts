/**
 * Procedures on Postgres: round trip, CALL, commits, definers, raises, and okm call.
 *
 * NEON_* and SUPABASE_* are unset here. Those hosts are not reachable from this run.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Sql } from "postgres";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("NEON_") || key.startsWith("SUPABASE_")) delete process.env[key];
}

import { catalog } from "../src/contracts/catalog/build.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { fn, type ProcedureBodyHandle } from "../src/dialects/pg/fn/index.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import { sealViews } from "../src/dialects/pg/view/scratch.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { accessReport } from "../src/tooling/migrate/access-cmd.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { poolerConfig, POOLER_PORT } from "../scripts/pooler-proof.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const cli = join(root, "src/tooling/cli.ts");

const accounts = table("accounts", {
  id: t.text().primaryKey(),
  balance: t.integer(),
  account: t.text(),
});

postgresTest(
  gate,
  "proof:fn.procedure",
  async () => {
    await using(async (sql) => {
      const typed = fn("close_one", {
        kind: "procedure",
        arguments: [
          { name: "account", type: t.text() },
          { name: "closed", type: t.integer(), mode: "out" },
        ],
        body: (args, query) => {
          const found = query.accounts;
          if (found === undefined) throw new Error("missing accounts");
          return [
            found.update({ set: { balance: 0 }, where: { account: args.account } }),
            query.sql("select 1"),
          ];
        },
      });
      const handle = fn("mark_account", {
        kind: "procedure",
        arguments: [{ name: "account", type: t.text() }],
        language: "plpgsql",
        body: (b: ProcedureBodyHandle) =>
          b.sql`begin update ${accounts} set balance = 0 where id = ${b.arg("account")}; end`,
      });
      const plain = fn("note_account", {
        kind: "procedure",
        arguments: [{ name: "account", type: t.text() }],
        language: "plpgsql",
        dependsOn: [accounts],
        body: "begin null; end",
      });
      const app = schema({ tables: [accounts], functions: [typed, handle, plain] });
      expect(bodyOf(app.catalog, "close_one")).toContain('"close_one"."account"');
      await apply(sql, catalog([]), app.catalog);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const sealed = await sealViews(queryOf(sql), app.catalog);
      expect(about(live, sealed, "close_one")).toEqual([]);
      expect(about(live, app.catalog, "mark_account")).toEqual([]);
      expect(about(live, app.catalog, "note_account")).toEqual([]);
      expect(await countRoutines(sql, "close_one")).toBe(1);

      const noted = fn("note_account", {
        kind: "procedure",
        arguments: [{ name: "account", type: t.text() }],
        language: "plpgsql",
        dependsOn: [accounts],
        body: "begin perform 1; end",
      });
      const replaced = schema({ tables: [accounts], functions: [typed, handle, noted] });
      const replaceSql = about(app.catalog, replaced.catalog, "note_account");
      expect(replaceSql.some((step) => step.startsWith("create or replace procedure"))).toBe(true);
      expect(replaceSql.some((step) => step.startsWith("drop procedure"))).toBe(false);
      await apply(sql, app.catalog, replaced.catalog);
      const afterReplace = await introspectSchema(queryOf(sql), "public", "public");
      expect(about(afterReplace, replaced.catalog, "note_account")).toEqual([]);

      const widenedTyped = fn("close_one", {
        kind: "procedure",
        arguments: [
          { name: "account", type: t.text() },
          { name: "closed", type: t.bigint(), mode: "out" },
        ],
        body: (args, query) => {
          const found = query.accounts;
          if (found === undefined) throw new Error("missing accounts");
          return [
            found.update({ set: { balance: 0 }, where: { id: args.account } }),
            query.sql("select 1"),
          ];
        },
      });
      const widened = schema({ tables: [accounts], functions: [widenedTyped, handle, noted] });
      const dropSql = about(replaced.catalog, widened.catalog, "close_one");
      expect(dropSql.some((step) => step.startsWith("drop procedure"))).toBe(true);
      expect(dropSql.some((step) => step.startsWith("create procedure"))).toBe(true);
      await apply(sql, replaced.catalog, widened.catalog);
      expect(await countRoutines(sql, "close_one")).toBe(1);
      const afterOut = await introspectSchema(queryOf(sql), "public", "public");
      const sealedOut = await sealViews(queryOf(sql), widened.catalog);
      expect(about(afterOut, sealedOut, "close_one")).toEqual([]);

      const retyped = fn("mark_account", {
        kind: "procedure",
        arguments: [{ name: "account", type: t.integer() }],
        language: "plpgsql",
        body: "begin null; end",
      });
      const changedIn = schema({
        tables: [accounts],
        functions: [widenedTyped, retyped, noted],
      });
      await apply(sql, widened.catalog, changedIn.catalog);
      expect(await countRoutines(sql, "mark_account")).toBe(1);
      const afterIn = await introspectSchema(queryOf(sql), "public", "public");
      expect(about(afterIn, changedIn.catalog, "mark_account")).toEqual([]);

      let blocked: unknown;
      try {
        await sql.unsafe("drop table accounts");
      } catch (error) {
        blocked = error;
      }
      const code =
        typeof blocked === "object" && blocked !== null && "code" in blocked
          ? String(blocked.code)
          : "";
      expect(code).toBe("2BP01");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "proof:fn.run",
  async () => {
    await using(async (sql, url) => {
      const report = fn("report_account", {
        kind: "procedure",
        arguments: [
          { name: "account", type: t.text() },
          { name: "closed", type: t.integer(), mode: "out" },
          { name: "amount", type: t.numeric(), mode: "out" },
          { name: "units", type: t.bigint(), mode: "out" },
          { name: "at", type: t.timestamptz({ mode: "date" }), mode: "out" },
        ],
        language: "sql",
        body: "begin atomic select 4, 1.50, 20, timestamptz '2020-01-02 03:04:05+00'; end",
      });
      const quiet = fn("touch_account", {
        kind: "procedure",
        arguments: [{ name: "account", type: t.text(), default: "a" }],
        language: "plpgsql",
        dependsOn: [accounts],
        body: "begin insert into accounts (id, balance, account) values (account, 1, account); end",
      });
      const app = schema({ tables: [accounts], functions: [report, quiet] });
      await apply(sql, catalog([]), app.catalog);
      const db = connect(url, { schema: app, max: 1 });
      try {
        const notices: string[] = [];
        const row = await report.run(
          db,
          { account: "a" },
          {
            onNotice: (notice) => notices.push(notice.message),
          },
        );
        expect(row.closed).toBe(4);
        expect(String(row.amount).startsWith("1.5")).toBe(true);
        expect(row.units).toBe("20");
        expect(row.at).toBeInstanceOf(Date);
        expect(row.at?.toISOString()).toBe("2020-01-02T03:04:05.000Z");
        expect(notices).toEqual([]);
        const pending = quiet.run(db, {});
        expect(pending).toBeInstanceOf(Promise);
        expect(await Promise.resolve(pending)).toBeUndefined();
        const rows = await sql<{ id: string }[]>`select id from accounts`;
        expect(rows.map((item) => item.id)).toEqual(["a"]);
        let rolled: unknown;
        try {
          await db.tx(async (tx: object) => {
            await Promise.resolve(quiet.run(tx, { account: "b" }));
            throw new Error("rollback");
          });
        } catch (error) {
          rolled = error;
        }
        expect(rolled).toBeInstanceOf(Error);
        expect(rolled instanceof Error ? rolled.message : "").toBe("rollback");
        const kept = await sql<{ id: string }[]>`select id from accounts order by id`;
        expect(kept.map((item) => item.id)).toEqual(["a"]);
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "proof:fn.procedure.commits",
  async () => {
    await using(async (sql, url) => {
      const batches = table("batches", { n: t.integer().primaryKey() });
      const take = fn("take_batch", {
        kind: "procedure",
        commits: true,
        dependsOn: [batches],
        body: `begin
  insert into batches (n) values (1);
  commit;
  insert into batches (n) values (2);
  commit;
  raise exception 'stop';
end`,
      });
      const app = schema({ tables: [batches], functions: [take] });
      await apply(sql, catalog([]), app.catalog);
      const db = connect(url, { schema: app, max: 1 });
      try {
        let refused: unknown;
        try {
          await db.tx(async (tx: object) => {
            await take.run(tx, {});
          });
        } catch (error) {
          refused = error;
        }
        expect(refused).toBeInstanceOf(OkmError);
        expect(String(refused)).toContain("2D000");
        const before = await sql<{ n: number }[]>`select n from batches`;
        expect(before).toHaveLength(0);
        let failed: unknown;
        try {
          await take.run(db, {});
        } catch (error) {
          failed = error;
        }
        expect(failed).toBeTruthy();
        const rows = await sql<{ n: number }[]>`select n from batches order by n`;
        expect(rows.map((item) => item.n)).toEqual([1, 2]);
      } finally {
        await db.close();
      }
      await withPgbouncer(url, async (poolUrl) => {
        const pooled = connect(poolUrl, { schema: app, max: 1 });
        try {
          await sql.unsafe("delete from batches");
          let failed: unknown;
          try {
            await take.run(pooled, {});
          } catch (error) {
            failed = error;
          }
          expect(failed).toBeTruthy();
          const rows = await sql<{ n: number }[]>`select n from batches order by n`;
          expect(rows.map((item) => item.n)).toEqual([1, 2]);
        } finally {
          await pooled.close();
        }
      });
    });
  },
  60_000,
);

postgresTest(
  gate,
  "proof:fn.definerRevoke",
  async () => {
    await using(async (sql) => {
      const owned = fn("owned_close", {
        kind: "procedure",
        security: "definer",
        searchPath: "public",
        language: "plpgsql",
        body: "begin null; end",
      });
      const ownedFn = fn("owned_fn", {
        security: "definer",
        searchPath: "public",
        returns: t.integer(),
        language: "sql",
        body: "select 1",
      });
      const app = schema({ tables: [], functions: [owned, ownedFn] });
      const steps = planMigration({
        before: catalog([]),
        after: app.catalog,
        name: "definer",
      }).steps.map((step) => step.sql);
      expect(steps.some((step) => step.startsWith("revoke execute on procedure"))).toBe(true);
      expect(steps.some((step) => step.startsWith("revoke execute on function"))).toBe(true);
      await apply(sql, catalog([]), app.catalog);
      expect(await publicExecute(sql, "owned_close")).toBe(false);
      expect(await publicExecute(sql, "owned_fn")).toBe(false);
      const replaced = schema({
        tables: [],
        functions: [
          fn("owned_close", {
            kind: "procedure",
            security: "definer",
            searchPath: "public",
            language: "plpgsql",
            body: "begin perform 1; end",
          }),
          ownedFn,
        ],
      });
      const again = planMigration({
        before: app.catalog,
        after: replaced.catalog,
        name: "replace",
      }).steps.map((step) => step.sql);
      expect(again.some((step) => step.includes("revoke execute on procedure"))).toBe(true);
      await apply(sql, app.catalog, replaced.catalog);
      expect(await publicExecute(sql, "owned_close")).toBe(false);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "proof:fn.raises",
  async () => {
    await using(async (sql, url) => {
      const refuse = fn("refuse_closed", {
        kind: "procedure",
        arguments: [{ name: "account", type: t.text() }],
        language: "plpgsql",
        raises: { closed: "P0001" },
        body: `begin
  raise exception 'closed' using errcode = 'P0001', detail = 'account', hint = 'retry', constraint = 'accounts_pkey';
end`,
      });
      const app = schema({ tables: [], functions: [refuse] });
      await apply(sql, catalog([]), app.catalog);
      const db = connect(url, { schema: app, max: 1 });
      try {
        let caught: unknown;
        try {
          await refuse.run(db, { account: "a" });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(OkmError);
        const error = caught as OkmError;
        expect(error.code.length).toBeGreaterThan(0);
        expect(error.sqlstate).toBe("P0001");
        expect(error.detail).toContain("account");
        expect(error.hint).toContain("retry");
        expect(error.constraint).toBe("accounts_pkey");
        expect(error.raised).toBe("closed");
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "proof:grants.procedure",
  async () => {
    await using(async (sql, url) => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const mig = `proc_mig_${suffix}`;
      const appRole = `proc_app_${suffix}`;
      const listed = fn("listed", {
        kind: "procedure",
        language: "plpgsql",
        grants: { app: ["execute"] },
        body: "begin null; end",
      });
      const app = schema({ tables: [], functions: [listed] });
      const declared = attachRoles(app.catalog, {
        migration: { name: mig },
        app: { name: appRole },
      });
      const steps = planMigration({
        before: catalog([]),
        after: declared,
        name: "grants",
      }).steps.map((step) => step.sql);
      expect(steps.some((step) => step.includes("grant execute on procedure"))).toBe(true);
      try {
        await sql.unsafe(`create role ${quoteRole(mig)}`);
        await sql.unsafe(`create role ${quoteRole(appRole)}`);
        await apply(sql, catalog([]), declared);
        const allowed = await sql<{ ok: boolean }[]>`
          select has_function_privilege(${appRole}, p.oid, 'execute') as ok
          from pg_proc p
          where p.proname = 'listed'
        `;
        expect(allowed[0]?.ok).toBe(true);
        const report = await accessReport(
          {
            schema: "./schema.ts",
            roles: { migration: { name: mig }, app: { name: appRole } },
          },
          url,
          "listed",
        );
        expect(report.grants.some((grant) => grant.object === "procedure listed")).toBe(true);
      } finally {
        await sql.unsafe(`drop owned by ${quoteRole(mig)}`);
        await sql.unsafe(`drop owned by ${quoteRole(appRole)}`);
        await sql.unsafe(`drop role ${quoteRole(mig)}`);
        await sql.unsafe(`drop role ${quoteRole(appRole)}`);
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "proof:comment.procedure",
  async () => {
    await using(async (sql) => {
      const noted = fn("noted", {
        kind: "procedure",
        language: "plpgsql",
        comment: "closes the month",
        body: "begin null; end",
      });
      const app = schema({ tables: [], functions: [noted] });
      const steps = planMigration({
        before: catalog([]),
        after: app.catalog,
        name: "comment",
      }).steps.map((step) => step.sql);
      expect(steps.some((step) => step.startsWith("comment on procedure"))).toBe(true);
      await apply(sql, catalog([]), app.catalog);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      expect(about(live, app.catalog, "noted")).toEqual([]);
      const found = live.objects.find(
        (object) => object.kind === "function" && object.identity.name === "noted",
      );
      expect(found?.comment).toBe("closes the month");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "okm call rolls a procedure back",
  async () => {
    await using(async (sql, url) => {
      const mark = fn("mark_row", {
        kind: "procedure",
        arguments: [{ name: "account", type: t.text() }],
        language: "plpgsql",
        dependsOn: [accounts],
        body: "begin insert into accounts (id, balance, account) values (account, 1, account); end",
      });
      const app = schema({ tables: [accounts], functions: [mark] });
      await apply(sql, catalog([]), app.catalog);
      const dir = mkdtempSync(join(tmpdir(), "okm-call-"));
      try {
        writeFileSync(
          join(dir, "schema.ts"),
          [
            `import { fn } from ${JSON.stringify(join(root, "src/dialects/pg/fn/index.ts"))};`,
            `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
            "const accounts = table('accounts', { id: t.text().primaryKey(), balance: t.integer(), account: t.text() });",
            "const batches = table('batches', { n: t.integer().primaryKey() });",
            "const mark = fn('mark_row', { kind: 'procedure', arguments: [{ name: 'account', type: t.text() }], language: 'plpgsql', dependsOn: [accounts], body: 'begin insert into accounts (id, balance, account) values (account, 1, account); end' });",
            "const take = fn('take_batch', { kind: 'procedure', commits: true, dependsOn: [batches], body: 'begin commit; end' });",
            "export default schema({ tables: [accounts, batches], functions: [mark, take] });",
            "",
          ].join("\n"),
        );
        writeFileSync(
          join(dir, "okmodel.config.ts"),
          [
            `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/config.ts"))};`,
            `export default defineConfig({ schema: "./schema.ts", database: ${JSON.stringify(url)} });`,
            "",
          ].join("\n"),
        );
        const rolled = spawnSync(
          "bun",
          [cli, "call", "mark_row", "--arg", "account=z", "--rollback"],
          { cwd: dir, encoding: "utf8" },
        );
        expect(rolled.status, rolled.stderr).toBe(0);
        expect(rolled.stdout).not.toContain("postgres://");
        const parsed = JSON.parse(rolled.stdout) as { rolledBack: boolean };
        expect(parsed.rolledBack).toBe(true);
        const rows = await sql<{ id: string }[]>`select id from accounts`;
        expect(rows).toHaveLength(0);
        const committing = spawnSync("bun", [cli, "call", "take_batch", "--rollback"], {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, OKM_CALL_SCHEMA: "missing" },
        });
        expect(committing.status).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
  60_000,
);

async function using(body: (sql: Sql, url: string) => Promise<void>): Promise<void> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await body(sql, database.url);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
}

async function apply(sql: Sql, before: Catalog, after: Catalog): Promise<void> {
  const plan = planMigration({ before, after, name: "apply" });
  for (const step of plan.steps) await sql.unsafe(step.sql);
}

function about(before: Catalog, after: Catalog, name: string): string[] {
  return planMigration({ before, after, name: "round" })
    .steps.map((step) => step.sql)
    .filter((sql) => sql.toLowerCase().includes(name));
}

function bodyOf(source: Catalog, name: string): string {
  const found = source.objects.find(
    (object) => object.kind === "function" && object.identity.name === name,
  );
  if (found?.kind !== "function") throw new Error(`missing ${name}`);
  return found.definition.body;
}

function queryOf(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}

async function countRoutines(sql: Sql, name: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_proc where proname = ${name}
  `;
  return rows[0]?.n ?? 0;
}

async function publicExecute(sql: Sql, name: string): Promise<boolean> {
  const rows = await sql<{ acl: string | null }[]>`
    select proacl::text as acl from pg_proc where proname = ${name}
  `;
  const acl = rows[0]?.acl ?? "";
  return /(^|[{,])=X\//.test(acl);
}

function quoteRole(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function withPgbouncer(
  databaseUrl: string,
  body: (url: string) => Promise<void>,
): Promise<void> {
  // Suite shards do not install PgBouncer. The pooler job runs the same
  // CALL through OKM_POOLER_URL. A machine with the binary still proves it here.
  if (Bun.which("pgbouncer") === null) return;
  const primary = new URL(databaseUrl);
  const dir = mkdtempSync(join(tmpdir(), "okm-proc-pooler-"));
  const port = POOLER_PORT + 20;
  writeFileSync(join(dir, "users.txt"), `"${decodeURIComponent(primary.username)}" ""\n`);
  const dbname = primary.pathname.replace(/^\//, "");
  const ini = poolerConfig(
    primary.hostname,
    primary.port,
    decodeURIComponent(primary.username),
    decodeURIComponent(primary.password),
    dir,
  )
    .replace(`listen_port = ${String(POOLER_PORT)}`, `listen_port = ${String(port)}`)
    .replace("dbname=okm", `dbname=${dbname}`);
  writeFileSync(join(dir, "pgbouncer.ini"), ini);
  const child = Bun.spawn(["pgbouncer", join(dir, "pgbouncer.ini")], {
    cwd: dir,
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitForPort(port);
    const url = `postgres://${encodeURIComponent(decodeURIComponent(primary.username))}:${encodeURIComponent(decodeURIComponent(primary.password))}@127.0.0.1:${String(port)}/okm`;
    await body(url);
  } finally {
    child.kill();
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
