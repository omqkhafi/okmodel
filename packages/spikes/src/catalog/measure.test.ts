import { expect, test } from "bun:test";

import { withPgliteSchema, withPostgresSchema } from "@okmodel/harness";
import { generateFixture } from "@okmodel/harness/fixtures";

import { catalogHash, measureCatalogHash } from "./canonical.js";
import { catalogFromFixture } from "./fixture.js";
import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "./gate.js";
import { introspectObjects } from "./introspect.js";
import { staticNamespace } from "./object.js";
import { renderCatalog } from "./render.js";
import { pgliteRunner, postgresRunner } from "./runners.js";

test("fixture catalogs of 10, 50, and 200 tables hash stably", () => {
  const recorded: Record<10 | 50 | 200, string> = {
    10: "3b23e533a5b5305696150204ca7fdbbb6a445e8f945190611db8611366ad1a68",
    50: "94321b4332db219fd1d40b23d7b1f5a9b5969f4b9681a250e7cf9cf199a7310a",
    200: "14f2559ce919e4574780340cd2715a2dd9518cd5aeb6430da922c9cc2730410c",
  };
  for (const tables of [10, 50, 200] as const) {
    const objects = catalogFromFixture(
      generateFixture({ seed: 1, tables }),
      staticNamespace("public"),
    );
    const timing = measureCatalogHash(objects, 20);
    expect(timing.objects).toBeGreaterThan(tables);
    expect(catalogHash(objects)).toBe(recorded[tables]);
    expect(catalogHash(objects)).toBe(catalogHash([...objects].reverse()));
    console.log(
      JSON.stringify({
        event: "catalog-hash",
        tables,
        objects: timing.objects,
        onceMs: round(timing.onceMs),
        meanMs: round(timing.meanMs),
      }),
    );
  }
});

test(
  "pglite introspection of 200 tables",
  async () => {
    const timing = await timeIntrospection(async (schema, statements) => {
      await withPgliteSchema(async (db, scratch) => {
        const runner = pgliteRunner(db);
        const applyStarted = performance.now();
        for (const statement of statements(scratch)) await runner.exec(statement);
        const applyMs = performance.now() - applyStarted;
        const introspectStarted = performance.now();
        const objects = await introspectObjects(runner, [scratch], []);
        const introspectMs = performance.now() - introspectStarted;
        expect(objects.filter((object) => object.kind === "table")).toHaveLength(200);
        console.log(
          JSON.stringify({
            event: "catalog-introspect",
            engine: "pglite",
            schema,
            tables: 200,
            objects: objects.length,
            applyMs: round(applyMs),
            introspectMs: round(introspectMs),
          }),
        );
      });
    });
    expect(timing).toBe("ran");
  },
  { timeout: 120_000 },
);

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

postgresTest(
  decision,
  "postgres introspection of 200 tables",
  async () => {
    await timeIntrospection(async (_schema, statements) => {
      await withPostgresSchema(async (sql, scratch) => {
        const runner = postgresRunner(sql);
        const applyStarted = performance.now();
        for (const statement of statements(scratch)) await runner.exec(statement);
        const applyMs = performance.now() - applyStarted;
        const introspectStarted = performance.now();
        const objects = await introspectObjects(runner, [scratch], []);
        const introspectMs = performance.now() - introspectStarted;
        expect(objects.filter((object) => object.kind === "table")).toHaveLength(200);
        console.log(
          JSON.stringify({
            event: "catalog-introspect",
            engine: "postgres",
            tables: 200,
            objects: objects.length,
            applyMs: round(applyMs),
            introspectMs: round(introspectMs),
          }),
        );
      });
    });
  },
  120_000,
);

async function timeIntrospection(
  run: (schema: string, statements: (schema: string) => readonly string[]) => Promise<void>,
): Promise<"ran"> {
  const namespace = staticNamespace("public");
  const objects = catalogFromFixture(generateFixture({ seed: 1, tables: 200 }), namespace);
  await run("public", (schema) =>
    renderCatalog(objects, [{ logical: namespace, concrete: schema }]),
  );
  return "ran";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
