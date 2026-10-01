/**
 * Diff, plan, and scratch round-trip cost on the fixture catalogs.
 */

import { expect, test } from "bun:test";

import { isolatedSchemaName, withPostgres } from "@okmodel/harness";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { postgresRunner } from "../catalog/runners.js";
import { timeDiffAndPlan, timeScratch } from "./measure.js";

test("diff and plan stay cheap on the 10, 50, and 200 table fixtures", () => {
  for (const tables of [10, 50, 200] as const) {
    const timing = timeDiffAndPlan(tables);
    expect(timing.objects).toBeGreaterThan(tables);
    expect(timing.steps).toBe(tables);
    expect(timing.diffMs).toBeLessThan(2_000);
    expect(timing.planMs).toBeLessThan(5_000);
    console.log(
      JSON.stringify({
        event: "migration-plan",
        tables,
        objects: timing.objects,
        steps: timing.steps,
        diffMs: round(timing.diffMs),
        planMs: round(timing.planMs),
      }),
    );
  }
});

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

postgresTest(
  decision,
  "scratch round trip cost on the 10, 50, and 200 table fixtures",
  async () => {
    await withPostgres(async (sql) => {
      const runner = postgresRunner(sql);
      for (const tables of [10, 50, 200] as const) {
        const schema = isolatedSchemaName();
        await sql.unsafe(`create schema ${schema}`);
        await sql.unsafe(`set search_path to ${schema}`);
        try {
          const timing = await timeScratch(runner, schema, tables);
          expect(timing.objects).toBeGreaterThan(tables);
          console.log(
            JSON.stringify({
              event: "migration-scratch",
              tables,
              objects: timing.objects,
              applyMs: round(timing.applyMs),
              introspectMs: round(timing.introspectMs),
            }),
          );
        } finally {
          await sql.unsafe("set search_path to public");
          await sql.unsafe(`drop schema if exists ${schema} cascade`);
        }
      }
    });
  },
  120_000,
);

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
