/**
 * Handbook output fences on Read rows, How it works, and Tenancy run on a
 * real Postgres. Each `text` or `sql` fence is the output of the fence above
 * it, so a change in the library or the page that moves the output fails here.
 */

import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Catalog } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";

const root = join(import.meta.dir, "..");
const cli = join(root, "src/tooling/cli.ts");
const docs = join(root, "site/content/docs");

const imports: readonly (readonly [string, string])[] = [
  ["okmodel/pg/postgresjs", join(root, "src/runtime/pg/postgresjs.ts")],
  ["okmodel/pg", join(root, "src/dialects/pg/index.ts")],
  ["okmodel/tenancy", join(root, "src/runtime/tenancy/index.ts")],
  ["okmodel/migrate", join(root, "src/tooling/migrate/index.ts")],
];

const gate = await loadPostgresGate();

type Example = { readonly app?: { readonly catalog: Catalog } } & Record<string, unknown>;

const TWO_NOTES = `insert into notes (title) values ('Hello'), ('World')`;

postgresTest(
  gate,
  "Read rows prints the output of each example",
  async () => {
    const page = readFileSync(join(docs, "queries/read-rows.mdx"), "utf8");
    const runs: readonly (readonly [string, string, string, string])[] = [
      ["find.ts", "titles", TWO_NOTES, "find.out"],
      ["one.ts", "byId", TWO_NOTES, "one.out"],
      ["count.ts", "total", TWO_NOTES, "count.out"],
      ["exists.ts", "has", TWO_NOTES, "exists.out"],
      ["page.ts", "pages", TWO_NOTES, "page.out"],
      [
        "order-relation.ts",
        "byProject",
        `insert into projects (name) values ('Beta'), ('Alpha');
         insert into tasks (title, "projectId") values ('Write', 1), ('Plan', 2), ('Loose', null)`,
        "order-relation.out",
      ],
      [
        "distinct.ts",
        "titles",
        `insert into notes (title, amount) values ('Hello', 5), ('Hello', 9), ('World', 3), ('World', null)`,
        "distinct.out",
      ],
      ["stream.ts", "titles", TWO_NOTES, "stream.out"],
      ["explain-notes.ts", "plan", TWO_NOTES, "explain.out"],
    ];
    for (const [file, name, seed, out] of runs) {
      const example = await load(page, file);
      await apply(example, seed, async (url) => {
        const value = await call(example, name, url);
        expect(withoutCosts(`${Bun.inspect(value)}\n`), file).toBe(
          withoutCosts(body(page, "text", out)),
        );
      });
    }

    const explained = await load(page, "explain-notes.ts");
    await apply(explained, TWO_NOTES, async (url) => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        const value = await call(explained, "plan", url);
        expect(`${Bun.inspect(value)}\n`).toBe(body(page, "text", "explain-production.out"));
      } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
      }
    });
  },
  120_000,
);

postgresTest(
  gate,
  "Tenancy prints the scoped SQL and the tables it creates",
  async () => {
    const page = readFileSync(join(docs, "schema/tenancy.mdx"), "utf8");
    const example = await load(page, "tenancy-model.ts");
    if (example.app === undefined) throw new Error("tenancy-model.ts exports no app");
    expect(ddl(example.app.catalog)).toBe(body(page, "sql", "tenancy-model.sql"));
    await apply(example, "", async (url) => {
      expect(await capture(() => call(example, "isolate", url))).toBe(
        body(page, "text", "tenancy-model.out"),
      );
    });
  },
  60_000,
);

postgresTest(
  gate,
  "How it works prints the types, the migration, and the drift",
  async () => {
    const page = readFileSync(join(docs, "concepts/how-okmodel-works.mdx"), "utf8");
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-how-"));
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;
    try {
      writeFileSync(join(cwd, "schema.ts"), rewrite(body(page, "ts", "schema.ts")));
      writeFileSync(join(cwd, "okmodel.config.ts"), rewrite(body(page, "ts", "okmodel.config.ts")));

      const generated = cliProc(cwd, ["generate", "init"]);
      expect(generated.status, generated.stderr).toBe(0);
      expect(readFileSync(join(cwd, "migrations", "0001_init.sql"), "utf8")).toBe(
        body(page, "sql", "0001_init.sql"),
      );
      expect(readFileSync(join(cwd, ".okm", "types.d.ts"), "utf8")).toStartWith(
        body(page, "ts", ".okm/types.d.ts"),
      );

      const applied = cliProc(cwd, ["migrate", "apply"]);
      expect(applied.status, applied.stderr).toBe(0);
      expect(applied.stdout).toBe(body(page, "text", "apply.out"));

      const checked = cliProc(cwd, ["check"]);
      expect(checked.status, checked.stderr).toBe(0);
      expect(checked.stdout).toBe(body(page, "text", "check.out"));

      const sql = openPostgres(database.url);
      try {
        await sql.unsafe(`insert into notes (title) values ('Hello')`);
        writeFileSync(join(cwd, "find.ts"), rewrite(body(page, "ts", "find.ts")));
        const found = (await import(pathToFileURL(join(cwd, "find.ts")).href)) as Example;
        expect(`${Bun.inspect(await call(found, "sample", database.url))}\n`).toBe(
          body(page, "text", "find.out"),
        );
        await sql.unsafe(`alter table notes add column body text`);
      } finally {
        await sql.end({ timeout: 5 });
      }

      const drifted = cliProc(cwd, ["check"]);
      expect(drifted.status).toBe(1);
      expect(withoutConfig(drifted.stderr)).toBe(body(page, "text", "check-drift.err"));
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

/** The DDL a schema renders, as a page shows it. */
function ddl(catalog: Catalog): string {
  return `${renderCatalog(catalog, "public").join(";\n\n")};\n`;
}

function withoutCosts(text: string): string {
  return text.replace(/\(cost=[^)]*\)/g, "(cost=…)");
}

function withoutConfig(text: string): string {
  return text.replace(/^config:.*\n/gm, "");
}

async function call(example: Example, name: string, url: string): Promise<unknown> {
  const fn = example[name];
  if (typeof fn !== "function") throw new Error(`example exports no ${name}`);
  return (fn as (url: string) => Promise<unknown>)(url);
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

function rewrite(source: string): string {
  let next = source;
  for (const [specifier, path] of imports) {
    next = next.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

async function load(page: string, title: string): Promise<Example> {
  const cwd = mkdtempSync(join(tmpdir(), "okm-handbook-load-"));
  const file = join(cwd, title);
  writeFileSync(file, rewrite(body(page, "ts", title)));
  try {
    return (await import(`${pathToFileURL(file).href}?t=${String(Date.now())}`)) as Example;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function apply(
  example: Example,
  seed: string,
  run: (url: string) => Promise<void>,
): Promise<void> {
  if (example.app === undefined) throw new Error("example exports no app");
  const database = await createIsolatedDatabase();
  const admin = openPostgres(database.url);
  try {
    for (const statement of renderCatalog(example.app.catalog, "public")) {
      await admin.unsafe(statement);
    }
    if (seed.length > 0) await admin.unsafe(seed);
    await run(database.url);
  } finally {
    await admin.end({ timeout: 5 });
    await database.close();
  }
}

async function capture(run: () => Promise<unknown>): Promise<string> {
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

function body(text: string, lang: string, title: string): string {
  const pattern = /```(\w+) title="([^"]+)"\n([\s\S]*?)```/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1] === lang && match[2] === title) return match[3] ?? "";
  }
  throw new Error(`missing ${lang} fence ${title}`);
}
