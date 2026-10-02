/**
 * Planner behavior that does not need a database: order, renames, drift hash.
 */

import { expect, test } from "bun:test";

import { staticNamespace } from "../catalog/object.js";
import { parsePartitionBound } from "../catalog/sql.js";
import { structuralDriftHash } from "./equal.js";
import { MigrationError } from "./error.js";
import {
  PROPERTY_SEEDS,
  dependencyPair,
  migrationPair,
  renamePair,
  typeChangePair,
} from "./generate.js";

const propertyExtensions = ["pgcrypto"] as const;
import { planMigration, planSql } from "./plan.js";

const bindings = [{ logical: staticNamespace("app"), concrete: "scratch" }];

test("property mutations reach policies, matviews, sequences, and extensions", () => {
  const seen = new Set<string>();
  for (const seed of PROPERTY_SEEDS) {
    const pair = migrationPair(seed, { extensions: propertyExtensions });
    for (const object of [...pair.before, ...pair.after]) seen.add(object.kind);
  }
  expect(seen.has("policy")).toBe(true);
  expect(seen.has("materialized_view")).toBe(true);
  expect(seen.has("sequence")).toBe(true);
  expect(seen.has("extension")).toBe(true);
});

test("a dropped function's trigger is dropped first", () => {
  let seen = false;
  for (const seed of PROPERTY_SEEDS) {
    const pair = migrationPair(seed, { extensions: propertyExtensions });
    const sql = planSql(planMigration(pair.before, pair.after, bindings, pair.renames));
    const dropTrigger = sql.findIndex((statement) => statement.startsWith("drop trigger"));
    const dropFunction = sql.findIndex((statement) => statement.startsWith("drop function"));
    if (dropTrigger < 0 || dropFunction < 0) continue;
    seen = true;
    expect(dropTrigger).toBeLessThan(dropFunction);
  }
  expect(seen).toBe(true);
});

test("an unchanged catalog plans no statements", () => {
  const pair = migrationPair(1);
  const plan = planMigration(pair.before, pair.before, bindings);
  expect(plan.steps).toHaveLength(0);
});

test("every property pair plans without CASCADE", () => {
  for (const seed of PROPERTY_SEEDS) {
    const pair = migrationPair(seed, { extensions: propertyExtensions });
    const sql = planSql(planMigration(pair.before, pair.after, bindings, pair.renames)).join("\n");
    expect(sql.toLowerCase()).not.toContain("cascade");
  }
});

test("an undeclared same-type drop and add is OKM1530", () => {
  const pair = renamePair();
  expect(() => planMigration(pair.before, pair.after, bindings)).toThrow(MigrationError);
  try {
    planMigration(pair.before, pair.after, bindings);
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError);
    if (error instanceof MigrationError) {
      expect(error.code).toBe("OKM1530");
      expect(error.message).toContain("renamedFrom");
    }
  }
});

test("a declared rename drops dependents before the rename and recreates them after", () => {
  const pair = renamePair();
  const sql = planSql(planMigration(pair.before, pair.after, bindings, pair.renames));
  expect(sql.join("\n").toLowerCase()).not.toContain("cascade");
  const rename = sql.findIndex((statement) => statement.includes("rename column"));
  const dropView = sql.findIndex((statement) => statement.startsWith("drop view"));
  const dropIndex = sql.findIndex((statement) => statement.startsWith("drop index"));
  const dropCheck = sql.findIndex((statement) => statement.includes("drop constraint"));
  const createView = sql.findIndex((statement) => statement.startsWith("create view"));
  const createIndex = sql.findIndex((statement) => statement.startsWith("create index"));
  const createCheck = sql.findIndex((statement) => statement.includes("add constraint"));
  expect(dropView).toBeGreaterThanOrEqual(0);
  expect(dropIndex).toBeGreaterThanOrEqual(0);
  expect(dropCheck).toBeGreaterThanOrEqual(0);
  expect(dropView).toBeLessThan(rename);
  expect(dropIndex).toBeLessThan(rename);
  expect(dropCheck).toBeLessThan(rename);
  expect(rename).toBeLessThan(createCheck);
  expect(rename).toBeLessThan(createIndex);
  expect(rename).toBeLessThan(createView);
});

test("a column type change drops dependents, alters, then recreates", () => {
  const pair = typeChangePair();
  const sql = planSql(planMigration(pair.before, pair.after, bindings));
  expect(sql.join("\n").toLowerCase()).not.toContain("cascade");
  const alter = sql.findIndex((statement) => statement.includes("type int4"));
  expect(sql.findIndex((statement) => statement.startsWith("drop view"))).toBeLessThan(alter);
  expect(sql.findIndex((statement) => statement.startsWith("drop index"))).toBeLessThan(alter);
  expect(sql.findIndex((statement) => statement.includes("drop constraint"))).toBeLessThan(alter);
  expect(alter).toBeLessThan(sql.findIndex((statement) => statement.startsWith("create view")));
  expect(alter).toBeLessThan(sql.findIndex((statement) => statement.startsWith("create index")));
});

test("a missing plpgsql dependency does not drop the function when the table goes away", () => {
  const missing = dependencyPair(false);
  const missingSql = planSql(planMigration(missing.before, missing.after, bindings));
  expect(missingSql.some((statement) => statement.startsWith("drop function"))).toBe(false);
  expect(missingSql.some((statement) => statement.startsWith("drop table"))).toBe(true);

  const declared = dependencyPair(true);
  const declaredSql = planSql(planMigration(declared.before, declared.after, bindings));
  const dropFunction = declaredSql.findIndex((statement) => statement.startsWith("drop function"));
  const dropTable = declaredSql.findIndex((statement) => statement.startsWith("drop table"));
  expect(dropFunction).toBeGreaterThanOrEqual(0);
  expect(dropFunction).toBeLessThan(dropTable);
});

test("the structural drift hash ignores source SQL and object order", () => {
  const objects = migrationPair(1).before;
  const reversed = [...objects].reverse();
  expect(structuralDriftHash(objects)).toBe(structuralDriftHash(reversed));
  const reworded = objects.map((object) =>
    object.kind === "view"
      ? { ...object, definition: { ...object.definition, sql: `${object.definition.sql} ` } }
      : object,
  );
  expect(structuralDriftHash(reworded)).toBe(structuralDriftHash(objects));
  const drifted = objects.map((object) =>
    object.kind === "column" && object.identity.name === "title"
      ? { ...object, definition: { ...object.definition, type: "int8" } }
      : object,
  );
  expect(structuralDriftHash(drifted)).not.toBe(structuralDriftHash(objects));
});

test("partition bound text normalises integers, timestamps, lists, and hashes", () => {
  expect(parsePartitionBound("FOR VALUES FROM ('0') TO ('100')")).toBe("0:100");
  expect(
    parsePartitionBound("FOR VALUES FROM ('2020-01-01 00:00:00+00') TO ('2021-01-01 00:00:00+00')"),
  ).toBe("timestamptz:2020-01-01 00:00:00+00|2021-01-01 00:00:00+00");
  expect(parsePartitionBound("FOR VALUES IN (1, 2)")).toBe("list:1,2");
  expect(parsePartitionBound("FOR VALUES WITH (modulus 2, remainder 0)")).toBe("hash:2:0");
});
