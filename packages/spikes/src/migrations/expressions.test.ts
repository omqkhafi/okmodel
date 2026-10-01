/**
 * Which expressions Postgres rewrites, and where the scratch database is the judge.
 */

import { expect } from "bun:test";

import { isolatedSchemaName, withPostgres } from "@okmodel/harness";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { quoteLiteral } from "../catalog/sql.js";
import { rewrittenDriftHash, scrubSchema } from "./equal.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

type ExpressionCase = {
  readonly name: string;
  readonly left: readonly string[];
  readonly right: readonly string[];
  readonly drift: readonly string[];
  readonly read: string;
};

const CASES: readonly ExpressionCase[] = [
  {
    name: "default",
    left: [`create table t (id int8 not null default 0)`],
    right: [`create table t (id int8 not null default (0))`],
    drift: [`create table t (id int8 not null default 1)`],
    read: `select pg_get_expr(ad.adbin, ad.adrelid) as expr
      from pg_attrdef ad
      join pg_class c on c.oid = ad.adrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $schema and c.relname = 't'`,
  },
  {
    name: "check",
    left: [`create table t (id int8 not null, constraint t_check check (id > 0))`],
    right: [`create table t (id int8 not null, constraint t_check check ((id > 0)))`],
    drift: [`create table t (id int8 not null, constraint t_check check (id > 1))`],
    read: `select pg_get_constraintdef(con.oid) as expr
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $schema and con.conname = 't_check'`,
  },
  {
    name: "index",
    left: [`create table t (title text not null)`, `create index t_title on t ((lower(title)))`],
    right: [`create table t (title text not null)`, `create index t_title on t ((lower((title))))`],
    drift: [
      `create table t (title text not null)`,
      `create index t_title on t ((lower(title || 'x')))`,
    ],
    read: `select pg_get_expr(i.indexprs, i.indrelid) as expr
      from pg_index i
      join pg_class idx on idx.oid = i.indexrelid
      join pg_namespace n on n.oid = idx.relnamespace
      where n.nspname = $schema and idx.relname = 't_title'`,
  },
  {
    name: "generated",
    left: [`create table t (rank int8 not null, score int8 generated always as (rank + 1) stored)`],
    right: [
      `create table t (rank int8 not null, score int8 generated always as ((rank + 1)) stored)`,
    ],
    drift: [
      `create table t (rank int8 not null, score int8 generated always as (rank + 2) stored)`,
    ],
    read: `select pg_get_expr(ad.adbin, ad.adrelid) as expr
      from pg_attrdef ad
      join pg_attribute a on a.attrelid = ad.adrelid and a.attnum = ad.adnum
      join pg_class c on c.oid = ad.adrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $schema and c.relname = 't' and a.attname = 'score'`,
  },
  {
    name: "view",
    left: [
      `create table t (id int8 not null)`,
      `create view v as select "id" from t where "id" > 0`,
    ],
    right: [`create table t (id int8 not null)`, `create view v as select id from t where id > 0`],
    drift: [
      `create table t (id int8 not null)`,
      `create view v as select "id" from t where "id" > 1`,
    ],
    read: `select pg_get_viewdef(c.oid, true) as expr
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $schema and c.relname = 'v'`,
  },
  {
    name: "function-sql",
    left: [
      `create table t (id int8 not null)`,
      `create function n() returns int8 language sql stable begin atomic select count(*)::int8 from t; end`,
    ],
    right: [
      `create table t (id int8 not null)`,
      `create function n() returns int8 language sql stable begin atomic select count(*) :: int8 from t; end`,
    ],
    drift: [
      `create table t (id int8 not null)`,
      `create function n() returns int8 language sql stable begin atomic select count(id)::int8 from t; end`,
    ],
    read: `select pg_get_functiondef(p.oid) as expr
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $schema and p.proname = 'n'`,
  },
  {
    name: "function-plpgsql",
    left: [
      `create function n() returns int8 language plpgsql stable as $okm$ begin return 1; end $okm$`,
    ],
    right: [
      `create function n() returns int8 language plpgsql stable as $okm$
begin
  return 1;
end
$okm$`,
    ],
    drift: [
      `create function n() returns int8 language plpgsql stable as $okm$ begin return 2; end $okm$`,
    ],
    read: `select pg_get_functiondef(p.oid) as expr
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $schema and p.proname = 'n'`,
  },
  {
    name: "domain",
    left: [`create domain d as int8 constraint d_check check (value > 0)`],
    right: [`create domain d as int8 constraint d_check check ((value > 0))`],
    drift: [`create domain d as int8 constraint d_check check (value > 1)`],
    read: `select pg_get_constraintdef(c.oid) as expr
      from pg_constraint c
      join pg_type t on t.oid = c.contypid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = $schema and t.typname = 'd'`,
  },
];

postgresTest(
  decision,
  "rewritten expressions match only after a scratch round trip",
  async () => {
    const report: {
      name: string;
      authoringDiffers: boolean;
      scratchEqual: boolean;
      driftDiffers: boolean;
      left: string;
      right: string;
    }[] = [];
    await withPostgres(async (sql) => {
      for (const item of CASES) {
        const leftSchema = isolatedSchemaName();
        const rightSchema = isolatedSchemaName();
        const driftSchema = isolatedSchemaName();
        try {
          const left = await applyRead(sql, leftSchema, item.left, item.read);
          const right = await applyRead(sql, rightSchema, item.right, item.read);
          const drift = await applyRead(sql, driftSchema, item.drift, item.read);
          const authoringDiffers = item.left.join("\n") !== item.right.join("\n");
          report.push({
            name: item.name,
            authoringDiffers,
            scratchEqual: collapse(left) === collapse(right),
            driftDiffers: collapse(left) !== collapse(drift),
            left: collapse(left),
            right: collapse(right),
          });
        } finally {
          await sql.unsafe(`drop schema if exists ${leftSchema} cascade`);
          await sql.unsafe(`drop schema if exists ${rightSchema} cascade`);
          await sql.unsafe(`drop schema if exists ${driftSchema} cascade`);
        }
      }
    });
    console.log(JSON.stringify({ event: "migration-expressions", report }));
    for (const item of report) {
      expect(item.driftDiffers).toBe(true);
    }
    const equalByScratch = report.filter((item) => item.scratchEqual).map((item) => item.name);
    expect(equalByScratch).toContain("default");
    expect(equalByScratch).toContain("check");
    expect(equalByScratch).toContain("generated");
    expect(equalByScratch).toContain("domain");
    const hashed = rewrittenDriftHash([
      { key: "check", expr: report.find((item) => item.name === "check")?.left ?? "" },
    ]);
    const hashedAgain = rewrittenDriftHash([
      { key: "check", expr: report.find((item) => item.name === "check")?.right ?? "" },
    ]);
    expect(hashed).toBe(hashedAgain);
    const drifted = rewrittenDriftHash([{ key: "check", expr: "id > 1" }]);
    expect(drifted).not.toBe(hashed);
  },
  60_000,
);

async function applyRead(
  sql: { unsafe: (statement: string) => Promise<unknown> },
  schema: string,
  statements: readonly string[],
  read: string,
): Promise<string> {
  await sql.unsafe(`create schema ${schema}`);
  await sql.unsafe(`set search_path to ${schema}`);
  for (const statement of statements) await sql.unsafe(statement);
  const query = read.replaceAll("$schema", quoteLiteral(schema));
  const rows = (await sql.unsafe(query)) as readonly Record<string, unknown>[];
  const value = rows[0]?.expr;
  return scrubSchema(typeof value === "string" ? value : "", schema);
}

function collapse(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
