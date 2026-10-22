/**
 * `okm migrate check` on Postgres: replay, previous catalog, head, and lint.
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { serializeCatalog } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { CHECK_REPLAY_LIMIT, CHECK_SCHEMA_PREFIX } from "../src/tooling/migrate/check.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const ARCHIVABLE_UNIQUE = [
  `const projects = table("projects", { id: t.id({ default: "uuidv4" }), slug: t.text().unique() }, { traits: [archivable()] });`,
  "export const app = schema({ tables: [projects] });",
].join("\n");

postgresTest(
  gate,
  "a clean multi-migration history passes",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey(), title: t.text() })`);
      await cli(cwd, ["generate", "init"]);
      writeSchema(
        cwd,
        `table("items", { id: t.integer().primaryKey(), title: t.text(), note: t.text().nullable() })`,
      );
      await cli(cwd, ["generate", "note"]);
      const text = await capture(["migrate", "check"], cwd);
      expect(text.startsWith("ok 2 migrations\n")).toBe(true);
      expect(text).toContain(CHECK_REPLAY_LIMIT);
      expect(text).toBe(`ok 2 migrations\n${CHECK_REPLAY_LIMIT}\n`);
      expect(await scratchSchemas(cwd)).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a declared citext extension passes migrate check before and after apply",
  async () => {
    await withProject(async ({ cwd, url }) => {
      const sql = openPostgres(url);
      try {
        const ready = await sql<{ ok: boolean }[]>`
          select exists (select 1 from pg_available_extensions where name = 'citext') as ok
        `;
        if (ready[0]?.ok !== true) throw new Error("citext is not available on this server");
        writeCitextSchema(cwd);
        await cli(cwd, ["generate", "citext"]);
        const before = await capture(["migrate", "check"], cwd);
        expect(before.startsWith("ok 1 migrations\n")).toBe(true);
        await cli(cwd, ["migrate", "apply"]);
        const after = await capture(["migrate", "check"], cwd);
        expect(after.startsWith("ok 1 migrations\n")).toBe(true);
        const provision = await capture(["migrate", "check", "--provision"], cwd);
        expect(provision.startsWith("ok 1 migrations\n")).toBe(true);
        const placed = await sql<{ schema: string }[]>`
          select n.nspname as schema
          from pg_extension e
          join pg_namespace n on n.oid = e.extnamespace
          where e.extname = 'citext'
        `;
        expect(placed.map((row) => row.schema)).toEqual(["public"]);
        expect(await scratchSchemas(cwd)).toEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
  90_000,
);

postgresTest(
  gate,
  "a pending migration that drops the column and then the extension passes check and apply (N-98)",
  async () => {
    await withProject(async ({ cwd, url }) => {
      const sql = openPostgres(url);
      try {
        writeCitextSchema(cwd, { id: true });
        await cli(cwd, ["generate", "citext"]);
        await cli(cwd, ["migrate", "apply"]);
        writeSchema(cwd, `table("people", { id: t.integer().primaryKey() })`);
        await generateWithErrors(cwd, ["generate", "drop-citext"]);
        const path = migrationPath(cwd, ".sql");
        const drafted = readFileSync(path, "utf8");
        expect(drafted).toContain('drop extension "citext"');
        writeFileSync(path, allowAll(drafted));
        const before = await extensionPlacement(sql);
        expect(before).toEqual([{ name: "citext", schema: "public" }]);
        expect(await capture(["migrate", "check"], cwd)).toStartWith(
          `ok 2 migrations\n${CHECK_REPLAY_LIMIT}\n`,
        );
        expect(await extensionPlacement(sql)).toEqual(before);
        expect(await scratchSchemas(cwd)).toEqual([]);
        expect(await capture(["migrate", "apply"], cwd)).toContain("applied 0002_drop-citext");
        expect(await extensionPlacement(sql)).toEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
  90_000,
);

postgresTest(
  gate,
  'a default that spells schema "public" inside a string passes check and apply (N-99)',
  async () => {
    await withProject(async ({ cwd, url }) => {
      const sql = openPostgres(url);
      try {
        writeSchema(
          cwd,
          `table("notes", { id: t.integer().primaryKey(), hint: t.text().default('see schema "public"') })`,
        );
        await cli(cwd, ["generate", "init"]);
        expect(readFileSync(migrationPath(cwd, ".sql"), "utf8")).toContain(`'see schema "public"'`);
        expect(await capture(["migrate", "check"], cwd)).toStartWith(
          `ok 1 migrations\n${CHECK_REPLAY_LIMIT}\n`,
        );
        await cli(cwd, ["migrate", "apply"]);
        const stored = await sql<{ expression: string }[]>`
          select pg_get_expr(d.adbin, d.adrelid) as expression
          from pg_attrdef d
          where d.adrelid = 'public.notes'::regclass
        `;
        expect(stored[0]?.expression).toContain(`see schema "public"`);
        expect(await capture(["migrate", "check"], cwd)).toStartWith(
          `ok 1 migrations\n${CHECK_REPLAY_LIMIT}\n`,
        );
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
  90_000,
);

postgresTest(
  gate,
  "an edited stored catalog fails history verification and names the steps",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey(), title: t.text() })`);
      await cli(cwd, ["generate", "init"]);
      writeSchema(
        cwd,
        `table("items", { id: t.integer().primaryKey(), title: t.text(), extra: t.text().nullable() })`,
      );
      const catalog = await catalogOfSchema(cwd);
      writeFileSync(migrationPath(cwd, ".catalog.json"), catalog);
      const error = await rejected(["migrate", "check"], cwd);
      expect(error.code).toBe("OKM1547");
      expect(error.message).toContain("0001_init");
      expect(error.message).toContain("history differs");
      expect(error.message).toContain("extra");
      expect(await scratchSchemas(cwd)).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "two migrations generated from the same parent fail as a fork",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("posts", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "posts"]);
      const postsSql = readFileSync(migrationPath(cwd, ".sql"), "utf8");
      const postsCatalog = readFileSync(migrationPath(cwd, ".catalog.json"), "utf8");
      const postsSchema = readFileSync(join(cwd, "schema.ts"), "utf8");
      rmSync(join(cwd, "migrations"), { recursive: true, force: true });
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "items"]);
      writeFileSync(join(cwd, "migrations", "0002_posts.sql"), postsSql);
      writeFileSync(join(cwd, "migrations", "0002_posts.catalog.json"), postsCatalog);
      writeFileSync(join(cwd, "schema.ts"), postsSchema);
      const error = await rejected(["migrate", "check"], cwd);
      expect(error.code).toBe("OKM1547");
      expect(error.message).toContain(
        "migration 0002_posts was generated from a different parent than 0001_items",
      );
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a column drop labelled expand fails the previous catalog, and contract passes",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(
        cwd,
        `table("items", { id: t.integer().primaryKey(), note: t.text().nullable() })`,
      );
      await cli(cwd, ["generate", "init"]);
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      await generateWithErrors(cwd, ["generate", "drop"]);
      const sqlPath = join(cwd, "migrations", "0002_drop.sql");
      const original = allowDrop(readFileSync(sqlPath, "utf8"));
      writeFileSync(sqlPath, original.replaceAll("-- class: contract", "-- class: expand"));
      const expand = await rejected(["migrate", "check"], cwd);
      expect(expand.code).toBe("OKM1548");
      expect(expand.message).toContain("0002_drop");
      expect(expand.message).toContain("classified expand");
      writeFileSync(sqlPath, original);
      expect(await capture(["migrate", "check"], cwd)).toStartWith(
        `ok 2 migrations\n${CHECK_REPLAY_LIMIT}\n`,
      );
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a stale head fails and the fix says to run okm generate",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "init"]);
      writeSchema(
        cwd,
        `table("items", { id: t.integer().primaryKey(), note: t.text().nullable() })`,
      );
      const error = await rejected(["migrate", "check"], cwd);
      expect(error.code).toBe("OKM1549");
      expect(error.fix.summary).toContain("okm generate");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "an unreasoned drop fails lint, and an override lets it pass",
  async () => {
    await withProject(async ({ cwd }) => {
      await writeDrop(cwd);
      const bare = await rejected(["migrate", "check"], cwd);
      expect(bare.code).toBe("OKM1510");
      expect(bare.message).toContain("OKM1512");
      const sqlPath = join(cwd, "migrations", "0002_drop.sql");
      writeFileSync(sqlPath, allowDrop(readFileSync(sqlPath, "utf8")));
      const allowed = await capture(["migrate", "check"], cwd);
      expect(allowed).toStartWith(`ok 2 migrations\n${CHECK_REPLAY_LIMIT}\n`);
      expect(allowed).toContain("allow 0002_drop step 1 OKM1512 destructive DESTRUCTIVE: ");
      expect(allowed).not.toContain("OKM2300");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "lintFrom skips migrations before that id",
  async () => {
    await withProject(async ({ cwd }) => {
      await writeDrop(cwd);
      writeSchema(
        cwd,
        `table("items", { id: t.integer().primaryKey(), note: t.text().nullable() })`,
      );
      await cli(cwd, ["generate", "restore"]);
      const bare = await rejected(["migrate", "check"], cwd);
      expect(bare.code).toBe("OKM1510");
      writeConfig(cwd, { lintFrom: "0003_restore" });
      expect(await cli(cwd, ["migrate", "check"])).toBe(`ok 3 migrations\n${CHECK_REPLAY_LIMIT}\n`);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "migrate check lists every okm-allow line and warns on a weak reason",
  async () => {
    await withProject(async ({ cwd }) => {
      await writeDrop(cwd);
      const sqlPath = migrationPath(cwd, ".sql");
      writeFileSync(
        sqlPath,
        allowDrop(readFileSync(sqlPath, "utf8")).replace("the column is unused", "ok"),
      );
      const text = await capture(["migrate", "check"], cwd);
      expect(text.startsWith(`ok 2 migrations\n${CHECK_REPLAY_LIMIT}\n`)).toBe(true);
      expect(text).toContain(
        "warning OKM2300 0002_drop step 1: override OKM1512 (destructive) reason is only stop-list words",
      );
      expect(text).toContain("allow 0002_drop step 1 OKM1512 destructive DESTRUCTIVE: ");
      const json = await jsonOf(cwd, ["migrate", "check", "--json"]);
      expect(json.exit).toBe(0);
      expect(json.warnings.map((item) => item.code)).toEqual(["OKM2300"]);
      expect(json.data.allows.map((item) => [item.migration, item.step, item.code])).toEqual([
        ["0002_drop", 1, "OKM1512"],
      ]);
      expect(json.data.allows[0]?.reason.text).toBe("ok");
      expect(json.data.text).toBe(text);
      expect(await scratchSchemas(cwd)).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a protected target is refused, including with --allow-protected",
  async () => {
    await withProject(async ({ cwd, url }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`, { protected: true });
      const refused = await rejected(["migrate", "check"], cwd);
      expect(refused.code).toBe("OKM1850");
      expect(refused.message).toContain("throwaway");
      expect(refused.fix.summary).toContain("throwaway");
      const bypass = await rejected(["migrate", "check", "--allow-protected"], cwd);
      expect(bypass.code).toBe("OKM1850");
      expect(bypass.message).toContain("throwaway");
      const sql = openPostgres(url);
      try {
        const rows = await sql<{ nspname: string }[]>`
        select nspname from pg_namespace where nspname like ${`${CHECK_SCHEMA_PREFIX}%`}
      `;
        expect(rows.map((row) => row.nspname)).toEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "the clean create-from-empty fixture history passes",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("tasks", { id: t.identity(), title: t.text() })`);
      await cli(cwd, ["generate", "tasks"]);
      expect(await capture(["migrate", "check"], cwd)).toBe(
        `ok 1 migrations\n${CHECK_REPLAY_LIMIT}\n`,
      );
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a declared view replays and passes",
  async () => {
    await withProject(async ({ cwd }) => {
      writeModule(
        cwd,
        [
          `const tasks = table("tasks", { id: t.identity(), status: t.text() });`,
          "export const app = schema({",
          "  tables: [tasks],",
          `  views: [view("open_tasks", { columns: [{ name: "id", type: "bigint" }], query: ${JSON.stringify(" SELECT id\n   FROM tasks\n  WHERE status <> 'done'::text;")} })],`,
          "});",
        ].join("\n"),
      );
      await cli(cwd, ["generate", "init"]);
      expect(await capture(["migrate", "check"], cwd)).toBe(
        `ok 1 migrations\n${CHECK_REPLAY_LIMIT}\n`,
      );
      expect(await scratchSchemas(cwd)).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a function that takes a schema enum replays and passes",
  async () => {
    await withProject(async ({ cwd }) => {
      writeModule(
        cwd,
        [
          `const tasks = table("tasks", { id: t.identity(), status: t.enum("task_status", ["todo", "done"]) });`,
          `const isOpen = fn("task_is_open", { arguments: [{ name: "status", type: "task_status" }], returns: "boolean", language: "sql", volatility: "immutable", body: "select status <> 'done'::task_status" });`,
          "export const app = schema({ tables: [tasks], functions: [isOpen] });",
        ].join("\n"),
      );
      await cli(cwd, ["generate", "init"]);
      expect(await capture(["migrate", "check"], cwd)).toBe(
        `ok 1 migrations\n${CHECK_REPLAY_LIMIT}\n`,
      );
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a view that calls a declared function passes okm check",
  async () => {
    await withProject(async ({ cwd }) => {
      writeModule(
        cwd,
        [
          `const tasks = table("tasks", { id: t.identity(), status: t.text() });`,
          `const isOpen = fn("is_open", { arguments: [{ name: "status", type: "text" }], returns: "boolean", language: "sql", volatility: "immutable", body: "select status <> 'done'" });`,
          "export const app = schema({",
          "  tables: [tasks],",
          "  functions: [isOpen],",
          `  views: [view("open_tasks", { columns: [{ name: "id", type: "bigint" }], query: ${JSON.stringify(" SELECT id\n   FROM tasks\n  WHERE is_open(status);")} })],`,
          "});",
        ].join("\n"),
      );
      await cli(cwd, ["generate", "init"]);
      await capture(["migrate", "apply"], cwd);
      expect(await capture(["check"], cwd)).toBe("ok\n");
      expect(await capture(["migrate", "check"], cwd)).toBe(
        `ok 1 migrations\n${CHECK_REPLAY_LIMIT}\n`,
      );
    });
  },
  60_000,
);

postgresTest(
  gate,
  "an archivable table with a unique column has no drift",
  async () => {
    await withProject(async ({ cwd }) => {
      writeModule(cwd, ARCHIVABLE_UNIQUE);
      await cli(cwd, ["generate", "init"]);
      await capture(["migrate", "apply"], cwd);
      expect(await capture(["check"], cwd)).toBe("ok\n");
      expect(await capture(["migrate", "check"], cwd)).toBe(
        `ok 1 migrations\n${CHECK_REPLAY_LIMIT}\n`,
      );
    });
  },
  60_000,
);

postgresTest(
  gate,
  "an archivable unique index stored with the old predicate is cleared by one migration",
  async () => {
    await withProject(async ({ cwd }) => {
      writeModule(cwd, ARCHIVABLE_UNIQUE);
      await cli(cwd, ["generate", "init"]);
      const printed = '("archivedAt" IS NULL)';
      const old = '"archivedAt" is null';
      const sqlPath = migrationPath(cwd, ".sql");
      const catalogPath = migrationPath(cwd, ".catalog.json");
      writeFileSync(sqlPath, readFileSync(sqlPath, "utf8").replaceAll(printed, old));
      const json = (text: string): string => JSON.stringify(text).slice(1, -1);
      writeFileSync(
        catalogPath,
        readFileSync(catalogPath, "utf8").replaceAll(json(printed), json(old)),
      );
      await capture(["migrate", "apply"], cwd);

      const pending = await rejected(["check"], cwd);
      expect(pending.code).toBe("OKM1510");
      expect(pending.message).toContain("OKM1529");
      await generateWithErrors(cwd, ["generate", "archive_predicate"]);
      const upgrade = migrationPath(cwd, ".sql");
      expect(upgrade).toContain("0002_archive_predicate");
      writeFileSync(
        upgrade,
        readFileSync(upgrade, "utf8").replace(
          /^(create unique index concurrently .*)$/m,
          "-- okm-allow OKM1529: rebuilds the same index with the printed predicate\n$1",
        ),
      );
      expect(await capture(["migrate", "apply"], cwd)).toContain("applied 0002_archive_predicate");
      const listed = await capture(["check"], cwd);
      expect(listed).toContain("allow 0002_archive_predicate step 2 OKM1529 data-dependent: ");
      expect(listed.endsWith("ok\n")).toBe(true);
      expect(listed).not.toContain("OKM2300");

      const history = await rejected(["migrate", "check"], cwd);
      expect(history.code).toBe("OKM1547");
      expect(history.message).toContain("0001_init");
    });
  },
  90_000,
);

postgresTest(
  gate,
  "a comment-prefixed truncate fails migrate check and apply (QA-H3)",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("logs", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "init"]);
      const sqlPath = migrationPath(cwd, ".sql");
      writeFileSync(sqlPath, `${readFileSync(sqlPath, "utf8")}\n/* note */ truncate logs;\n`);
      const proc = Bun.spawn(["bun", join(root, "src/tooling/cli.ts"), "migrate", "check"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      expect(code).not.toBe(0);
      expect(stderr).toContain("OKM1510");
      expect(stderr).toContain("OKM1542");
      const applied = await rejected(["migrate", "apply"], cwd);
      expect(applied.code).toBe("OKM1510");
      expect(applied.message).toContain("OKM1542");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a composite and path schema generates, applies, and replays",
  async () => {
    await withProject(async ({ cwd }) => {
      writeTenancySchema(cwd);
      await cli(cwd, ["generate", "init"]);
      const sql = readFileSync(migrationPath(cwd, ".sql"), "utf8");
      expect(sql).toContain('"organization_id"');
      expect(sql).toContain('"workspace_id"');
      expect(sql).toContain("projects");
      expect(await cli(cwd, ["migrate", "apply"])).toContain("applied");
      expect(await cli(cwd, ["migrate", "check"])).toBe(`ok 1 migrations\n${CHECK_REPLAY_LIMIT}\n`);
    });
  },
  60_000,
);

function writeTenancySchema(cwd: string): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { index, one, schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      `import { compositeTenancy, via } from ${source("src/runtime/tenancy/index.ts")};`,
      'const tenancy = compositeTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" });',
      "const organizations = table(",
      '  "organizations",',
      "  { id: t.uuid().primaryKey(), name: t.text() },",
      "  { indexes: (columns) => [index((columns as typeof columns & { organizationId: typeof columns.id }).organizationId)] },",
      ");",
      "const documents = table(",
      '  "documents",',
      '  { id: t.uuid().primaryKey(), title: t.text().unique(), folderId: t.uuid().references("organizations") },',
      "  { indexes: (columns) => {",
      "    const handle = columns as typeof columns & { organizationId: typeof columns.id; workspaceId: typeof columns.id };",
      "    return [index(handle.organizationId, handle.workspaceId)];",
      "  } },",
      ");",
      "const projects = table(",
      '  "projects",',
      '  { id: t.uuid().primaryKey(), name: t.text(), organizationId: t.uuid().references("organizations") },',
      '  { tenancy: via("organization"), relations: { organization: one("organizations", "organizationId") } },',
      ");",
      'export const app = schema({ casing: "snake", tenancy, tables: [organizations, documents, projects] });',
      "",
    ].join("\n"),
  );
}

async function writeDrop(cwd: string): Promise<void> {
  writeSchema(cwd, `table("items", { id: t.integer().primaryKey(), note: t.text().nullable() })`);
  await cli(cwd, ["generate", "init"]);
  writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
  await generateWithErrors(cwd, ["generate", "drop"]);
}

function allowDrop(sql: string): string {
  return sql.replace(
    /^(alter table .* drop column .*)$/m,
    "-- okm-allow OKM1512: the column is unused\n$1",
  );
}

/** Puts an `okm-allow` line with a reason above every statement a drop plan drafted. */
function allowAll(text: string): string {
  return text
    .split("\n")
    .flatMap((line) =>
      /^(alter table .* drop column |drop extension )/.test(line)
        ? [
            `-- okm-allow ${line.startsWith("drop") ? "OKM1517" : "OKM1512"}: nothing else uses it`,
            line,
          ]
        : [line],
    )
    .join("\n");
}

async function extensionPlacement(
  sql: ReturnType<typeof openPostgres>,
): Promise<readonly { readonly name: string; readonly schema: string }[]> {
  return sql<{ name: string; schema: string }[]>`
    select e.extname as name, n.nspname as schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'citext'
  `;
}

function migrationPath(cwd: string, suffix: ".sql" | ".catalog.json"): string {
  const directory = join(cwd, "migrations");
  const name = readdirSync(directory)
    .filter((file) => file.endsWith(suffix))
    .sort()
    .at(-1);
  if (name === undefined) throw new Error(`no ${suffix} in ${directory}`);
  return join(directory, name);
}

async function catalogOfSchema(cwd: string): Promise<string> {
  const imported: unknown = await import(
    `${pathToFileURL(join(cwd, "schema.ts")).href}?edit=${Date.now()}`
  );
  const record = imported as { app?: { catalog?: unknown } };
  const source = record.app?.catalog;
  if (source === undefined) throw new Error("schema.ts must export app");
  return serializeCatalog(source as Parameters<typeof serializeCatalog>[0]);
}

async function scratchSchemas(cwd: string): Promise<readonly string[]> {
  const url = databaseUrl(cwd);
  const sql = openPostgres(url);
  try {
    const rows = await sql<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname like ${`${CHECK_SCHEMA_PREFIX}%`}
    `;
    return rows.map((row) => row.nspname);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function databaseUrl(cwd: string): string {
  const text = readFileSync(join(cwd, "okmodel.config.ts"), "utf8");
  const match = /postgres:\/\/[^"']+/.exec(text);
  if (match === null) throw new Error("config has no database url");
  return match[0];
}

async function withProject(
  body: (context: { cwd: string; url: string }) => Promise<void>,
): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-check-"));
  try {
    writeConfig(cwd, { url: database.url });
    await body({ cwd, url: database.url });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

function writeSchema(
  cwd: string,
  tables: string,
  options?: { readonly protected?: boolean },
): void {
  writeModule(cwd, `export const app = schema({\n  tables: [${tables}],\n});`);
  if (options?.protected === true) writeConfig(cwd, { protected: true });
}

function writeCitextSchema(cwd: string, options?: { readonly id?: boolean }): void {
  const id = options?.id === true ? "id: t.integer().primaryKey(), " : "";
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      `import { citext } from ${source("src/dialects/pg/ext/citext.ts")};`,
      "export const app = schema({",
      `  tables: [table("people", { ${id}email: t.citext() })],`,
      "  extensions: [citext()],",
      "});",
      "",
    ].join("\n"),
  );
}

function writeModule(cwd: string, body: string): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      `import { fn } from ${source("src/dialects/pg/fn/index.ts")};`,
      `import { view } from ${source("src/dialects/pg/view/index.ts")};`,
      `import { archivable } from ${source("src/runtime/traits/index.ts")};`,
      body,
      "",
    ].join("\n"),
  );
}

function writeConfig(
  cwd: string,
  options: { readonly url?: string; readonly protected?: boolean; readonly lintFrom?: string },
): void {
  const url = options.url ?? databaseUrl(cwd);
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  const target =
    options.protected === true
      ? `{ url: ${JSON.stringify(url)}, protected: true }`
      : JSON.stringify(url);
  const lint =
    options.lintFrom === undefined ? "" : `  lintFrom: ${JSON.stringify(options.lintFrom)},\n`;
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${target},`,
      lint.trimEnd(),
      "});",
      "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  const script = [
    `import { OkmError } from ${JSON.stringify(join(root, "src/contracts/error.ts"))};`,
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    "try {",
    `  await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "  process.stdout.write(lines.join(''));",
    "} catch (error) {",
    "  process.stdout.write(lines.join(''));",
    "  if (error instanceof OkmError) {",
    "    process.stderr.write(`error ${error.code}: ${error.message}\\n${error.fix.summary}\\n`);",
    "  }",
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.length > 0 ? stderr : stdout);
  return stdout;
}

/**
 * `okm generate` writes the file then exits 1 on an error finding.
 * Callers that need the file use this instead of {@link cli}.
 */
async function generateWithErrors(cwd: string, argv: readonly string[]): Promise<string> {
  try {
    return await cli(cwd, argv);
  } catch (error) {
    const directory = join(cwd, "migrations");
    const sql = readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .at(-1);
    if (sql === undefined) throw error;
    return join(directory, sql) + "\n";
  }
}

async function capture(argv: readonly string[], cwd: string): Promise<string> {
  const lines: string[] = [];
  await run(argv, { cwd, stdout: (text) => lines.push(text) });
  return lines.join("");
}

async function jsonOf(
  cwd: string,
  argv: readonly string[],
): Promise<{
  readonly exit: number;
  readonly warnings: readonly { readonly code?: string }[];
  readonly data: {
    readonly text: string;
    readonly allows: readonly {
      readonly migration: string;
      readonly step: number;
      readonly code: string;
      readonly reason: { readonly text: string };
    }[];
  };
}> {
  const proc = Bun.spawn(["bun", join(root, "src/tooling/cli.ts"), ...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(stdout) as Awaited<ReturnType<typeof jsonOf>>;
}

async function rejected(argv: readonly string[], cwd: string): Promise<OkmError> {
  try {
    await run(argv, { cwd, stdout: () => {} });
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error(`${argv.join(" ")} should have failed`);
}
