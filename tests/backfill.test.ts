/**
 * Backfill step header and the planner's per-batch `UPDATE` (D195).
 *
 * The statement stays idempotent. `$1` and `$2` are the key range. A table
 * with no primary key is OKM1546. Estimates add a batch count and are not
 * written into the file.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { boundaryQuery } from "../src/tooling/migrate/backfill.js";
import { annotateLock } from "../src/tooling/migrate/estimate.js";
import { formatPlan, parsePlan, planMigration } from "../src/tooling/migrate/plan.js";
import { parseReplace } from "../src/tooling/migrate/values.js";

const RANGE =
  '($1::text is null or "id" > $1::bigint) and ($2::text is null or "id" <= $2::bigint)';

test("a picklist removal is an idempotent backfill with a key range", () => {
  const before = schema({
    tables: [table("tasks", { id: t.identity(), status: t.text().picklist(["a", "b"]) })],
  });
  const after = schema({
    tables: [table("tasks", { id: t.identity(), status: t.text().picklist(["b"]) })],
  });
  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    replacements: [parseReplace("tasks.status.a=b")],
    name: "drop-a",
    batchSize: 250,
  });
  const expand = plan.steps.find((step) => step.kind === "backfill-expand");
  expect(expand?.sql).toBe(
    `update "public"."tasks" set "status" = 'b' where "status" = 'a' and ${RANGE}`,
  );
  expect(expand?.transactional).toBe(false);
  expect(expand?.backfill).toEqual({
    table: '"public"."tasks"',
    key: ['"id"'],
    batch: 250,
  });
  const text = formatPlan(plan);
  expect(text).toContain('-- backfill table="public"."tasks" key="id" batch=250');
  expect(text).not.toContain("about");
  const parsed = parsePlan(text);
  const again = parsed.steps.find((step) => step.kind === "backfill-expand");
  expect(again?.sql).toBe(expand?.sql);
  expect(again?.backfill).toEqual(expand?.backfill);
  expect(again?.transactional).toBe(false);
});

test("a plan with estimates prints rows and batches, and the file does not", () => {
  const before = schema({
    tables: [table("tasks", { id: t.identity(), status: t.text().picklist(["a", "b"]) })],
  });
  const after = schema({
    tables: [table("tasks", { id: t.identity(), status: t.text().picklist(["b"]) })],
  });
  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    replacements: [parseReplace("tasks.status.a=b")],
    name: "drop-a",
  });
  const step = plan.steps.find((item) => item.action === "backfill");
  if (step === undefined) throw new Error("missing backfill");
  expect(annotateLock(step, new Map([["tasks", { kind: "rows", reltuples: 25_000 }]]))).toBe(
    "ROW EXCLUSIVE on tasks, about 25K rows, about 25 batches",
  );
  expect(annotateLock(step, new Map([["tasks", { kind: "unknown" }]]))).toBe(
    "ROW EXCLUSIVE on tasks, rows unknown (table not analyzed)",
  );
  const printed = formatPlan(plan, (item) =>
    annotateLock(item, new Map([["tasks", { kind: "rows", reltuples: 25_000 }]])),
  );
  expect(printed).toContain("-- lock: ROW EXCLUSIVE on tasks, about 25K rows, about 25 batches");
  expect(printed).toContain('-- backfill table="public"."tasks" key="id" batch=1000');
  expect(formatPlan(plan)).not.toContain("about");
});

test("a boundary query reads one key and does not count the table", () => {
  expect(boundaryQuery('"public"."tasks"', [{ quoted: '"id"', dataType: "bigint" }])).toBe(
    'select "id"::text as okm_key from "public"."tasks" where ($1::text is null or "id" > $1::bigint) order by "id" offset $2::bigint limit 1',
  );
  const composite = boundaryQuery('"public"."tasks"', [
    { quoted: '"org"', dataType: "text" },
    { quoted: '"id"', dataType: "integer" },
  ]);
  expect(composite).toContain('jsonb_build_array("org"::text, "id"::text)::text');
  expect(composite).toContain(
    '("org", "id") > ((($1::jsonb)->>0)::text, (($1::jsonb)->>1)::integer)',
  );
  expect(composite).not.toContain("count(");
});

test("a composite primary key is a row comparison", () => {
  const before = schema({
    tables: [
      table(
        "tasks",
        { org: t.text(), id: t.integer(), status: t.text().picklist(["a", "b"]) },
        { primaryKey: ["org", "id"] },
      ),
    ],
  });
  const after = schema({
    tables: [
      table(
        "tasks",
        { org: t.text(), id: t.integer(), status: t.text().picklist(["b"]) },
        { primaryKey: ["org", "id"] },
      ),
    ],
  });
  const plan = planMigration({
    before: before.catalog,
    after: after.catalog,
    replacements: [parseReplace("tasks.status.a=b")],
    name: "composite",
  });
  const sql = plan.steps.find((step) => step.action === "backfill")?.sql ?? "";
  expect(sql).toContain(`where "status" = 'a' and`);
  expect(sql).toContain(`("org", "id") > ((($1::jsonb)->>0)::text, (($1::jsonb)->>1)::integer)`);
  expect(sql).toContain(`("org", "id") <= ((($2::jsonb)->>0)::text, (($2::jsonb)->>1)::integer)`);
  expect(plan.steps.find((step) => step.action === "backfill")?.backfill?.key).toEqual([
    '"org"',
    '"id"',
  ]);
});

test("a table with no primary key is refused at plan time", () => {
  const before = schema({
    tables: [table("tasks", { id: t.integer(), status: t.text().picklist(["a", "b"]) })],
  });
  const after = schema({
    tables: [table("tasks", { id: t.integer(), status: t.text().picklist(["b"]) })],
  });
  const error = capture(() =>
    planMigration({
      before: before.catalog,
      after: after.catalog,
      replacements: [parseReplace("tasks.status.a=b")],
      name: "none",
    }),
  );
  expect(error.code).toBe("OKM1546");
  expect(error.fix.summary).toContain("primary key");

  const plain = schema({ tables: [table("notes", { id: t.integer(), title: t.text() })] });
  const filled = schema({
    tables: [
      table("notes", {
        id: t.integer(),
        title: t.text(),
        token: t.uuid().defaultSql("gen_random_uuid()"),
      }),
    ],
  });
  const fill = capture(() =>
    planMigration({ before: plain.catalog, after: filled.catalog, name: "fill" }),
  );
  expect(fill.code).toBe("OKM1546");
});

test("a hand-written backfill header parses and a broken one is refused", () => {
  const text = `-- class: expand
-- name: hand

-- class: expand
-- action: backfill
-- lock: ROW EXCLUSIVE
-- backfill table="public"."tasks" key="id" batch=1000
update "public"."tasks" set "status" = 'b' where "status" = 'a' and ($1::text is null or "id" > $1::bigint) and ($2::text is null or "id" <= $2::bigint);

`;
  const plan = parsePlan(text);
  expect(plan.steps[0]?.backfill).toEqual({
    table: '"public"."tasks"',
    key: ['"id"'],
    batch: 1000,
  });
  expect(() =>
    parsePlan(`-- class: expand
-- name: bad

-- action: backfill
-- backfill table=tasks
update "public"."tasks" set "status" = 'b';

`),
  ).toThrow(OkmError);
});

function capture(run: () => void): OkmError {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}
