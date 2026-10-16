/**
 * The OKM1538 expand/contract recipe on Postgres (D285).
 *
 * Five migrations, matching docs/type-change.md: add `amount`, backfill it,
 * dual-write, switch reads to `NOT NULL`, then drop `cents`. An in-place
 * `SET DATA TYPE` is not used.
 */

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { quoteIdent } from "../src/dialects/pg/ddl.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import type { PlanStep } from "../src/tooling/migrate/plan.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";

const gate = await loadPostgresGate();
const url = primaryUrl();
const HASH = "type-change-recipe";

postgresTest(
  gate,
  "a rewriting type change expands and contracts across five migrations",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const table = `${quoteIdent(schemaName)}.${quoteIdent("prices")}`;
      await applyTo(schemaName, [
        migration("0001_prices", [
          step(`create table ${table} ("id" integer primary key, "cents" integer not null)`),
        ]),
      ]);
      await sql.unsafe(
        `insert into ${table} ("id", "cents") values (1, 100), (2, 250), (3, 0), (4, 199), (5, 1000)`,
      );

      await applyTo(schemaName, [
        migration("0002_add_amount", [
          step(`alter table ${table} add column "amount" numeric(12, 2)`),
        ]),
      ]);

      await applyTo(schemaName, [
        migration("0003_backfill_amount", [
          {
            sql: `update ${table} set "amount" = "cents"::numeric / 100 where "amount" is null and ($1::text is null or "id" > $1::integer) and ($2::text is null or "id" <= $2::integer)`,
            class: "expand",
            action: "backfill",
            lock: "ROW EXCLUSIVE",
            transactional: false,
            backfill: { table, key: [quoteIdent("id")], batch: 2 },
          },
        ]),
      ]);

      const filled = await sql<{ id: string; amount: string }[]>`
        select "id"::text as id, "amount"::text as amount from prices order by "id"
      `;
      expect(filled.map((row) => [row.id, row.amount])).toEqual([
        ["1", "1.00"],
        ["2", "2.50"],
        ["3", "0.00"],
        ["4", "1.99"],
        ["5", "10.00"],
      ]);
      const batches = await sql<{ n: string }[]>`
        select batches::text as n from okm_backfill where migration_id = '0003_backfill_amount'
      `;
      expect(Number(batches[0]?.n)).toBeGreaterThan(1);

      await applyTo(schemaName, [
        migration("0004_dual_write", [
          step(`create function ${quoteIdent(schemaName)}.${quoteIdent("prices_amount_sync")}() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.amount is null and new.cents is not null then
      new.amount := new.cents::numeric / 100;
    elsif new.cents is null and new.amount is not null then
      new.cents := (new.amount * 100)::integer;
    end if;
    return new;
  end if;
  if new.cents is distinct from old.cents and new.amount is not distinct from old.amount then
    new.amount := new.cents::numeric / 100;
  elsif new.amount is distinct from old.amount and new.cents is not distinct from old.cents then
    new.cents := (new.amount * 100)::integer;
  end if;
  return new;
end;
$$`),
          step(
            `create trigger ${quoteIdent("prices_amount_sync")} before insert or update on ${table} for each row execute function ${quoteIdent(schemaName)}.${quoteIdent("prices_amount_sync")}()`,
          ),
        ]),
      ]);

      await sql.unsafe(`insert into ${table} ("id", "cents") values (6, 50)`);
      const fromOld = await sql<{ amount: string; cents: string }[]>`
        select "amount"::text as amount, "cents"::text as cents from prices where "id" = 6
      `;
      expect(fromOld[0]).toEqual({ amount: "0.50", cents: "50" });
      await sql.unsafe(`update ${table} set "amount" = 1.25 where "id" = 6`);
      const fromNew = await sql<{ amount: string; cents: string }[]>`
        select "amount"::text as amount, "cents"::text as cents from prices where "id" = 6
      `;
      expect(fromNew[0]).toEqual({ amount: "1.25", cents: "125" });

      await applyTo(schemaName, [
        migration("0005_switch_reads", [
          step(
            `alter table ${table} add constraint ${quoteIdent("prices_amount_not_null")} check ("amount" is not null) not valid`,
          ),
          step(`alter table ${table} validate constraint ${quoteIdent("prices_amount_not_null")}`),
          step(`alter table ${table} alter column "amount" set not null`),
          step(`alter table ${table} drop constraint ${quoteIdent("prices_amount_not_null")}`),
        ]),
      ]);
      const nullable = await sql<{ n: string }[]>`
        select is_nullable as n
        from information_schema.columns
        where table_schema = ${schemaName} and table_name = 'prices' and column_name = 'amount'
      `;
      expect(nullable[0]?.n).toBe("NO");

      await applyTo(schemaName, [
        migration("0006_drop_cents", [
          step(`drop trigger ${quoteIdent("prices_amount_sync")} on ${table}`, "contract"),
          step(
            `drop function ${quoteIdent(schemaName)}.${quoteIdent("prices_amount_sync")}()`,
            "contract",
          ),
          step(`alter table ${table} drop column "cents"`, "contract"),
        ]),
      ]);
      const columns = await sql<{ name: string }[]>`
        select column_name as name
        from information_schema.columns
        where table_schema = ${schemaName} and table_name = 'prices'
        order by column_name
      `;
      expect(columns.map((row) => row.name)).toEqual(["amount", "id"]);
      const kept = await sql<{ amount: string }[]>`
        select "amount"::text as amount from prices where "id" = 6
      `;
      expect(kept[0]?.amount).toBe("1.25");
    });
  },
  60_000,
);

function applyTo(schemaName: string, migrations: readonly StoredMigration[]) {
  return applyTarget({
    url,
    target: schemaName,
    protected: false,
    searchPath: schemaName,
    schema: schemaName,
    migrations,
  });
}

function migration(id: string, steps: readonly PlanStep[]): StoredMigration {
  return { id, catalogHash: HASH, steps };
}

function step(sql: string, stepClass: PlanStep["class"] = "expand"): PlanStep {
  return {
    sql,
    class: stepClass,
    action: "ddl",
    lock: "ACCESS EXCLUSIVE",
    transactional: true,
  };
}
