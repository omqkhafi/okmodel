/**
 * `printWhere` writes a where object as SQL with no parameters, and Postgres
 * returns the rows the same object selects through a query.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { OkmError } from "../src/contracts/error.js";
import { col, add } from "../src/dialects/pg/expr/index.js";
import {
  between,
  contains,
  eq,
  gt,
  inList,
  lt,
  not,
  notIn,
  or,
  schema,
  startsWith,
  table,
  t,
} from "../src/dialects/pg/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { catalog } from "../src/contracts/catalog/build.js";
import { printWhere } from "../src/tooling/migrate/expr-sql.js";
import { checkScratch } from "../src/tooling/migrate/scratch-check.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";

const gate = await loadPostgresGate();

const items = table("items", {
  id: t.integer().primaryKey(),
  name: t.text(),
  qty: t.integer(),
  limitQty: t.integer().sqlName("limit_qty"),
  big: t.bigint(),
  seen: t.timestamptz(),
  active: t.boolean(),
  tag: t.text().nullable(),
  meta: t.jsonb(),
});
const app = schema({ tables: [items] });
const on = { schema: app, table: "items" } as const;

const ROWS = `
  insert into items (id, name, qty, limit_qty, big, seen, active, tag, meta) values
    (1, 'one', 1, 3, 1, '2024-06-01T00:00:00Z', true, null, '{"a":1}'),
    (2, 'o''neil', 5, 4, 2, '2025-03-01T00:00:00Z', false, 'x', '{"a":2}'),
    (3, 'a\\b', 9, 9, 3, '2025-09-01T00:00:00Z', true, 'y', '{"b":1}'),
    (4, 'four', 4, 2, 9007199254740993, '2023-01-01T00:00:00Z', false, null, '{"a":1,"b":2}')
`;

const CASES: readonly (readonly [string, unknown, readonly number[]])[] = [
  ["a boolean", { active: true }, [1, 3]],
  ["a comparison", { qty: gt(4) }, [2, 3]],
  ["between", { qty: between(4, 5) }, [2, 4]],
  ["a quote in text", { name: eq("o'neil") }, [2]],
  ["a backslash in text", { name: eq("a\\b") }, [3]],
  ["a prefix with a quote", { name: startsWith("o'") }, [2]],
  ["a bigint past the safe integer", { big: eq(9007199254740993n) }, [4]],
  ["a date", { seen: lt("2025-01-01T00:00:00Z") }, [1, 4]],
  ["null", { tag: null }, [1, 4]],
  ["a list", { id: inList([1, 2, 7]) }, [1, 2]],
  ["not in a list", { id: notIn([1, 2]) }, [3, 4]],
  ["or", or([{ qty: lt(2) }, { active: false, qty: gt(4) }]), [1, 2]],
  ["not", { qty: not(gt(4)) }, [1, 4]],
  ["jsonb containment", { meta: contains({ a: 1 }) }, [1, 4]],
  ["column against column", { qty: lt(col<number>("limit_qty")) }, [1]],
  ["column against an expression", { qty: gt(add(col<number>("limit_qty"), 1)) }, [4]],
];

postgresTest(gate, "proof:expr.where", async () => {
  await using(async (sql) => {
    await create(sql);
    await sql.unsafe(ROWS);
    for (const [label, where, ids] of CASES) {
      const text = await printWhere(on, where);
      expect(text, label).not.toMatch(/\$\d/);
      const rows = await sql.unsafe(`select id from items where ${text} order by id`);
      expect(
        rows.map((row) => Number(row.id)),
        label,
      ).toEqual([...ids]);
    }
  });
});

postgresTest(
  gate,
  "a printed where object is accepted in a partial index and a check",
  async () => {
    await using(async (sql) => {
      await create(sql);
      const text = await printWhere(on, { seen: lt("2025-01-01T00:00:00Z"), active: true });
      await sql.unsafe(`create index items_old on items (id) where ${text}`);
      await sql.unsafe(
        `alter table items add constraint items_qty check (${await printWhere(on, { qty: gt(0) })})`,
      );
      expect(
        (await sql.unsafe("select count(*)::int as n from pg_index where indpred is not null"))[0]
          ?.n,
      ).toBe(1);
    });
  },
);

postgresTest(
  gate,
  "printed literals do not change what the scratch checker says about immutability",
  async () => {
    const text = await printWhere(on, { seen: lt("2025-01-01T00:00:00Z") });
    const verdict = await checkScratch([
      "create table items (id integer, seen timestamptz)",
      `create index items_old on items (id) where ${text}`,
    ]);
    expect(verdict).toEqual({ ok: true });
  },
);

postgresTest(
  gate,
  "a value Postgres cannot hold, or a relation, is refused before any SQL",
  async () => {
    const bad = await printWhere(on, { name: eq("a\0b") }).catch((error: unknown) => error);
    expect(bad).toBeInstanceOf(OkmError);
    expect((bad as OkmError).code).toBe("OKM1120");
    const nan = await printWhere(on, { qty: eq(Number.NaN) }).catch((error: unknown) => error);
    expect(nan).toBeInstanceOf(OkmError);
    const unknown = await printWhere(on, { nope: eq(1) }).catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(OkmError);
  },
);

async function create(sql: Sql): Promise<void> {
  const plan = planMigration({ before: catalog([]), after: app.catalog, name: "items" });
  for (const step of plan.steps) await sql.unsafe(step.sql);
}

async function using(body: (sql: Sql) => Promise<void>): Promise<void> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await body(sql);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
}
