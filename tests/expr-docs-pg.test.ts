/**
 * The Expressions page and the Large tables section match a real Postgres.
 *
 * Every helper row is evaluated, printed, typed by `pg_typeof`, and checked
 * for volatility by a generated column. The SQL example is applied to a table
 * of 150,000 rows.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as helpers from "../src/dialects/pg/expr/index.js";
import { eq, gt, schema, table, t } from "../src/dialects/pg/index.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { printExpr } from "../src/tooling/migrate/expr-sql.js";
import { parsePlan } from "../src/tooling/migrate/plan.js";
import { checkScratch } from "../src/tooling/migrate/scratch-check.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  openPostgres,
  withPostgresSchema,
} from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const gate = await loadPostgresGate();
const docs = join(import.meta.dir, "..", "site/content/docs");
const page = readFileSync(join(docs, "reference/expr.mdx"), "utf8");
const locks = readFileSync(join(docs, "migrations/waiting-for-locks.mdx"), "utf8");

const app = schema({
  tables: [
    table("orders", {
      qty: t.integer(),
      note: t.text().nullable(),
      title: t.text(),
      paid_at: t.timestamptz(),
      meta: t.jsonb(),
    }),
  ],
});
const on = { schema: app, table: "orders" } as const;
const CREATE = `create table orders (
  qty integer not null, note text, title text not null, paid_at timestamptz not null, meta jsonb not null
)`;

function rows(): readonly (readonly string[])[] {
  const found: string[][] = [];
  for (const line of page.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replaceAll("\\|", "|"));
    if (cells.length === 4) found.push(cells);
  }
  return found;
}

/** The expressions of the helper table, keyed by the exact source the page prints. */
const BUILT: Readonly<Record<string, helpers.Expr>> = {
  'add(col("qty"), 1)': helpers.add(helpers.col<number>("qty"), 1),
  'sub(col("qty"), 1)': helpers.sub(helpers.col<number>("qty"), 1),
  'mul(col("qty"), 2)': helpers.mul(helpers.col<number>("qty"), 2),
  'div(col("qty"), 2)': helpers.div(helpers.col<number>("qty"), 2),
  'mod(col("qty"), 4)': helpers.mod(helpers.col<number>("qty"), 4),
  'and({ qty: gt(1) }, { title: eq("a") })': helpers.and({ qty: gt(1) }, { title: eq("a") }),
  'lower(col("title"))': helpers.lower(helpers.col<string>("title")),
  'upper(col("title"))': helpers.upper(helpers.col<string>("title")),
  'length(col("title"))': helpers.length(helpers.col<string>("title")),
  'concat(col("title"), col("note"))': helpers.concat(
    helpers.col<string>("title"),
    helpers.col<string, true>("note"),
  ),
  'coalesce(col("note"), "none")': helpers.coalesce(helpers.col("note"), "none"),
  'nullif(col("title"), "")': helpers.nullif(helpers.col<string>("title"), ""),
  'cast(col("qty"), "text")': helpers.cast(helpers.col("qty"), "text"),
  'cast(col("paid_at"), "text")': helpers.cast(helpers.col("paid_at"), "text"),
  'jsonText(col("meta"), "sku")': helpers.jsonText(helpers.col("meta"), "sku"),
  'extract("year", col("paid_at"))': helpers.extract(
    "year",
    helpers.col<helpers.Timestamptz>("paid_at"),
  ),
  'atTimeZone(col("paid_at"), "UTC")': helpers.atTimeZone(
    helpers.col<helpers.Timestamptz>("paid_at"),
    "UTC",
  ),
  'caseWhen([[{ qty: gt(9) }, "bulk"]], "single")': helpers.caseWhen(
    [[{ qty: gt(9) }, "bulk"]],
    "single",
  ),
  "now()": helpers.now(),
  'setting("app.tenant", "text")': helpers.setting("app.tenant", "text"),
  'setting("app.ids", "uuid[]")': helpers.setting("app.ids", "uuid[]"),
};

function evaluate(source: string): helpers.Expr {
  const found = BUILT[source];
  if (found === undefined)
    throw new Error(`the page shows ${source}, which this test does not build`);
  return found;
}

function fence(text: string, language: string): string {
  const found = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``).exec(text);
  if (found?.[1] === undefined) throw new Error(`no ${language} block`);
  return found[1];
}

postgresTest(
  gate,
  "the helper table on the Expressions page is what a real Postgres says",
  async () => {
    const database = await createIsolatedDatabase();
    const scratch = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe(CREATE);
      await sql.unsafe(
        `insert into orders values (3, null, 'Widget', '2025-06-15 12:00:00+00', '{"sku":"w1"}')`,
      );
      const table = rows();
      expect(table.map((row) => row[0]?.replace(/^`|`$/g, ""))).toEqual(Object.keys(BUILT));
      for (const [source = "", printed = "", pg = "", volatility = ""] of table) {
        const code = source.replace(/^`|`$/g, "");
        const sqlText = await printExpr(evaluate(code), on);
        expect(`\`${sqlText}\``, code).toBe(printed);
        const typed = await sql.unsafe(`select pg_typeof(${sqlText})::text as ty from orders`);
        expect(String(typed[0]?.ty), code).toBe(pg);
        const verdict = await checkScratch(
          [CREATE, `alter table orders add column g ${pg} generated always as (${sqlText}) stored`],
          { url: scratch.url },
        );
        expect(verdict.ok, code).toBe(volatility === "immutable");
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(gate, "the refusal text on the Expressions page is what Postgres says", async () => {
  const verdict = await checkScratch([
    "create table notes (title text)",
    "create index notes_now on notes ((now()))",
  ]);
  if (verdict.ok) throw new Error("expected a refusal");
  expect(verdict.error.message).toBe(fence(page, "text").trim());
});

postgresTest(
  gate,
  "the settingList example on the Expressions page is what it returns",
  async () => {
    const block = fence(page, "ts");
    expect(block).toContain("okmodel/expr");
    const source = /settingList\((\[.*\])\);\n\/\/ (.*)/.exec(page);
    expect(source?.[1]).toBeDefined();
    const values = JSON.parse(source?.[1] ?? "[]") as (string | null)[];
    expect(helpers.settingList(values)).toBe(source?.[2] ?? "missing");
  },
);

postgresTest(
  gate,
  "the Large tables SQL example stops over 100,000 rows and runs with --allow-blocking",
  async () => {
    const block = /```sql\n([\s\S]*?)```/.exec(locks.slice(locks.indexOf("## Large tables")))?.[1];
    if (block === undefined) throw new Error("no sql block in Large tables");
    const plan = parsePlan(`${block}`);
    expect(plan.steps[0]?.weight).toBe("blocking");
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table "${schemaName}".tasks (id integer not null)`);
      await sql.unsafe(
        `insert into "${schemaName}".tasks select g from generate_series(1, 150000) g`,
      );
      const steps = plan.steps.map((step) => ({
        ...step,
        sql: step.sql.replace('"public"."tasks"', `"${schemaName}"."tasks"`),
      }));
      const migrations = [{ id: "0001_exclusive", catalogHash: "hash", steps }];
      const request = {
        url: primaryUrl(),
        target: schemaName,
        protected: false,
        searchPath: schemaName,
        migrations,
      };
      const refused = await applyTarget(request).catch((error: unknown) => error);
      expect((refused as Error).message).toContain("Nothing was changed.");
      expect((refused as { code?: string }).code).toBe("OKM1847");
      const done = await applyTarget({ ...request, allowBlocking: true });
      expect(done.applied).toEqual(["0001_exclusive"]);
    });
  },
  60_000,
);
