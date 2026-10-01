/**
 * Timings for diff, plan, and the scratch-database round trip.
 */

import { generateFixture } from "@okmodel/harness/fixtures";

import { catalogFromFixture } from "../catalog/fixture.js";
import { type SqlRunner } from "../catalog/introspect.js";
import { staticNamespace, type CatalogObject } from "../catalog/object.js";
import { renderCatalog, type NamespaceBinding } from "../catalog/render.js";
import { introspectObjects } from "../catalog/introspect.js";
import { diffCatalog } from "./diff.js";
import { planMigration } from "./plan.js";

/** Diff and plan times for one fixture size. */
export type PlanTiming = {
  readonly tables: number;
  readonly objects: number;
  readonly steps: number;
  readonly diffMs: number;
  readonly planMs: number;
};

/** Apply plus introspect time for one fixture size. */
export type ScratchTiming = {
  readonly tables: number;
  readonly objects: number;
  readonly applyMs: number;
  readonly introspectMs: number;
};

/**
 * Times an in-memory diff and plan.
 *
 * The target adds one nullable column to every table, so the plan grows with
 * the fixture.
 *
 * @param tables - Fixture size
 * @returns Milliseconds and the step count
 */
export function timeDiffAndPlan(tables: 10 | 50 | 200): PlanTiming {
  const namespace = staticNamespace("app");
  const before = catalogFromFixture(generateFixture({ seed: 1, tables }), namespace);
  const after = addColumnToEveryTable(before);
  const bindings = [{ logical: namespace, concrete: "scratch" }];
  const diffStarted = performance.now();
  diffCatalog(before, after);
  const diffMs = performance.now() - diffStarted;
  const planStarted = performance.now();
  const plan = planMigration(before, after, bindings);
  const planMs = performance.now() - planStarted;
  return { tables, objects: before.length, steps: plan.steps.length, diffMs, planMs };
}

/**
 * Times apply plus introspect of a fixture on one scratch schema.
 *
 * @param runner - Scratch database
 * @param schema - Concrete schema, already created
 * @param tables - Fixture size
 * @returns Milliseconds and the introspected object count
 */
export async function timeScratch(
  runner: SqlRunner,
  schema: string,
  tables: 10 | 50 | 200,
): Promise<ScratchTiming> {
  const namespace = staticNamespace("app");
  const objects = catalogFromFixture(generateFixture({ seed: 1, tables }), namespace);
  const bindings: readonly NamespaceBinding[] = [{ logical: namespace, concrete: schema }];
  const statements = renderCatalog(objects, bindings);
  const applyStarted = performance.now();
  for (const statement of statements) await runner.exec(statement);
  const applyMs = performance.now() - applyStarted;
  const introspectStarted = performance.now();
  const introspected = await introspectObjects(runner, [schema], []);
  const introspectMs = performance.now() - introspectStarted;
  return { tables, objects: introspected.length, applyMs, introspectMs };
}

function addColumnToEveryTable(objects: readonly CatalogObject[]): readonly CatalogObject[] {
  const extras: CatalogObject[] = [];
  for (const object of objects) {
    if (object.kind !== "table") continue;
    extras.push({
      kind: "column",
      identity: {
        kind: "column",
        namespace: object.identity.namespace,
        parent: object.identity.name,
        name: "extra",
      },
      owner: "managed",
      definition: { type: "int8", nullable: true },
      dependencies: [{ identity: object.identity }],
      provenance: { source: "migration-spike" },
    });
  }
  return [...objects, ...extras];
}
