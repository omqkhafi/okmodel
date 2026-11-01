/**
 * Guides handbook fences run on a real Postgres.
 *
 * Runtime guides print `text` fences as stdout.
 * Migration guides replay the CLI and match the printed plan and errors.
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import type { Catalog } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";

const root = join(import.meta.dir, "..");
const cli = join(root, "src/tooling/cli.ts");
const guides = join(root, "site/content/docs/guides");

const imports: readonly (readonly [string, string])[] = [
  ["okmodel/pg/postgresjs", join(root, "src/runtime/pg/postgresjs.ts")],
  ["okmodel/pg", join(root, "src/dialects/pg/index.ts")],
  ["okmodel/traits", join(root, "src/runtime/traits/index.ts")],
  ["okmodel/tenancy", join(root, "src/runtime/tenancy/index.ts")],
  ["okmodel/warnings", join(root, "src/runtime/warnings/index.ts")],
  ["okmodel/testing", join(root, "src/tooling/testing/index.ts")],
  ["okmodel/migrate", join(root, "src/tooling/migrate/index.ts")],
  ["okmodel", join(root, "src/contracts/index.ts")],
];

const gate = await loadPostgresGate();

type Fence = { readonly lang: string; readonly title: string; readonly body: string };

type SoftDelete = {
  readonly app?: { readonly catalog: Catalog };
  retire?(url: string): Promise<void>;
};

type Tenancy = {
  readonly app?: { readonly catalog: Catalog };
  isolate?(url: string): Promise<void>;
};

type Isolation = {
  prove?(url: string): Promise<void>;
};

type Page = {
  readonly app?: { readonly catalog: Catalog };
  list?(url: string): Promise<void>;
};

postgresTest(
  gate,
  "the soft-delete guide archives, hides, and restores a row",
  async () => {
    const text = readFileSync(join(guides, "soft-delete.mdx"), "utf8");
    expect(titles(text)).toEqual(["ts:archive.ts", "text:archive.out"]);
    const example = await load<SoftDelete>(text, "archive.ts");
    await apply(example, async (url) => {
      if (example.retire === undefined) throw new Error("archive.ts exports no retire");
      expect(await capture(() => example.retire!(url))).toBe(body(text, "text", "archive.out"));
    });
  },
  60_000,
);

postgresTest(
  gate,
  "the multi-tenant guide isolates tenants and prints OKM2005 and OKM1120",
  async () => {
    const text = readFileSync(join(guides, "multi-tenant.mdx"), "utf8");
    expect(titles(text)).toEqual([
      "ts:tenancy.ts",
      "text:tenancy.out",
      "ts:isolation.ts",
      "text:isolation.out",
    ]);
    const example = await load<Tenancy>(text, "tenancy.ts");
    await apply(example, async (url) => {
      if (example.isolate === undefined) throw new Error("tenancy.ts exports no isolate");
      expect(await capture(() => example.isolate!(url))).toBe(body(text, "text", "tenancy.out"));
    });
  },
  60_000,
);

postgresTest(
  gate,
  "the multi-tenant guide isolation() check prints the report",
  async () => {
    const text = readFileSync(join(guides, "multi-tenant.mdx"), "utf8");
    const example = await load<Tenancy>(text, "tenancy.ts");
    const isolation = await loadWithSibling<Isolation>(text, "isolation.ts", "tenancy.ts");
    await apply(example, async (url) => {
      if (isolation.prove === undefined) throw new Error("isolation.ts exports no prove");
      expect(await capture(() => isolation.prove!(url))).toBe(body(text, "text", "isolation.out"));
    });
  },
  60_000,
);

postgresTest(
  gate,
  "the paginate guide pages a list and warns on an unstable find",
  async () => {
    const text = readFileSync(join(guides, "paginate.mdx"), "utf8");
    expect(titles(text)).toEqual(["ts:page.ts", "text:page.out"]);
    const example = await load<Page>(text, "page.ts");
    await apply(example, async (url) => {
      if (example.list === undefined) throw new Error("page.ts exports no list");
      expect(await capture(() => example.list!(url))).toBe(body(text, "text", "page.out"));
    });
  },
  60_000,
);

postgresTest(
  gate,
  "the required-column guide plans refuse, nullable add, and tighten",
  async () => {
    const text = readFileSync(join(guides, "required-column.mdx"), "utf8");
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-guides-col-"));
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;
    try {
      writeFileSync(
        join(cwd, "okmodel.config.ts"),
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};
export default defineConfig({ schema: "./schema.ts", database: process.env.DATABASE_URL! });
`,
      );
      writeSchema(
        cwd,
        `const notes = table("notes", { id: t.identity().primaryKey(), title: t.text() });`,
      );
      expect(cliProc(cwd, ["generate", "init"]).status).toBe(0);
      expect(cliProc(cwd, ["migrate", "apply"]).status).toBe(0);

      writeSchema(
        cwd,
        `const notes = table("notes", { id: t.identity().primaryKey(), title: t.text(), body: t.text() });`,
      );
      const refused = cliProc(cwd, ["migrate", "plan", "add-body"]);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe(body(text, "text", "plan-required.out"));
      expect(withoutConfig(refused.stderr)).toBe(body(text, "text", "lint.err"));

      writeSchema(
        cwd,
        `const notes = table("notes", { id: t.identity().primaryKey(), title: t.text(), body: t.text().nullable() });`,
      );
      const nullable = cliProc(cwd, ["migrate", "plan", "add-body"]);
      expect(nullable.status).toBe(0);
      expect(nullable.stdout).toBe(body(text, "text", "plan-nullable.out"));
      expect(cliProc(cwd, ["generate", "add-body"]).status).toBe(0);
      expect(cliProc(cwd, ["migrate", "apply"]).status).toBe(0);

      const sql = openPostgres(database.url);
      try {
        await sql.unsafe(`insert into notes (title) values ('Hello')`);
        await sql.unsafe(body(text, "sql", "backfill.sql").trim());
      } finally {
        await sql.end({ timeout: 5 });
      }

      writeSchema(
        cwd,
        `const notes = table("notes", { id: t.identity().primaryKey(), title: t.text(), body: t.text() });`,
      );
      const requirePlan = cliProc(cwd, ["migrate", "plan", "require-body"]);
      expect(requirePlan.status).toBe(0);
      expect(requirePlan.stdout).toBe(body(text, "text", "plan-require.out"));
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "the migrations-in-ci guide matches protected check, contract refusal, and drift",
  async () => {
    const text = readFileSync(join(guides, "migrations-in-ci.mdx"), "utf8");
    const ci = await createIsolatedDatabase();
    const production = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-guides-ci-"));
    try {
      writeFileSync(
        join(cwd, "okmodel.config.ts"),
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};
export default defineConfig({
  schema: "./schema.ts",
  targets: {
    ci: ${JSON.stringify(ci.url)},
    production: { url: ${JSON.stringify(production.url)}, protected: true },
  },
});
`,
      );
      writeSchema(
        cwd,
        `const notes = table("notes", { id: t.identity().primaryKey(), title: t.text(), body: t.text().nullable() });`,
      );
      expect(cliProc(cwd, ["generate", "init"]).status).toBe(0);
      expect(cliProc(cwd, ["migrate", "apply", "--target", "ci"]).status).toBe(0);
      expect(
        cliProc(cwd, ["migrate", "apply", "--target", "production", "--allow-protected"]).status,
      ).toBe(0);

      const checkProtected = cliProc(cwd, ["migrate", "check", "--target", "production"]);
      expect(checkProtected.status).toBe(4);
      expect(withoutConfig(`${checkProtected.stdout}${checkProtected.stderr}`)).toBe(
        body(text, "text", "check-protected.err"),
      );

      const sql = openPostgres(production.url);
      try {
        await sql.unsafe(`update notes set body = '' where body is null`);
      } finally {
        await sql.end({ timeout: 5 });
      }
      writeSchema(
        cwd,
        `const notes = table("notes", { id: t.identity().primaryKey(), title: t.text(), body: t.text() });`,
      );
      expect(cliProc(cwd, ["generate", "require-body"]).status).toBe(0);
      const contract = cliProc(cwd, ["migrate", "apply", "--target", "production"]);
      expect(contract.status).toBe(4);
      expect(withoutConfig(`${contract.stdout}${contract.stderr}`)).toBe(
        body(text, "text", "contract-protected.err"),
      );

      expect(cliProc(cwd, ["migrate", "apply", "--target", "ci"]).status).toBe(0);
      const driftSql = openPostgres(ci.url);
      try {
        await driftSql.unsafe(`alter table notes add column drift text`);
      } finally {
        await driftSql.end({ timeout: 5 });
      }
      const drift = cliProc(cwd, ["check", "--target", "ci"]);
      expect(drift.status).toBe(1);
      expect(withoutConfig(`${drift.stdout}${drift.stderr}`)).toBe(body(text, "text", "drift.err"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await ci.close();
      await production.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "the from-prisma guide pull config typechecks and pull writes files",
  async () => {
    const text = readFileSync(join(guides, "from-prisma.mdx"), "utf8");
    expect(titles(text)).toEqual(["sh:pull.sh", "ts:pull-config.ts"]);
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    const cwd = mkdtempSync(join(tmpdir(), "okm-guides-pull-"));
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;
    try {
      await admin.unsafe(
        `create table notes (id bigint generated always as identity primary key, title text not null)`,
      );
      writeFileSync(join(cwd, "okmodel.config.ts"), rewrite(body(text, "ts", "pull-config.ts")));
      const pulled = cliProc(cwd, ["pull", "--out", "./adopted"]);
      expect(pulled.status, pulled.stderr).toBe(0);
      expect(readFileSync(join(cwd, "adopted", "schema.ts"), "utf8")).toContain("schema(");
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      await admin.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

function writeSchema(cwd: string, tableDecl: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};
${tableDecl}
export default schema({ tables: [notes] });
`,
  );
}

function cliProc(
  cwd: string,
  argv: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync("bun", [cli, ...argv], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function withoutConfig(text: string): string {
  return text.replace(/^config:.*\n/gm, "");
}

function rewrite(source: string): string {
  let next = source;
  for (const [specifier, path] of imports) {
    next = next.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

async function load<T>(page: string, title: string): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), "okm-guides-load-"));
  const file = join(cwd, title);
  writeFileSync(file, rewrite(body(page, "ts", title)));
  try {
    return (await import(`${pathToFileURL(file).href}?t=${String(Date.now())}`)) as T;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Loads `title` with a sibling fence on disk so relative imports resolve. */
async function loadWithSibling<T>(page: string, title: string, sibling: string): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), "okm-guides-load-"));
  writeFileSync(join(cwd, sibling), rewrite(body(page, "ts", sibling)));
  const file = join(cwd, title);
  writeFileSync(file, rewrite(body(page, "ts", title)));
  try {
    return (await import(`${pathToFileURL(file).href}?t=${String(Date.now())}`)) as T;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function apply(
  example: { readonly app?: { readonly catalog: Catalog } },
  run: (url: string) => Promise<void>,
): Promise<void> {
  if (example.app === undefined) throw new Error("example exports no app");
  const database = await createIsolatedDatabase();
  const admin = openPostgres(database.url);
  try {
    for (const statement of renderCatalog(example.app.catalog, "public")) {
      await admin.unsafe(statement);
    }
    await run(database.url);
  } finally {
    await admin.end({ timeout: 5 });
    await database.close();
  }
}

async function capture(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const write = console.log;
  console.log = ((...args: readonly unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  }) as typeof console.log;
  try {
    await run();
  } finally {
    console.log = write;
  }
  return `${lines.join("\n")}\n`;
}

function fences(text: string): Fence[] {
  const found: Fence[] = [];
  const pattern = /```(\w+) title="([^"]+)"\n([\s\S]*?)```/g;
  for (const match of text.matchAll(pattern)) {
    found.push({ lang: match[1] ?? "", title: match[2] ?? "", body: match[3] ?? "" });
  }
  return found;
}

function titles(text: string): string[] {
  return fences(text).map((fence) => `${fence.lang}:${fence.title}`);
}

function body(text: string, lang: string, title: string): string {
  const fence = fences(text).find((item) => item.lang === lang && item.title === title);
  if (fence === undefined) throw new Error(`missing ${lang} fence ${title}`);
  return fence.body;
}
