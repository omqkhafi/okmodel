/**
 * Generated packs and `okm ext scaffold` / `okm ext test` on Postgres.
 *
 * Each case uses its own database. A server without the extension skips
 * that case. The drift check compares the generator's version table and
 * signatures with this server's major.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import { btreeGin } from "../src/dialects/pg/ext/btree-gin.js";
import { btreeGist } from "../src/dialects/pg/ext/btree-gist.js";
import { fuzzystrmatch } from "../src/dialects/pg/ext/fuzzystrmatch.js";
import { hstore } from "../src/dialects/pg/ext/hstore.js";
import { ltree as ltreePack } from "../src/dialects/pg/ext/ltree.js";
import { pgcrypto } from "../src/dialects/pg/ext/pgcrypto.js";
import { unaccent } from "../src/dialects/pg/ext/unaccent.js";
import type { ExtPackRecord } from "../src/dialects/pg/ext/versions.js";
import { EXT_PACKS } from "../src/dialects/pg/ext/versions.js";
import { custom, schema, t, table } from "../src/dialects/pg/index.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import type { QuerySchema } from "../src/dialects/pg/model.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { run } from "../src/tooling/migrate/commands.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();
const root = join(import.meta.dir, "..");
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

postgresTest(
  gate,
  "generated packs match this server's extension catalogs",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const major = await serverMajor(sql);
      for (const pack of EXT_PACKS) {
        if (!(await available(sql, pack.name))) continue;
        const rows = await sql<{ version: string }[]>`
          select default_version as version from pg_available_extensions where name = ${pack.name}
        `;
        expect(rows[0]?.version, pack.name).toBe(versionOf(pack, major));
        await sql.unsafe(`create extension ${quoteIdent(pack.name)}`);
        for (const signature of pack.signatures) {
          const found = await signatureExists(sql, pack.name, signature);
          expect(found, `${pack.name} ${JSON.stringify(signature)}`).toBe(true);
        }
      }
      if (major >= 16 && (await available(sql, "fuzzystrmatch"))) {
        expect(await functionExists(sql, "fuzzystrmatch", "daitch_mokotoff", "text")).toBe(true);
      }
      if (major >= 18 && (await available(sql, "pgcrypto"))) {
        expect(await functionExists(sql, "pgcrypto", "fips_mode", "")).toBe(true);
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "unaccent folds an accented query",
  async () => {
    await useText("unaccent", unaccent(), (pack) => pack.unaccent("Café"), "Cafe", ["Cafe"]);
  },
  30_000,
);

postgresTest(
  gate,
  "hstore hasKey reads an installed hstore",
  async () => {
    await useCustom("hstore", hstore(), "hstore", "a=>1", (pack) => pack.hasKey("a"), ['"a"=>"1"']);
  },
  30_000,
);

postgresTest(
  gate,
  "ltree ancestorOf matches a parent path",
  async () => {
    const pack = ltreePack();
    await useTable(
      "ltree",
      schema({
        tables: [table("places", { path: t.ltree() })],
        extensions: [pack],
      }),
      "places",
      "path",
      "Top.Science",
      pack.ancestorOf("Top.Science.Physics"),
      ["Top.Science"],
    );
  },
  30_000,
);

postgresTest(
  gate,
  "fuzzystrmatch levenshtein counts edits",
  async () => {
    await useText(
      "fuzzystrmatch",
      fuzzystrmatch(),
      (pack) => pack.levenshtein("sitting", 3),
      "kitten",
      ["kitten"],
    );
  },
  30_000,
);

postgresTest(
  gate,
  "pgcrypto digest matches sha256",
  async () => {
    await useText("pgcrypto", pgcrypto(), (pack) => pack.digest("sha256", ABC_SHA256), "abc", [
      "abc",
    ]);
  },
  30_000,
);

postgresTest(
  gate,
  "btree_gist and btree_gin indexes are created",
  async () => {
    const gist = btreeGist();
    const gin = btreeGin();
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      if (!(await available(sql, "btree_gist")) || !(await available(sql, "btree_gin"))) return;
      const app = schema({
        tables: [
          table(
            "nums",
            { n: t.integer(), m: t.integer() },
            { indexes: (column) => [gist.gist(column.n.name), gin.gin(column.m.name)] },
          ),
        ],
        extensions: [gist, gin],
      });
      const text = await apply(sql, app);
      expect(text).toContain('using gist ("n" gist_int4_ops)');
      expect(text).toContain('using gin ("m" int4_ops)');
      await sql.unsafe("insert into nums (n) values (1)");
      const found = await sql<{ n: number }[]>`select n from nums where n = 1`;
      expect(found.map((row) => row.n)).toEqual([1]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "okm ext scaffold and test round-trip pg_trgm and hstore",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const cwd = mkdtempSync(join(tmpdir(), "okm-ext-scaffold-"));
    try {
      if (!(await available(sql, "pg_trgm")) || !(await available(sql, "hstore"))) return;
      await sql.unsafe("create extension pg_trgm");
      await sql.unsafe("create extension hstore");
      writeProject(cwd, database.url, false);
      for (const name of ["pg_trgm", "hstore"]) {
        const printed: string[] = [];
        await run(["ext", "scaffold", name], { cwd, stdout: (text) => printed.push(text) });
        const source = printed.join("");
        expect(source).toContain(`extension(${JSON.stringify(name)}`);
        expect(source).toContain('"functions"');
        if (name === "hstore") {
          expect(source).toContain('"hstore"');
          expect(source).toContain("akeys");
        }
        if (name === "pg_trgm") expect(source).toContain("similarity");
        const file = `${name}.ts`;
        writeFileSync(join(cwd, file), sourceImport(source));
        const checked: string[] = [];
        await run(["ext", "test", file], { cwd, stdout: (text) => checked.push(text) });
        expect(checked.join("")).toContain(`ok ${name}`);
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  60_000,
);

postgresTest(
  gate,
  "okm ext test lists a wrong signature",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const cwd = mkdtempSync(join(tmpdir(), "okm-ext-bad-"));
    try {
      if (!(await available(sql, "hstore"))) return;
      await sql.unsafe("create extension hstore");
      writeProject(cwd, database.url, false);
      writeFileSync(
        join(cwd, "bad.ts"),
        [
          `import { extension } from ${JSON.stringify(join(root, "src/dialects/pg/ext/index.ts"))};`,
          'export const broken = extension("hstore", {',
          '  provides: { functions: [{ name: "akeys", args: ["text"], returns: "text[]" }] },',
          "});",
          "",
        ].join("\n"),
      );
      const error = await failure(() =>
        run(["ext", "test", "bad.ts"], { cwd, stdout: () => undefined }),
      );
      expect(error.message).toContain("akeys(text)");
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);

postgresTest(
  gate,
  "scaffold and test are allowed on a protected target",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const cwd = mkdtempSync(join(tmpdir(), "okm-ext-protected-"));
    try {
      if (!(await available(sql, "hstore"))) return;
      await sql.unsafe("create extension hstore");
      writeProject(cwd, database.url, true);
      const printed: string[] = [];
      await run(["ext", "scaffold", "hstore"], { cwd, stdout: (text) => printed.push(text) });
      writeFileSync(join(cwd, "hstore.ts"), sourceImport(printed.join("")));
      const checked: string[] = [];
      await run(["ext", "test", "hstore.ts"], { cwd, stdout: (text) => checked.push(text) });
      expect(checked.join("")).toContain("ok hstore");
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);

async function useText<T extends { readonly name: string }>(
  name: string,
  pack: T,
  where: (pack: T) => unknown,
  inserted: string,
  expected: readonly string[],
): Promise<void> {
  const app = schema({
    tables: [table("words", { title: t.text() })],
    extensions: [pack],
  });
  await useTable(name, app, "words", "title", inserted, where(pack), expected);
}

async function useCustom<T extends { readonly name: string }>(
  name: string,
  pack: T,
  sqlType: string,
  inserted: string,
  where: (pack: T) => unknown,
  expected: readonly string[],
): Promise<void> {
  const app = schema({
    tables: [
      table("docs", {
        attrs: custom<string>({
          sqlType,
          encode: (value) => value,
          decode: (wire) => wire,
          extension: name,
        }),
      }),
    ],
    extensions: [pack],
  });
  await useTable(name, app, "docs", "attrs", inserted, where(pack), expected);
}

async function useTable(
  name: string,
  app: QuerySchema & { readonly catalog: Catalog },
  tableName: string,
  column: string,
  inserted: string,
  where: unknown,
  expected: readonly string[],
): Promise<void> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    if (!(await available(sql, name))) return;
    await apply(sql, app);
    await sql.unsafe(`insert into ${quoteIdent(tableName)} (${quoteIdent(column)}) values ($1)`, [
      inserted,
    ]);
    const db = connect(database.url, { schema: app, max: 1 });
    try {
      const handle = tableHandle(db, tableName);
      const rows = await handle.find({
        where: { [column]: where },
        limit: 1,
      });
      expect(rows.map((row) => cellText(row[column]))).toEqual([...expected]);
    } finally {
      await db.close();
    }
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
}

function tableHandle(
  db: { readonly [key: string]: unknown },
  name: string,
): {
  find(input: {
    readonly where: Readonly<Record<string, unknown>>;
    readonly limit: number;
  }): Promise<readonly Readonly<Record<string, unknown>>[]>;
} {
  const handle = db[name];
  if (typeof handle !== "object" || handle === null || !("find" in handle)) {
    throw new Error(`missing table ${name}`);
  }
  return handle as {
    find(input: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly limit: number;
    }): Promise<readonly Readonly<Record<string, unknown>>[]>;
  };
}

async function apply(sql: Sql, app: { readonly catalog: Catalog }): Promise<string> {
  const plan = planMigration({ before: catalog([]), after: app.catalog, name: "ext" });
  const text = plan.steps.map((step) => step.sql).join("\n");
  for (const step of plan.steps) await sql.unsafe(step.sql);
  return text;
}

async function serverMajor(sql: Sql): Promise<number> {
  const rows = await sql<
    { version: string }[]
  >`select current_setting('server_version_num') as version`;
  return Math.floor(Number(rows[0]?.version ?? "0") / 10000);
}

function versionOf(pack: ExtPackRecord, major: number): string {
  if (major === 15) return pack.versions[15];
  if (major === 16) return pack.versions[16];
  if (major === 17) return pack.versions[17];
  if (major === 18) return pack.versions[18];
  throw new Error(`Postgres ${String(major)} is outside 15–18`);
}

async function signatureExists(
  sql: Sql,
  name: string,
  signature: ExtPackRecord["signatures"][number],
): Promise<boolean> {
  if (signature.kind === "function") {
    return functionExists(sql, name, signature.name, signature.args);
  }
  if (signature.kind === "operator") {
    const rows = await sql<{ ok: number }[]>`
      select 1 as ok
      from pg_operator o
      join pg_depend d on d.objid = o.oid and d.classid = 'pg_operator'::regclass and d.deptype = 'e'
      join pg_extension e on e.oid = d.refobjid
      join pg_type l on l.oid = o.oprleft
      join pg_type r on r.oid = o.oprright
      where e.extname = ${name}
        and o.oprname = ${signature.name}
        and l.typname = ${signature.left}
        and r.typname = ${signature.right}
    `;
    return rows.length > 0;
  }
  const rows = await sql<{ ok: number }[]>`
    select 1 as ok
    from pg_opclass oc
    join pg_am am on am.oid = oc.opcmethod
    join pg_depend d on d.objid = oc.oid and d.classid = 'pg_opclass'::regclass and d.deptype = 'e'
    join pg_extension e on e.oid = d.refobjid
    where e.extname = ${name} and oc.opcname = ${signature.name} and am.amname = ${signature.method}
  `;
  return rows.length > 0;
}

async function functionExists(
  sql: Sql,
  extensionName: string,
  fn: string,
  args: string,
): Promise<boolean> {
  const rows = await sql<{ args: string }[]>`
    select pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_depend d on d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
    join pg_extension e on e.oid = d.refobjid
    where e.extname = ${extensionName} and p.proname = ${fn}
  `;
  return rows.some((row) => row.args === args);
}

function cellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function writeProject(cwd: string, url: string, protectedTarget: boolean): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
      "export const app = schema({",
      '  tables: [table("notes", { title: t.text() })],',
      "});",
      "",
    ].join("\n"),
  );
  const database = protectedTarget
    ? `{ url: ${JSON.stringify(url)}, protected: true }`
    : JSON.stringify(url);
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${database},`,
      "});",
      "",
    ].join("\n"),
  );
}

function sourceImport(source: string): string {
  return source.replaceAll(
    'from "okmodel/ext"',
    `from ${JSON.stringify(join(root, "src/dialects/pg/ext/index.ts"))}`,
  );
}

async function available(sql: Sql, name: string): Promise<boolean> {
  const rows = await sql<{ name: string }[]>`
    select name from pg_available_extensions where name = ${name}
  `;
  if (rows.length === 0) {
    console.warn(`${name} is not available on this server; skipping`);
    return false;
  }
  return true;
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
