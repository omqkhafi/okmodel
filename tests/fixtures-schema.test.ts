import { expect, test } from "bun:test";

import { withPgliteSchema, withPostgresSchema } from "../packages/harness/src/index.js";
import {
  FIXTURE_SIZES,
  fixtureHash,
  generateFixture,
  renderFixtureDdl,
  type FixtureSize,
  type FixtureTenancy,
} from "../packages/harness/src/fixtures.js";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "./postgres-gate.js";

/**
 * SHA-256 of the seed-1 fixture and its DDL.
 * Regenerated only when the generator changes on purpose.
 */
const RECORDED_HASHES: Record<FixtureTenancy, Record<FixtureSize, string>> = {
  none: {
    10: "4388a9c41301484a0558ad168d202eaa5875b5facf75b4f86328ac9c38ee8844",
    50: "47be8513d824a19f5e0d16667925e4c4804892019fde9b0ea1fb1887c07bdf16",
    200: "1fbd78ba8663982acad5426bf3803b1f784f15665db5ebf44d9615e056b61101",
    500: "0f1a126d4a02e2bdf3a279e00f142e729713e5c94ae36fda65916c4ff5c680b8",
  },
  column: {
    10: "18ccfd3965e4c6f6ac1ec41f1f373426acd16f32408cece58d20cdc0e72bdd21",
    50: "61c98b71ee15fd711efb6ae05c5b80aa21faacbf7d5c557bf79f8f2a5064f562",
    200: "622f646d4d3f96fc5f6f36c6363ea06b9673cbb579815c8e6f0659255d5f2c0a",
    500: "c483d6a909b8f38cf5b367132cd033df3aa172adeffc3ff2b7bd20390a1e695c",
  },
};

test("the same seed produces the same fixture", () => {
  const left = generateFixture({ seed: 7, tables: 50, tenancy: "column" });
  const right = generateFixture({ seed: 7, tables: 50, tenancy: "column" });
  expect(renderFixtureDdl(left)).toBe(renderFixtureDdl(right));
  expect(fixtureHash(left, renderFixtureDdl(left))).toBe(
    fixtureHash(right, renderFixtureDdl(right)),
  );
});

test("different seeds produce different DDL", () => {
  const left = renderFixtureDdl(generateFixture({ seed: 1, tables: 10 }));
  const right = renderFixtureDdl(generateFixture({ seed: 2, tables: 10 }));
  expect(left).not.toBe(right);
});

test("every size has keys, indexes, and a recorded hash", () => {
  for (const tables of FIXTURE_SIZES) {
    for (const tenancy of ["none", "column"] as const) {
      const fixture = generateFixture({ seed: 1, tables, tenancy });
      const ddl = renderFixtureDdl(fixture);
      expect(fixture.tables).toHaveLength(tables);
      expect(ddl).toContain("foreign key");
      expect(ddl).toContain("create unique index");
      expect(ddl).toContain("create index");
      if (tenancy === "column") expect(ddl).toContain("tenant_id uuid not null");
      const recorded = RECORDED_HASHES[tenancy][tables];
      if (recorded === undefined) throw new Error(`missing hash for ${tenancy} ${tables}`);
      expect(fixtureHash(fixture, ddl)).toBe(recorded);
    }
  }
});

for (const tables of FIXTURE_SIZES) {
  test(`fixture DDL for ${tables} tables applies on PGlite`, async () => {
    const ddl = renderFixtureDdl(generateFixture({ seed: 1, tables }));
    await withPgliteSchema(async (db) => {
      await db.exec(ddl);
      const rows = await db.query<{ n: number }>(
        "select count(*)::int as n from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'",
      );
      expect(rows.rows[0]?.n).toBe(tables);
    });
  });
}

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

for (const tables of FIXTURE_SIZES) {
  postgresTest(decision, `fixture DDL for ${tables} tables applies on Postgres`, async () => {
    const ddl = renderFixtureDdl(generateFixture({ seed: 1, tables, tenancy: "column" }));
    await withPostgresSchema(async (sql) => {
      await sql.unsafe(ddl);
      const rows = await sql<
        { n: number }[]
      >`select count(*)::int as n from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'`;
      expect(rows[0]?.n).toBe(tables);
    });
  });
}
