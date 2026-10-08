/**
 * QA of 0.5.0 on real Postgres: pooler probe, scratch check, isolation,
 * apply numbering, rename estimates, conforming strings, and a CLI role
 * without privileges.
 */

import { expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { testing } from "../src/tooling/testing/index.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { aboutRows, annotateLock, readRowEstimates } from "../src/tooling/migrate/estimate.js";
import type { PlanStep } from "../src/tooling/migrate/plan.js";
import { assertStableBackend } from "../src/tooling/migrate/policy.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const cli = join(root, "src/tooling/cli.ts");

const lists = table("lists", { id: id({ default: "none" }), name: text() });
const tenantApp = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [lists],
});

postgresTest(gate, "QA-M6: a direct connection keeps one backend pid", async () => {
  const database = await createIsolatedDatabase();
  const pool = open({ url: database.url, max: 1 });
  try {
    const connection = await pool.reserve?.();
    if (connection === undefined) throw new Error("reserve");
    try {
      await assertStableBackend(async () => {
        const result = await connection.execute("select pg_backend_pid()::text");
        const cell = result.rows[0]?.[0];
        return cell === null || cell === undefined ? "" : String(cell);
      }, false);
    } finally {
      await connection.release();
    }
  } finally {
    await pool.close();
    await database.close();
  }
});

postgresTest(
  gate,
  "QA-M7: okm check exits 0 for citext and a view",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = writeCitextProject(database.url);
    try {
      const pushed = await spawn(["push"], cwd);
      expect(pushed.stderr).toBe("");
      expect(pushed.code).toBe(0);
      const checked = await spawn(["check"], cwd);
      expect(checked.stderr).toBe("");
      expect(checked.code).toBe(0);
      expect(checked.stdout).toContain("ok");
    } finally {
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "QA-M8: isolation passes twice while another tenant inserts",
  async () => {
    const database = await createIsolatedDatabase();
    const harness = await testing(tenantApp, { driver: open({ url: database.url }) });
    try {
      const tenant = crypto.randomUUID();
      await harness.db.for({ tenantId: tenant }).lists.insert({
        id: crypto.randomUUID(),
        name: "already",
      });
      const first = await harness.isolation();
      expect(first.checked).toEqual(["lists"]);
      const extra = harness.db.for({ tenantId: crypto.randomUUID() }).lists.insert({
        id: crypto.randomUUID(),
        name: "during",
      });
      const second = await harness.isolation();
      await extra;
      expect(second.checked).toEqual(["lists"]);
    } finally {
      await harness.close();
      await database.close();
    }
  },
  60_000,
);

postgresTest(gate, "QA-L5: apply numbers a failed step from 1", async () => {
  const database = await createIsolatedDatabase();
  try {
    const failed = await applyTarget({
      url: database.url,
      target: "default",
      protected: false,
      allowProtected: false,
      migrations: [
        {
          id: "0001_bad",
          catalogHash: "hash",
          steps: [step("insert into missing values (1)")],
        },
      ],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(OkmError);
    expect(failed instanceof Error ? failed.message : "").toContain("failed at step 1");
  } finally {
    await database.close();
  }
});

postgresTest(gate, "QA-L6: a renamed table keeps the old reltuples", async () => {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await sql`create table tasks (id integer)`;
    await sql`insert into tasks values (1), (2), (3)`;
    await sql`analyze tasks`;
    const counted = await sql<{ n: string }[]>`
      select c.reltuples::float8::text as n
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'tasks'
    `;
    const estimates = await readRowEstimates(database.url, "public", ["tasks", "items"]);
    const text = annotateLock(itemsStep(), estimates, new Map([["items", "tasks"]]));
    expect(text).toContain(aboutRows(Number(counted[0]?.n)));
    expect(text).not.toContain("new table");
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(gate, "QA-S2: apply refuses standard_conforming_strings off", async () => {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  const name = new URL(database.url).pathname.slice(1);
  try {
    await sql.unsafe(`alter database ${name} set standard_conforming_strings = off`);
    const failed = await applyTarget({
      url: database.url,
      target: "default",
      protected: false,
      allowProtected: false,
      migrations: [
        {
          id: "0001_ok",
          catalogHash: "hash",
          steps: [step("select 1")],
        },
      ],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(OkmError);
    expect(failed instanceof Error ? failed.message : "").toContain("standard_conforming_strings");
  } finally {
    await sql
      .unsafe(`alter database ${name} set standard_conforming_strings = on`)
      .catch(() => undefined);
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(
  gate,
  "QA-M10: the CLI prints one error line for a role without privileges",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const name = new URL(database.url).pathname.slice(1);
    const role = `okm_nopriv_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const cwd = writePlainProject(privilegedUrl(database.url, role));
    try {
      await sql.unsafe(`create role ${role} login password 'nope'`);
      await sql.unsafe(`revoke connect on database ${name} from public`);
      await sql.unsafe(`revoke connect on database ${name} from ${role}`);
      await sql.unsafe(`grant connect on database ${name} to current_user`);
      const quiet = await spawn(["check"], cwd);
      expect(quiet.code).toBe(1);
      expect(quiet.stdout).toBe("");
      const lines = quiet.stderr.split("\n").filter((line) => line.length > 0);
      expect(lines[0]?.startsWith("error ")).toBe(true);
      expect(quiet.stderr).not.toContain("\n    at ");
      const loud = await spawn(["check", "--verbose"], cwd);
      expect(loud.code).toBe(1);
      expect(loud.stderr.startsWith("error ")).toBe(true);
      expect(loud.stderr).toContain("\n    at ");
      const debug = await spawn(["check"], cwd, { OKM_DEBUG: "1" });
      expect(debug.code).toBe(1);
      expect(debug.stderr).toContain("\n    at ");
    } finally {
      await sql.unsafe(`grant connect on database ${name} to public`).catch(() => undefined);
      await sql.unsafe(`drop role if exists ${role}`).catch(() => undefined);
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

function step(sql: string): PlanStep {
  return {
    sql,
    class: "expand",
    action: "ddl",
    lock: "ACCESS EXCLUSIVE",
    transactional: true,
  };
}

function itemsStep(): PlanStep {
  return {
    sql: 'alter table "public"."items" add column "note" text',
    class: "expand",
    kind: "add-column",
    action: "ddl",
    lock: "ACCESS EXCLUSIVE",
    transactional: true,
    tables: ["items"],
  };
}

function privilegedUrl(database: string, role: string): string {
  const url = new URL(database);
  url.username = role;
  url.password = "nope";
  return url.href;
}

function writeCitextProject(url: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-qa-m7-"));
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const view = JSON.stringify(join(root, "src/dialects/pg/view/index.ts"));
  const ext = JSON.stringify(join(root, "src/dialects/pg/ext/citext.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, table, t } from ${pg};`,
      `import { view } from ${view};`,
      `import { citext } from ${ext};`,
      'const tasks = table("tasks", { id: t.integer().primaryKey(), email: t.citext() });',
      "export const app = schema({",
      "  tables: [tasks],",
      "  extensions: [citext()],",
      '  views: [view("emails", {',
      '    columns: [{ name: "email", type: "citext" }],',
      '    query: " SELECT email\\n   FROM tasks;",',
      "  })],",
      "});",
      "",
    ].join("\n"),
  );
  writeConfig(cwd, url);
  return cwd;
}

function writePlainProject(url: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-qa-m10-"));
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    `import { schema, table, t } from ${pg};\nexport const app = schema({ tables: [table("notes", { id: t.integer().primaryKey() })] });\n`,
  );
  writeConfig(cwd, url);
  return cwd;
}

function writeConfig(cwd: string, url: string): void {
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: { url: ${JSON.stringify(url)} },`,
      "});",
      "",
    ].join("\n"),
  );
  mkdirSync(join(cwd, "migrations"));
}

async function spawn(
  args: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const code = await proc.exited;
  return {
    code,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}
