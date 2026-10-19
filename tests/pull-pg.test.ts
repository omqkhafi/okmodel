/**
 * `okm pull` on Postgres: a round trip, refusals, and a read-only role (D275).
 *
 * The built catalog is compared with introspection through `catalogsEqual`,
 * after type spellings and provenance are aligned. Skipped objects are
 * removed from the live side first.
 */

import { expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import { serializeCatalog } from "../src/contracts/catalog/document.js";
import { isDomain } from "../src/contracts/catalog/enum.js";
import { identityKey } from "../src/contracts/catalog/identity.js";
import { normaliseEdges } from "../src/contracts/catalog/object.js";
import type { Catalog, CatalogObject } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { extension } from "../src/dialects/pg/ext/index.js";
import { index, schema, sql, t, table, type AnyTable } from "../src/dialects/pg/index.js";
import { catalogsEqual } from "../src/tooling/migrate/equal.js";
import { unlistedTableFiles } from "../src/tooling/migrate/project.js";
import { pullProject, type PullResult } from "../src/tooling/migrate/pull.js";
import { loadSchema } from "../src/tooling/migrate/project.js";
import { canonicalTypeName } from "../src/tooling/migrate/type-name.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  generateFixture,
  type FixtureColumnType,
  type FixtureTable,
} from "../packages/harness/src/fixtures.js";
import { repoRoot } from "../scripts/root.js";
import { moduleSpecifiers } from "../scripts/specifiers.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const orgs = table(
  "orgs",
  {
    org: t.text(),
    id: t.integer(),
    name: t.text().defaultSql("'acme'"),
  },
  { primaryKey: ["org", "id"] },
);

const authors = table("authors", {
  id: t.uuid().primaryKey().defaultSql("gen_random_uuid()"),
  email: t.citext(),
});

const notes = table(
  "notes",
  {
    id: t.identity(),
    title: t.text(),
    label: t.text(),
    open: t.boolean().defaultSql("true"),
    status: t.enum("note_status", ["open", "closed"]),
    score: t.domain("score", t.integer(), "VALUE > 0"),
    createdAt: t.timestamptz().defaultSql("now()"),
    code: t.varchar(40).nullable(),
    total: t.integer().generated("1"),
    authorId: t.uuid().references("authors", { columns: ["id"], onDelete: "cascade" }),
  },
  {
    unique: { title: ["title"] },
    checks: {
      title_len: (columns) => {
        void columns.title;
        return sql`length(title) > 0`;
      },
    },
    indexes: (columns) => [
      {
        columns: [columns.open.name],
        isUnique: false,
        predicate: "(open IS TRUE)",
        unique() {
          return this;
        },
      },
    ],
  },
);

const rich = schema({
  tables: [orgs, authors, notes],
  extensions: [extension("citext")],
});

const EXTRA = [
  "create index notes_label_idx on notes (label, (lower(label)))",
  "create index notes_title_expr on notes ((lower(title)))",
  "alter table notes add column note xml",
  "create sequence extra_seq",
  "create function note_open(s note_status) returns boolean language sql immutable as $$ select s = 'open' $$",
  "create view open_notes as select id, title from notes where open",
];

postgresTest(
  gate,
  "pull round-trips a schema, lists what table() cannot say, and is deterministic",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = tempProject();
    const again = tempProject();
    try {
      await apply(database.url, [...renderCatalog(rich.catalog, "public"), ...EXTRA]);
      writeConfig(cwd, database.url);
      const first = await pullProject(cwd, []);
      const built = await loadSchema(cwd, "./schema.ts");
      const live = await readLive(database.url);
      expectEqual(align(live, keysOf(first)), align(built.catalog, new Set()));
      expect(kindsOf(built.catalog)).toEqual(
        expect.arrayContaining([
          "table",
          "column",
          "constraint",
          "index",
          "type",
          "sequence",
          "extension",
        ]),
      );
      expect(hasCompositeKey(built.catalog)).toBe(true);
      expect(hasPredicate(built.catalog)).toBe(true);
      expect(hasExpression(built.catalog)).toBe(true);
      expect(hasEnum(built.catalog)).toBe(true);
      expect(hasDomain(built.catalog)).toBe(true);
      expect(hasDefault(built.catalog)).toBe(true);
      expect(first.text).toContain("note_open(note_status): verified");
      expect(first.text).toContain("open_notes: verified");
      expect(first.text).toContain("aggregates: 2");
      expect(first.text).toContain("procedures: 0");
      expect(first.text).toContain("event triggers: 0");
      expect(first.text).toContain("rules: 0");
      expect(readFileSync(join(cwd, "schema.ts"), "utf8")).toContain("fn(");
      expect(first.text).toContain("notes.note");
      expect(first.text).toContain("extra_seq");
      expect(first.text).toContain("notes_title_expr");
      const names = readdirSync(join(cwd, "tables"));
      const source = readFileSync(join(cwd, "schema.ts"), "utf8");
      expect(unlistedTableFiles(source, names)).toEqual([]);

      writeConfig(again, database.url);
      await pullProject(again, ["--out", "one"]);
      await pullProject(again, ["--out", "two"]);
      expect(readTree(join(again, "one"))).toEqual(readTree(join(again, "two")));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(again, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "pull round-trips the reference app and lists its function and views",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = tempProject();
    try {
      linkPackage();
      const spec = "../packages/reference-app/src/schema.ts";
      const imported: unknown = await import(spec);
      const app = schemaExport(imported);
      await apply(database.url, renderCatalog(app.catalog, "public"));
      writeConfig(cwd, database.url);
      const pulled = await pullProject(cwd, ["--out", "adopted"]);
      const built = await loadSchema(cwd, "./adopted/schema.ts");
      const live = await readLive(database.url);
      expectEqual(align(live, keysOf(pulled)), align(built.catalog, new Set()));
      expect(pulled.text).toContain("task_is_open(task_status): verified");
      expect(pulled.text).toContain("active_projects: verified");
      expect(pulled.text).toContain("open_tasks: verified");
      expect(pulled.text).not.toContain("candidate-only");
      expect(pulled.text).toContain("policies: 0");
      const source = readFileSync(join(cwd, "adopted/schema.ts"), "utf8");
      expect(source).toContain("fn(");
      expect(source).toContain('view("active_projects"');
      expect(source).toContain('view("open_tasks"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "pull round-trips functions, a trigger, a view over a view, and a materialized view",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = tempProject();
    try {
      await apply(database.url, [
        "create table items (id integer primary key, name text not null)",
        "create function item_name(n integer) returns text language sql stable as $$ select name from items where id = n $$",
        "create function item_touch() returns trigger language plpgsql as $$ begin perform 1 from items; return new; end $$",
        "create function item_count() returns bigint language sql begin atomic select count(*) from items; end",
        "create trigger items_touch before update on items for each row execute function item_touch()",
        "create view item_names as select id, name from items",
        "create view item_name_count as select count(*) as n from item_names",
        "create materialized view item_mat as select id, name from items with no data",
        "create unique index item_mat_id on item_mat (id)",
      ]);
      writeConfig(cwd, database.url);
      const pulled = await pullProject(cwd, ["--out", "adopted"]);
      const built = await loadSchema(cwd, "./adopted/schema.ts");
      const live = await readLive(database.url);
      expectEqual(align(live, keysOf(pulled)), align(built.catalog, new Set()));
      expect(pulled.text).toContain("item_name(integer): verified");
      expect(pulled.text).toContain("item_count(): verified");
      expect(pulled.text).toContain("item_touch(): candidate-only");
      expect(pulled.text).toContain("item_names: verified");
      expect(pulled.text).toContain("item_name_count: verified");
      expect(pulled.text).toContain("item_mat: verified");
      expect(pulled.text).toContain("items.items_touch: verified");
      const source = readFileSync(join(cwd, "adopted/schema.ts"), "utf8");
      expect(source).toContain("candidate-only: a plpgsql body is not proved by creation");
      expect(source).toContain("dependsOn: [items]");
      expect(source).toContain("verified: scratch replay created this function");
      expect(source).toContain('view("item_names"');
      expect(source).toContain("materializedView(");
      expect(source).not.toContain("(q) =>");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a missed SQL dependency fails the scratch replay and plpgsql stays candidate-only",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = tempProject();
    try {
      await apply(database.url, [
        "create table notes (id integer primary key)",
        "create function peek() returns regclass language sql as $$ select 'notes'::regclass $$",
        "create function touch_note() returns trigger language plpgsql as $$ begin perform 1 from notes; return new; end $$",
      ]);
      writeConfig(cwd, database.url);
      const pulled = await pullProject(cwd, ["--out", "adopted"]);
      expect(pulled.text).toContain("peek(): unverified");
      expect(pulled.text).toContain("touch_note(): candidate-only");
      const source = readFileSync(join(cwd, "adopted/schema.ts"), "utf8");
      expect(source).toContain("unverified: scratch replay did not create this function");
      expect(source).toContain("candidate-only: a plpgsql body is not proved by creation");
      expect(source).toContain("dependsOn: [notes]");
      const built = await loadSchema(cwd, "./adopted/schema.ts");
      expect(built.catalog.objects.some((object) => object.kind === "function")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "pull of 200 tables matches introspection",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = tempProject();
    try {
      const fixture = generateFixture({ seed: 1, tables: 200 });
      const builtFrom = schema({ tables: fixture.tables.map((item) => fixtureTable(item)) });
      await apply(database.url, renderCatalog(builtFrom.catalog, "public"));
      writeConfig(cwd, database.url);
      const samples: number[] = [];
      for (let index = 0; index < 10; index += 1) {
        const out = `run-${String(index)}`;
        const started = performance.now();
        const pulled = await pullProject(cwd, ["--out", out]);
        samples.push(performance.now() - started);
        if (index === 0) {
          const built = await loadSchema(cwd, `./${out}/schema.ts`);
          const live = await readLive(database.url);
          expectEqual(align(live, keysOf(pulled)), align(built.catalog, new Set()));
          expect(built.tables.length).toBe(200);
        }
      }
      const mid = median(samples);
      console.log(`pull 200 tables median ${mid.toFixed(1)} ms`);
      expect(mid).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  180_000,
);

postgresTest(
  gate,
  "pull refuses an existing file and an empty namespace",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = tempProject();
    try {
      await apply(database.url, renderCatalog(rich.catalog, "public"));
      writeConfig(cwd, database.url);
      writeFileSync(join(cwd, "schema.ts"), "export {}\n");
      const refused = await refusal(pullProject(cwd, []));
      expect(refused.code).toBe("OKM1855");
      expect(refused.message).toContain("schema.ts");
      expect(refused.fix.summary).toContain("--out");
      const empty = tempProject();
      try {
        writeConfig(empty, database.url);
        await apply(database.url, ["create schema empty_pull"]);
        const emptyNamespace = await refusal(pullProject(empty, ["--schema", "empty_pull"]));
        expect(emptyNamespace.message).toContain("no tables");
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "pull reads a protected target as a role that cannot write",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = tempProject();
    const role = `pull_ro_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const admin = openPostgres(database.url);
    try {
      await apply(database.url, renderCatalog(rich.catalog, "public"));
      await admin.unsafe(
        `create role ${role} login password 'pull-ro' nosuperuser nocreatedb nocreaterole`,
      );
      const readerUrl = urlAs(database.url, role, "pull-ro");
      const reader = openPostgres(readerUrl);
      let wrote = false;
      try {
        await reader.unsafe("create table denied (id integer)");
        wrote = true;
      } catch {
        wrote = false;
      } finally {
        await reader.end({ timeout: 5 });
      }
      expect(wrote).toBe(false);
      writeConfig(cwd, readerUrl, true);
      const pulled = await pullProject(cwd, ["--out", "adopted"]);
      expect(pulled.text).toContain("pulled");
      expect(pulled.text).toContain("not pulled yet");
    } finally {
      await admin.unsafe(`drop role if exists ${role}`);
      await admin.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "pull reports an unreachable target",
  async () => {
    const cwd = tempProject();
    try {
      writeConfig(cwd, "postgres://okm:okm@127.0.0.1:1/okm");
      const lost = await refusal(pullProject(cwd, []));
      expect(lost.kind).toBe("unavailable");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  20_000,
);

postgresTest(
  gate,
  "pull round-trips a hostile-name database with stable file stems",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = tempProject();
    try {
      await apply(database.url, [
        'create table "Tasks" (id integer primary key)',
        'create table "tasks" (id integer primary key, "__proto__" text not null)',
        'create table "con" (id integer primary key)',
        'create table "aux" (id integer primary key)',
        'create table "nul" (id integer primary key)',
        'create table "com1" (id integer primary key)',
        'create table "my table" (id integer primary key)',
        'create table "say ""hi""" (id integer primary key)',
        "create table class (id integer primary key)",
        'create table "pairs" (org text not null, num integer not null, primary key (org, num))',
        'create table "pair_notes" (org text not null, num integer not null, note text not null, primary key (org, num, note), foreign key (org, num) references "pairs" (org, num))',
        'create table "kids" (id integer primary key, task_id integer not null references "Tasks" (id))',
      ]);
      writeFileSync(
        join(cwd, "okmodel.config.ts"),
        `import { defineConfig } from "okmodel/migrate";

export default defineConfig({
  schema: "./adopted/schema.ts",
  tables: "./adopted/tables",
  database: ${JSON.stringify(database.url)},
});
`,
      );
      const pulled = await pullProject(cwd, ["--out", "adopted"]);
      const names = readdirSync(join(cwd, "adopted/tables")).sort();
      expect(names).toContain("Tasks.ts");
      expect(names).toContain("tasks_2.ts");
      expect(names).toContain("_con.ts");
      expect(names).toContain("_aux.ts");
      expect(names).toContain("_nul.ts");
      expect(names).toContain("_com1.ts");
      expect(names).toContain("my_table.ts");
      expect(names.some((name) => /^con\.ts$/i.test(name))).toBe(false);
      const tasksText = readFileSync(join(cwd, "adopted/tables/tasks_2.ts"), "utf8");
      expect(tasksText).toContain("export const tasks_2");
      expect(tasksText).toContain('sqlName: "tasks"');
      expect(tasksText).toContain('["__proto__"]:');
      const kidsText = readFileSync(join(cwd, "adopted/tables/kids.ts"), "utf8");
      expect(kidsText).toContain('.references("Tasks"');
      expect(pulled.text).toContain("references() takes one local column");
      const built = await loadSchema(cwd, "./adopted/schema.ts");
      const live = await readLive(database.url);
      expectEqual(align(live, keysOf(pulled)), align(built.catalog, new Set()));
      expect(hasCompositeKey(built.catalog)).toBe(true);
      const source = readFileSync(join(cwd, "adopted/schema.ts"), "utf8");
      expect(unlistedTableFiles(source, names)).toEqual([]);
      const { checkProject } = await import("../src/tooling/migrate/project.js");
      await checkProject(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "pull keeps .ts on relative imports; node and bunx check print ok; tsc accepts the output",
  async () => {
    if (!existsSync(join(root, "dist", "okm.js"))) {
      throw new Error("dist/okm.js is missing. bun run build writes it.");
    }
    const database = await createIsolatedDatabase();
    const cwd = tempProject();
    try {
      await apply(database.url, [
        "create table parents (id integer primary key)",
        "create table kids (id integer primary key, parent_id integer not null references parents (id))",
      ]);
      writeConfig(cwd, database.url);
      await pullProject(cwd, []);
      const relativeImports: string[] = [];
      for (const name of [
        "schema.ts",
        ...readdirSync(join(cwd, "tables")).map((n) => `tables/${n}`),
      ]) {
        const path = join(cwd, name);
        if (!path.endsWith(".ts")) continue;
        const text = readFileSync(path, "utf8");
        for (const specifier of moduleSpecifiers(text, path)) {
          if (specifier.startsWith(".")) relativeImports.push(specifier);
        }
      }
      expect(relativeImports.length).toBeGreaterThan(0);
      expect(relativeImports.every((specifier) => specifier.endsWith(".ts"))).toBe(true);
      expect(relativeImports).toEqual(["./tables/kids.ts", "./tables/parents.ts"]);

      linkOkmodel(cwd);
      const nodeCheck = Bun.spawnSync(["node", join(root, "dist/okm.js"), "check"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const nodeOut = `${nodeCheck.stdout.toString()}${nodeCheck.stderr.toString()}`;
      expect(nodeCheck.exitCode, nodeOut).toBe(0);
      expect(nodeOut).toContain("ok");

      const bunxCheck = Bun.spawnSync(["bunx", "okm", "check"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${join(cwd, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
        },
      });
      const bunxOut = `${bunxCheck.stdout.toString()}${bunxCheck.stderr.toString()}`;
      expect(bunxCheck.exitCode, bunxOut).toBe(0);
      expect(bunxOut).toContain("ok");

      expectTsc(cwd, {
        module: "esnext",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        noEmit: true,
      });
      expectTsc(cwd, {
        module: "nodenext",
        moduleResolution: "nodenext",
        allowImportingTsExtensions: true,
        noEmit: true,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "pull without oxfmt on PATH still writes the report",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = tempProject();
    const previous = process.env.PATH;
    try {
      await apply(database.url, ["create table items (id integer primary key)"]);
      writeConfig(cwd, database.url);
      writeFileSync(join(cwd, ".oxfmtrc.json"), "{}\n");
      process.env.PATH = "/usr/bin:/bin";
      const notices: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        notices.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return write(chunk, ...(rest as []));
      }) as typeof process.stderr.write;
      try {
        const pulled = await pullProject(cwd, ["--out", "adopted"]);
        expect(pulled.text).toContain("pulled");
        expect(existsSync(join(cwd, "adopted/schema.ts"))).toBe(true);
        expect(notices.some((line) => line.includes("oxfmt missing or failed"))).toBe(true);
      } finally {
        process.stderr.write = write;
      }
    } finally {
      process.env.PATH = previous;
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

function linkPackage(): void {
  const directory = join(root, "packages/reference-app/node_modules");
  const link = join(directory, "okmodel");
  if (existsSync(link)) return;
  mkdirSync(directory, { recursive: true });
  symlinkSync(root, link);
}

function linkOkmodel(cwd: string): void {
  writeFileSync(
    join(cwd, "package.json"),
    `${JSON.stringify({
      name: "okm-pull-ext",
      private: true,
      type: "module",
      dependencies: { okmodel: `file:${root}` },
    })}\n`,
  );
  const install = Bun.spawnSync(["bun", "install"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (install.exitCode !== 0) {
    throw new Error(`bun install failed\n${install.stdout.toString()}${install.stderr.toString()}`);
  }
}

function expectTsc(
  cwd: string,
  options: {
    readonly module: string;
    readonly moduleResolution: string;
    readonly allowImportingTsExtensions: boolean;
    readonly noEmit: boolean;
  },
): void {
  writeFileSync(
    join(cwd, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: true,
        target: "es2023",
        ...options,
      },
      files: ["schema.ts"],
    })}\n`,
  );
  const proc = Bun.spawnSync(["bunx", "tsc", "--pretty", "false", "-p", cwd], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  expect(proc.exitCode, output).toBe(0);
}

function schemaExport(value: unknown): { readonly catalog: Catalog } {
  if (typeof value !== "object" || value === null || !("default" in value)) {
    throw new Error("The reference app must default-export a schema.");
  }
  const exported = value.default;
  if (typeof exported !== "object" || exported === null || !("catalog" in exported)) {
    throw new Error("The reference app schema has no catalog.");
  }
  return exported as { readonly catalog: Catalog };
}

function fixtureTable(item: FixtureTable): AnyTable {
  const columns: Record<string, object> = {};
  for (const column of item.columns) {
    columns[column.name] = fixtureColumn(item, column);
  }
  const unique: Record<string, readonly string[]> = {};
  for (const key of item.uniques) unique[key.columns.join("_")] = [...key.columns];
  return table(item.name, columns, {
    ...(Object.keys(unique).length > 0 ? { unique } : {}),
    ...(item.indexes.length > 0
      ? {
          indexes: (handles: Readonly<Record<string, { readonly name: string }>>) =>
            item.indexes.map((idx) =>
              index(
                ...idx.columns.map((name) => {
                  const handle = handles[name];
                  if (handle === undefined) throw new Error(`Missing ${item.name}.${name}`);
                  return handle;
                }),
              ),
            ),
        }
      : {}),
  });
}

type FixtureBuilder = {
  nullable(): FixtureBuilder;
  primaryKey(): FixtureBuilder;
  references(table: string, options: { readonly columns: readonly string[] }): FixtureBuilder;
};

function fixtureColumn(
  item: FixtureTable,
  column: FixtureTable["columns"][number],
): FixtureBuilder {
  let builder = fixtureScalar(column.type);
  if (column.nullable) builder = builder.nullable();
  if (item.primaryKey.length === 1 && item.primaryKey[0] === column.name) {
    builder = builder.primaryKey();
  }
  const foreign = item.foreignKeys.find(
    (key) => key.columns.length === 1 && key.columns[0] === column.name,
  );
  if (foreign !== undefined) {
    builder = builder.references(foreign.refTable, { columns: [...foreign.refColumns] });
  }
  return builder;
}

function fixtureScalar(type: FixtureColumnType): FixtureBuilder {
  switch (type) {
    case "int4":
      return t.integer() as unknown as FixtureBuilder;
    case "int8":
      return t.bigint() as unknown as FixtureBuilder;
    case "text":
      return t.text() as unknown as FixtureBuilder;
    case "bool":
      return t.boolean() as unknown as FixtureBuilder;
    case "timestamptz":
      return t.timestamptz() as unknown as FixtureBuilder;
    case "uuid":
      return t.uuid() as unknown as FixtureBuilder;
    case "numeric":
      return t.numeric() as unknown as FixtureBuilder;
    case "jsonb":
      return t.jsonb() as unknown as FixtureBuilder;
    case "bytea":
      return t.bytea() as unknown as FixtureBuilder;
    case "float8":
      return t.double() as unknown as FixtureBuilder;
  }
}

/**
 * Makes two catalogs comparable with {@link catalogsEqual}.
 *
 * Provenance becomes the introspection stamp, and type names use the long
 * spelling. An identity column's sequence edge is what `schema()` stores.
 * Introspection leaves that edge, and the sequence's table edge, empty.
 */
function align(source: Catalog, drop: ReadonlySet<string>): Catalog {
  const sequences = new Set<string>();
  for (const object of source.objects) {
    if (object.kind !== "sequence" || drop.has(identityKey(object.identity))) continue;
    sequences.add(object.identity.name);
  }
  const owners = new Map<string, string>();
  for (const object of source.objects) {
    if (object.kind !== "column" || object.definition.identity === undefined) continue;
    if (drop.has(identityKey(object.identity))) continue;
    owners.set(
      `${object.identity.parent.name}_${object.identity.name}_seq`,
      object.identity.parent.name,
    );
  }
  const objects: CatalogObject[] = [];
  for (const object of source.objects) {
    if (drop.has(identityKey(object.identity))) continue;
    objects.push(stamp(object, sequences, owners));
  }
  return catalog(objects);
}

function stamp(
  object: CatalogObject,
  sequences: ReadonlySet<string>,
  owners: ReadonlyMap<string, string>,
): CatalogObject {
  const provenance =
    object.kind === "extension" ? object.provenance : { origin: "file" as const, name: "database" };
  if (object.kind === "column") {
    const targets = object.dependencies.map((edge) => edge.target);
    if (object.definition.identity !== undefined) {
      const name = `${object.identity.parent.name}_${object.identity.name}_seq`;
      if (sequences.has(name)) {
        targets.push({ kind: "sequence", namespace: object.identity.parent.namespace, name });
      }
    }
    return {
      ...object,
      provenance,
      dependencies: normaliseEdges(targets),
      definition: {
        ...object.definition,
        dataType: canonicalTypeName(object.definition.dataType),
      },
    };
  }
  if (object.kind === "type" && isDomain(object.definition)) {
    return {
      ...object,
      provenance,
      definition: { ...object.definition, base: canonicalTypeName(object.definition.base) },
    };
  }
  if (object.kind === "view" || object.kind === "materializedView") {
    return { ...object, provenance, dependencies: [] };
  }
  if (object.kind === "function" && object.definition.atomic !== true) {
    return { ...object, provenance, dependencies: [] };
  }
  if (object.kind === "sequence") {
    const targets = object.dependencies.map((edge) => edge.target);
    const owner = owners.get(object.identity.name);
    if (
      owner !== undefined &&
      !targets.some((target) => target.kind === "table" && target.name === owner)
    ) {
      targets.push({ kind: "table", namespace: object.identity.namespace, name: owner });
    }
    return {
      ...object,
      provenance,
      dependencies: normaliseEdges(targets),
      definition: {
        ...object.definition,
        dataType: sequenceType(canonicalTypeName(object.definition.dataType)),
      },
    };
  }
  return { ...object, provenance };
}

function sequenceType(typeName: string): "smallint" | "integer" | "bigint" {
  if (typeName === "smallint" || typeName === "integer" || typeName === "bigint") return typeName;
  return "bigint";
}

function keysOf(result: PullResult): Set<string> {
  return new Set(result.skipped.map((item) => item.key));
}

async function refusal(run: Promise<unknown>): Promise<OkmError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("okm pull should have refused");
}

function copyRow(row: object): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) copy[key] = value;
  return copy;
}

function expectEqual(live: Catalog, pulled: Catalog): void {
  if (catalogsEqual(live, pulled)) return;
  const left = serializeCatalog(live);
  const right = serializeCatalog(pulled);
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  const from = Math.max(0, index - 120);
  throw new Error(
    `catalogs differ at ${String(index)} of ${String(left.length)}/${String(right.length)}\nlive ${left.slice(from, index + 160)}\npull ${right.slice(from, index + 160)}`,
  );
}

function kindsOf(source: Catalog): string[] {
  return [...new Set(source.objects.map((object) => object.kind))].sort();
}

function hasCompositeKey(source: Catalog): boolean {
  return source.objects.some(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "primaryKey" &&
      object.definition.columns.length > 1,
  );
}

function hasPredicate(source: Catalog): boolean {
  return source.objects.some(
    (object) => object.kind === "index" && object.definition.predicate !== undefined,
  );
}

function hasExpression(source: Catalog): boolean {
  return source.objects.some(
    (object) => object.kind === "index" && object.definition.expression !== undefined,
  );
}

function hasEnum(source: Catalog): boolean {
  return source.objects.some((object) => object.kind === "type" && !isDomain(object.definition));
}

function hasDomain(source: Catalog): boolean {
  return source.objects.some((object) => object.kind === "type" && isDomain(object.definition));
}

function hasDefault(source: Catalog): boolean {
  return source.objects.some(
    (object) => object.kind === "column" && object.definition.defaultExpression !== undefined,
  );
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

async function readLive(url: string): Promise<Catalog> {
  const { introspectSchema } = await import("../src/dialects/pg/introspect.js");
  const sql = openPostgres(url);
  try {
    return await introspectSchema(
      {
        async query(text, params) {
          const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
          return rows.map((row) => copyRow(row));
        },
      },
      "public",
      "public",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function apply(url: string, statements: readonly string[]): Promise<void> {
  const sql = openPostgres(url);
  try {
    for (const statement of statements) {
      if (statement.trim().length === 0) continue;
      await sql.unsafe(statement);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function writeConfig(cwd: string, url: string, protectedTarget = false): void {
  const database = protectedTarget
    ? `{ url: ${JSON.stringify(url)}, protected: true }`
    : JSON.stringify(url);
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    `import { defineConfig } from "okmodel/migrate";

export default defineConfig({
  schema: "./schema.ts",
  tables: "./tables",
  database: ${database},
});
`,
  );
}

function tempProject(): string {
  return mkdtempSync(join(root, ".okm-pull-"));
}

function urlAs(base: string, user: string, password: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.href;
}

function readTree(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    )) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else out[path.slice(directory.length)] = readFileSync(path, "utf8");
    }
  };
  walk(directory);
  return out;
}
