/**
 * `okmodel/expr` on real Postgres: each helper's result type, whether it can
 * be null, and its volatility are what the TypeScript type says.
 *
 * Volatility is proved by Postgres itself: a generated column takes an
 * immutable expression and refuses a stable one (42P17).
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import {
  add,
  and,
  atTimeZone,
  caseWhen,
  cast,
  coalesce,
  col,
  concat,
  div,
  extract,
  jsonText,
  length,
  lower,
  mod,
  mul,
  nullif,
  now,
  setting,
  settingList,
  sub,
  upper,
  type Expr,
  type Timestamp,
  type Timestamptz,
  type DateText,
} from "../src/dialects/pg/expr/index.js";
import { eq, gt, schema, table, t } from "../src/dialects/pg/index.js";
import { printExpr } from "../src/tooling/migrate/expr-sql.js";
import { checkScratch } from "../src/tooling/migrate/scratch-check.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";

const gate = await loadPostgresGate();

const app = schema({
  tables: [
    table("t", {
      n: t.integer(),
      m: t.integer().nullable(),
      s: t.text(),
      u: t.text().nullable(),
      ts: t.timestamptz(),
      tn: t.timestamp(),
      d: t.date(),
      j: t.jsonb(),
    }),
  ],
});
const on = { schema: app, table: "t" } as const;

const CREATE = `create table t (
  n integer not null, m integer, s text not null, u text,
  ts timestamptz not null, tn timestamp not null, d date not null, j jsonb not null
)`;
const ROW = `insert into t values
  (7, null, 'Abc', null, '2025-06-15 12:00:00+00', '2025-06-15 12:00:00', '2025-06-15', '{"k":"v"}')`;

const n = col<number>("n");
const m = col<number, true>("m");
const s = col<string>("s");
const u = col<string, true>("u");
const ts = col<Timestamptz>("ts");
const tn = col<Timestamp>("tn");
const d = col<DateText>("d");
const j = col<unknown>("j");

type Case = {
  readonly helper: string;
  readonly expr: Expr;
  /** `pg_typeof` of the printed SQL. */
  readonly pg: string;
  /** What the single row returns, with a nullable input null. */
  readonly value: unknown;
  /** The volatility the type claims. */
  readonly volatility: "immutable" | "stable";
};

const CASES: readonly Case[] = [
  { helper: "add", expr: add(n, 1), pg: "integer", value: 8, volatility: "immutable" },
  { helper: "add", expr: add(m, 1), pg: "integer", value: null, volatility: "immutable" },
  { helper: "sub", expr: sub(n, 1), pg: "integer", value: 6, volatility: "immutable" },
  { helper: "mul", expr: mul(n, 2), pg: "integer", value: 14, volatility: "immutable" },
  { helper: "div", expr: div(n, 2), pg: "integer", value: 3, volatility: "immutable" },
  { helper: "mod", expr: mod(n, 4), pg: "integer", value: 3, volatility: "immutable" },
  { helper: "lower", expr: lower(s), pg: "text", value: "abc", volatility: "immutable" },
  { helper: "lower", expr: lower(u), pg: "text", value: null, volatility: "immutable" },
  { helper: "upper", expr: upper(s), pg: "text", value: "ABC", volatility: "immutable" },
  { helper: "length", expr: length(s), pg: "integer", value: 3, volatility: "immutable" },
  { helper: "concat", expr: concat(s, u), pg: "text", value: "Abc", volatility: "immutable" },
  { helper: "concat", expr: concat(u, "-"), pg: "text", value: "-", volatility: "immutable" },
  { helper: "coalesce", expr: coalesce(u, "z"), pg: "text", value: "z", volatility: "immutable" },
  { helper: "coalesce", expr: coalesce(m, 0), pg: "integer", value: 0, volatility: "immutable" },
  { helper: "nullif", expr: nullif(s, "Abc"), pg: "text", value: null, volatility: "immutable" },
  { helper: "nullif", expr: nullif(s, "x"), pg: "text", value: "Abc", volatility: "immutable" },
  {
    helper: "cast",
    expr: cast("12", "integer"),
    pg: "integer",
    value: 12,
    volatility: "immutable",
  },
  { helper: "cast", expr: cast(n, "bigint"), pg: "bigint", value: "7", volatility: "immutable" },
  { helper: "cast", expr: cast(n, "text"), pg: "text", value: "7", volatility: "immutable" },
  {
    helper: "cast",
    expr: cast(ts, "text"),
    pg: "text",
    value: "2025-06-15 12:00:00+00",
    volatility: "stable",
  },
  { helper: "jsonText", expr: jsonText(j, "k"), pg: "text", value: "v", volatility: "immutable" },
  { helper: "jsonText", expr: jsonText(j, "zz"), pg: "text", value: null, volatility: "immutable" },
  {
    helper: "extract",
    expr: extract("year", tn),
    pg: "numeric",
    value: "2025",
    volatility: "immutable",
  },
  {
    helper: "extract",
    expr: extract("year", d),
    pg: "numeric",
    value: "2025",
    volatility: "immutable",
  },
  {
    helper: "extract",
    expr: extract("hour", ts),
    pg: "numeric",
    value: "12",
    volatility: "stable",
  },
  {
    helper: "atTimeZone",
    expr: atTimeZone(ts, "UTC"),
    pg: "timestamp without time zone",
    value: "2025-06-15 12:00:00",
    volatility: "immutable",
  },
  {
    helper: "caseWhen",
    expr: caseWhen([[{ n: gt(5) }, "big"]], "small"),
    pg: "text",
    value: "big",
    volatility: "immutable",
  },
  {
    helper: "and",
    expr: and({ n: gt(1) }, { s: eq("Abc") }),
    pg: "boolean",
    value: true,
    volatility: "immutable",
  },
  {
    helper: "now",
    expr: now(),
    pg: "timestamp with time zone",
    value: "now",
    volatility: "stable",
  },
  {
    helper: "setting",
    expr: setting("app.tenant", "text"),
    pg: "text",
    value: null,
    volatility: "stable",
  },
  {
    helper: "setting",
    expr: setting("app.ids", "text[]"),
    pg: "text[]",
    value: [],
    volatility: "stable",
  },
];

postgresTest(gate, "proof:expr.core", async () => {
  await using(async (sql) => {
    await sql.unsafe(CREATE);
    await sql.unsafe(ROW);
    for (const item of CASES) {
      const text = await printExpr(item.expr, on);
      const rows = await sql.unsafe(
        `select pg_typeof(${text})::text as ty, (${text})::text as v from t`,
      );
      const label = `${item.helper}: ${text}`;
      expect(rows[0]?.ty, label).toBe(item.pg);
      if (item.value === "now") expect(rows[0]?.v, label).not.toBeNull();
      else if (Array.isArray(item.value)) expect(rows[0]?.v, label).toBe("{}");
      else
        expect(rows[0]?.v === null ? null : rows[0]?.v, label).toEqual(
          item.value === null ? null : `${item.value as string | number}`,
        );
    }
  });
});

postgresTest(
  gate,
  "expr.core: an immutable helper is accepted in a generated column and a stable one is refused",
  async () => {
    await using(async (_sql, url) => {
      for (const item of CASES) {
        const text = await printExpr(item.expr, on);
        const verdict = await checkScratch(
          [CREATE, `alter table t add column g ${item.pg} generated always as (${text}) stored`],
          { url },
        );
        const label = `${item.helper}: ${text}`;
        if (item.volatility === "immutable") expect(verdict, label).toEqual({ ok: true });
        else {
          expect(verdict.ok, label).toBe(false);
          // A setting is wrapped in a subselect so it runs once, and a generated column refuses
          // a subquery (0A000) before it asks about volatility. Its function is stable either way.
          expect(verdict.ok ? "" : verdict.sqlstate, label).toBe(
            item.helper === "setting" ? "0A000" : "42P17",
          );
        }
      }
    });
  },
);

postgresTest(
  gate,
  "expr.core: the functions behind now and setting are stable in pg_proc",
  async () => {
    await using(async (sql) => {
      const rows = await sql.unsafe(
        "select proname, provolatile from pg_proc where proname in ('now', 'current_setting') and pronamespace = 'pg_catalog'::regnamespace",
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((row) => row.provolatile === "s")).toBe(true);
    });
  },
);

postgresTest(
  gate,
  "expr.core: a scalar setting is null when unset or empty and reads the value when set",
  async () => {
    await using(async (sql) => {
      const text = await printExpr(setting("app.tenant", "text"));
      expect(text).toBe("(select nullif(current_setting('app.tenant', true), '')::text)");
      expect((await sql.unsafe(`select ${text} as v`))[0]?.v).toBeNull();
      await sql.unsafe("select set_config('app.tenant', '', false)");
      expect((await sql.unsafe(`select ${text} as v`))[0]?.v).toBeNull();
      await sql.unsafe("select set_config('app.tenant', 'acme', false)");
      expect((await sql.unsafe(`select ${text} as v`))[0]?.v).toBe("acme");
      const big = await printExpr(setting("app.n", "bigint"));
      await sql.unsafe("select set_config('app.n', '9007199254740993', false)");
      expect((await sql.unsafe(`select ${big}::text as v`))[0]?.v).toBe("9007199254740993");
    });
  },
);

postgresTest(
  gate,
  "expr.core: a list setting casts outside the subselect and works under = any",
  async () => {
    await using(async (sql) => {
      const text = await printExpr(setting("app.ids", "text[]"));
      expect(text).toBe(
        "((select coalesce(nullif(current_setting('app.ids', true), ''), '{}'))::text[])",
      );
      // Unset reads as an empty list.
      expect((await sql.unsafe(`select 'x' = any(${text}) as hit`))[0]?.hit).toBe(false);
      await sql.unsafe("select set_config('app.ids', $1, false)", [settingList(["x", "y"])]);
      expect((await sql.unsafe(`select 'x' = any(${text}) as hit`))[0]?.hit).toBe(true);
      expect((await sql.unsafe(`select 'z' = any(${text}) as hit`))[0]?.hit).toBe(false);
      // The cast inside the subselect is what fails: the subselect then yields one array, not elements.
      const inside = "(select nullif(current_setting('app.ids', true), '')::text[])";
      const error = await sql
        .unsafe(`select 'x'::text = any(${inside}) as hit`)
        .catch((cause: unknown) => cause);
      expect((error as { code?: string }).code).toBe("42883");
      const typed = await printExpr(setting("app.nums", "integer[]"));
      await sql.unsafe("select set_config('app.nums', $1, false)", [settingList(["1", "2"])]);
      expect((await sql.unsafe(`select 2 = any(${typed}) as hit`))[0]?.hit).toBe(true);
    });
  },
);

const LIST_CASES: readonly (readonly [string, readonly (string | null)[]])[] = [
  ["a comma", ["a,b", "c"]],
  ["a quote", ['say "hi"', "x"]],
  ["a brace", ["{a}", "b}"]],
  ["a backslash", ["a\\b", "c\\"]],
  ["a space", ["a b", " lead", "trail "]],
  ["an empty string", ["", "x"]],
  ["Arabic text", ["مرحبا", "عالم"]],
  ["accented text", ["café", "naïve", "Zoë"]],
  ["NULL", ["a", null, "b"]],
  ["the string NULL", ["NULL", "null"]],
  ["an empty array", []],
  ["a single element", ["only"]],
];

postgresTest(
  gate,
  "expr.core: a list setting round-trips every awkward element, and a plain join does not",
  async () => {
    await using(async (sql) => {
      const read = async (encoded: string): Promise<unknown> => {
        await sql.unsafe("select set_config('app.list', $1, false)", [encoded]);
        return JSON.parse(
          String(
            (
              await sql.unsafe("select to_json((current_setting('app.list'))::text[])::text as v")
            )[0]?.v,
          ),
        );
      };
      let naiveFailures = 0;
      for (const [label, items] of LIST_CASES) {
        expect(await read(settingList(items)), label).toEqual([...items]);
        const naive = `{${items.map((item) => item ?? "NULL").join(",")}}`;
        const got = await read(naive).catch(() => "error");
        if (JSON.stringify(got) !== JSON.stringify(items)) naiveFailures += 1;
      }
      expect(naiveFailures).toBeGreaterThanOrEqual(5);
      expect(settingList([])).toBe("{}");
      expect(settingList(["a", null])).toBe('{"a",NULL}');
    });
  },
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
