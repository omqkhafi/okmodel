/**
 * `okm migrate apply` and id defaults on Postgres 15 to 18 (D184, D261).
 *
 * A bare `t.id()` stores `gen_random_uuid()` and applies on every supported
 * major. An explicit `uuidv7()` is built in from Postgres 18. On 15, 16 and
 * 17 apply must stop with OKM1812 before it sends any statement, so nothing
 * is created, not even `okm_meta`. On 18 the same schema applies. Each case
 * runs the real `okm` commands against an empty database, and the expectation
 * follows the major of the server the suite is running on.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { run } from "../src/tooling/migrate/commands.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();

/** Schema sources. Each exports `app`. */
const BARE = `schema({ tables: [table("users", { id: t.id(), name: t.text() })] })`;
const EXPLICIT = `schema({ tables: [table("users", { id: t.id({ default: "uuidv7" }), name: t.text() })] })`;
const SCHEMA_V7 = `schema({ defaults: { id: "uuidv7" }, tables: [table("users", { id: t.id(), name: t.text() })] })`;
const DECLARED = `schema({ requires: { postgres: ">=18" }, tables: [table("users", { id: t.id({ default: "uuidv7" }), name: t.text() })] })`;
const DECLARED_NUMBER = `schema({ minPostgres: 18, tables: [table("users", { id: t.id({ default: "uuidv7" }), name: t.text() })] })`;
const TOO_LOW = `schema({ requires: { postgres: ">=17" }, tables: [table("users", { id: t.id({ default: "uuidv7" }), name: t.text() })] })`;
const TOO_LOW_NUMBER = `schema({ minPostgres: 17, tables: [table("users", { id: t.id({ default: "uuidv7" }), name: t.text() })] })`;
const UUIDV4 = `schema({ tables: [table("users", { id: t.id({ default: "uuidv4" }), name: t.text() })] })`;
const SCHEMA_DEFAULT = `schema({ defaults: { id: "uuidv4" }, tables: [table("users", { id: t.id(), name: t.text() })] })`;
const COLUMN_WINS = `schema({ defaults: { id: "uuidv7" }, requires: { postgres: ">=18" }, tables: [table("users", { id: t.id({ default: "uuidv4" }), name: t.text() })] })`;

postgresTest(
  gate,
  "a bare t.id() applies gen_random_uuid() on every major and does not raise OKM1812",
  async () => {
    await inDatabase(BARE, async ({ cwd, sql }) => {
      await run(["generate"], { cwd, stdout: () => undefined });
      await run(["migrate", "apply"], { cwd, stdout: () => undefined });
      await expectColumnDefault(sql, "gen_random_uuid()");
      await usesTheDefault(sql);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "an explicit uuidv7() is OKM1812 before any statement below 18, and applies on 18",
  async () => {
    for (const source of [EXPLICIT, SCHEMA_V7]) {
      await inDatabase(source, async ({ cwd, major, sql }) => {
        await run(["generate"], { cwd, stdout: () => undefined });
        if (major >= 18) {
          await run(["migrate", "apply"], { cwd, stdout: () => undefined });
          await expectColumnDefault(sql, "uuidv7()");
          await usesTheDefault(sql);
          return;
        }
        const error = await failure(() => applyIn(cwd));
        expect(error.code).toBe("OKM1812");
        expect(error.message).toContain("minPostgres: 18");
        expect(error.message).not.toContain("does not exist");
        await expectNothingCreated(sql);
        expect((await failure(() => applyIn(cwd))).code).toBe("OKM1812");
        await expectNothingCreated(sql);
      });
    }
  },
  60_000,
);

postgresTest(
  gate,
  "migrate check reports OKM1812 for uuidv7 below 18 and replays it on 18",
  async () => {
    await inDatabase(EXPLICIT, async ({ cwd, major, sql }) => {
      await run(["generate"], { cwd, stdout: () => undefined });
      if (major >= 18) {
        const lines: string[] = [];
        await run(["migrate", "check"], { cwd, stdout: (text) => lines.push(text) });
        expect(lines.join("")).toContain("ok 1 migrations");
        return;
      }
      const error = await failure(() =>
        run(["migrate", "check"], { cwd, stdout: () => undefined }),
      );
      expect(error.code).toBe("OKM1812");
      expect(error.message).toContain("uuidv7() needs PostgreSQL 18 or higher");
      expect(error.message).toContain("minPostgres: 18");
      expect(error.message).not.toContain("does not exist");
      expect(error.fix.summary).toContain("minPostgres: 18");
      const scratch = await sql<{ nspname: string }[]>`
        select nspname from pg_namespace where nspname like 'okm_check_%'
      `;
      expect(scratch).toHaveLength(0);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "the error names the column, the version, and minPostgres",
  async () => {
    await inDatabase(EXPLICIT, async ({ cwd, major, sql }) => {
      await run(["generate"], { cwd, stdout: () => undefined });
      if (major >= 18) {
        await run(["migrate", "apply"], { cwd, stdout: () => undefined });
        await expectColumnDefault(sql, "uuidv7()");
        return;
      }
      const error = await failure(() => applyIn(cwd));
      expect(error).toBeInstanceOf(OkmError);
      expect(error.code).toBe("OKM1812");
      expect(error.message).toContain("Column users.id has a uuidv7() default");
      expect(error.message).toContain("0001_migration");
      expect(error.message).toContain(`the server is PostgreSQL ${String(major)}`);
      expect(error.message).toContain("has a uuidv7() default");
      expect(error.message).toContain("uuidv7() needs PostgreSQL 18 or higher");
      expect(error.message).toContain("minPostgres: 18");
      expect(error.message).toContain("Nothing was changed");
      expect(error.fix.summary).toContain("minPostgres: 18");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "both floor forms: 18 stops apply below 18 and connect says OKM1802; 17 stops at schema build",
  async () => {
    for (const source of [DECLARED, DECLARED_NUMBER]) {
      await inDatabase(source, async ({ cwd, url, major, sql, app }) => {
        await run(["generate"], { cwd, stdout: () => undefined });
        if (major >= 18) {
          await run(["migrate", "apply"], { cwd, stdout: () => undefined });
          await usesTheDefault(sql);
          return;
        }
        expect((await failure(() => applyIn(cwd))).code).toBe("OKM1812");
        await expectNothingCreated(sql);
        const client = connect(url, { schema: app, max: 1 });
        try {
          const connected = await failure(() => client.connected);
          expect(connected.code).toBe("OKM1802");
          expect(connected.message).toContain("minPostgres: 18");
        } finally {
          await client.close();
        }
      });
    }
    for (const source of [TOO_LOW, TOO_LOW_NUMBER]) {
      await inDatabase(source, async () => undefined, {
        loadError: (error) => {
          expect(error).toBeInstanceOf(OkmError);
          expect((error as OkmError).code).toBe("OKM1812");
          expect((error as OkmError).message).toContain("minPostgres");
          expect((error as OkmError).message).toContain("PostgreSQL 18");
        },
      });
    }
  },
  60_000,
);

postgresTest(
  gate,
  't.id({ default: "uuidv4" }), defaults.id "uuidv4", and a column choice apply on every major',
  async () => {
    for (const source of [UUIDV4, SCHEMA_DEFAULT, COLUMN_WINS]) {
      await inDatabase(source, async ({ cwd, sql }) => {
        await run(["generate"], { cwd, stdout: () => undefined });
        await run(["migrate", "apply"], { cwd, stdout: () => undefined });
        await expectColumnDefault(sql, "gen_random_uuid()");
        await usesTheDefault(sql);
      });
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a server that already has a uuidv7() function is not refused",
  async () => {
    await inDatabase(EXPLICIT, async ({ cwd, sql }) => {
      await sql.unsafe(
        "create function public.uuidv7() returns uuid language sql as 'select gen_random_uuid()'",
      );
      await run(["generate"], { cwd, stdout: () => undefined });
      await run(["migrate", "apply"], { cwd, stdout: () => undefined });
      await usesTheDefault(sql);
    });
  },
  60_000,
);

type Context = {
  readonly cwd: string;
  readonly url: string;
  readonly major: number;
  readonly sql: ReturnType<typeof openPostgres>;
  readonly app: Parameters<typeof connect>[1]["schema"];
};

/** Runs `body` in a temporary project over an empty database. */
async function inDatabase(
  source: string,
  body: (context: Context) => Promise<void>,
  options?: { readonly loadError?: (error: unknown) => void },
): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-uuidv7-"));
  const sql = openPostgres(database.url);
  try {
    writeFileSync(
      join(cwd, "schema.ts"),
      [
        `import { schema, t, table } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        `export const app = ${source};`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        "export default defineConfig({",
        '  schema: "./schema.ts",',
        '  migrations: "./migrations",',
        '  out: "./.okm",',
        `  database: { url: ${JSON.stringify(database.url)} },`,
        "});",
        "",
      ].join("\n"),
    );
    let app: Context["app"];
    try {
      app = (
        (await import(`${join(cwd, "schema.ts")}?v=${crypto.randomUUID()}`)) as {
          app: Context["app"];
        }
      ).app;
    } catch (error) {
      if (options?.loadError === undefined) throw error;
      options.loadError(error);
      return;
    }
    const version = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
    const major = Math.floor(Number(version[0]?.v ?? "0") / 10_000);
    await body({ cwd, url: database.url, major, sql, app });
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

function applyIn(cwd: string): Promise<void> {
  return run(["migrate", "apply"], { cwd, stdout: () => undefined });
}

async function failure(operation: () => Promise<unknown>): Promise<OkmError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected an OkmError");
}

/** No table, no `okm_meta`, no `okm_history`: apply sent no DDL at all. */
async function expectNothingCreated(sql: ReturnType<typeof openPostgres>): Promise<void> {
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'public'
  `;
  expect(tables.map((row) => row.table_name)).toEqual([]);
}

/** The stored column default is the function the schema asked for. */
async function expectColumnDefault(
  sql: ReturnType<typeof openPostgres>,
  expression: string,
): Promise<void> {
  const rows = await sql<{ column_default: string | null }[]>`
    select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'id'
  `;
  expect(rows[0]?.column_default).toContain(expression);
}

/** The table exists and an insert without an id gets one. */
async function usesTheDefault(sql: ReturnType<typeof openPostgres>): Promise<void> {
  const rows = await sql<{ id: string }[]>`insert into users (name) values ('ada') returning id`;
  expect(rows[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
}
