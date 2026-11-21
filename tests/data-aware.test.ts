/**
 * Probe SQL shape. The count is a bounded subquery, never `count(*)` of the table.
 */

import { expect, test } from "bun:test";

import { probeSql } from "../src/tooling/migrate/data-probe.js";

test("the probe counts a limited subquery and not the table", () => {
  const sql = probeSql("public", { table: "tasks", column: "title", which: "null" });
  expect(sql).toContain('select count(*)::text as c from (select 1 from "public"."tasks"');
  expect(sql).toContain('"title" is null limit 10001');
  expect(sql.includes('count(*) from "public"."tasks"')).toBe(false);
  expect(sql.includes("pg_class")).toBe(false);
  expect(sql.includes("pg_stats")).toBe(false);
});
