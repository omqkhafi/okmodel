/**
 * Parameter budget against real Postgres (B-40).
 *
 * Uses node-postgres: postgres.js refuses at 65,534 parameters in the
 * driver, below the shared limit of 65,533 that OKM1126 enforces (B-48).
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, inList, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { PG_PARAM_LIMIT } from "../src/runtime/param-limit.js";
import { connect } from "../src/runtime/pg/pg.js";

const notes = table("notes", {
  id: id({ default: "none" }),
  title: text(),
});
const app = schema({ casing: "snake", tables: [notes] });
const gate = await loadPostgresGate();

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    return `01890c5a-8f0e-7c3a-9b2d-${String(index).padStart(12, "0")}`;
  });
}

postgresTest(
  gate,
  "B-48: 65533 parameters work; 65534 is OKM1126; filters count toward the limit",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        await db.notes.insert({ id: ids(1)[0]!, title: "a" });

        const atLimit = await db.notes.find({
          where: { id: inList(ids(PG_PARAM_LIMIT - 1)) },
          limit: 1,
        });
        expect(Array.isArray(atLimit)).toBe(true);

        const over = await db.notes
          .find({ where: { id: inList(ids(PG_PARAM_LIMIT)) }, limit: 1 })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(over).toBeInstanceOf(OkmError);
        if (over instanceof OkmError) {
          expect(over.code).toBe("OKM1126");
          expect(over.kind).toBe("invalid");
          expect(over.retryable).toBe(false);
          expect(over.message).toContain(String(PG_PARAM_LIMIT + 1));
        }

        const mixedOk = await db.notes.find({
          where: { id: inList(ids(PG_PARAM_LIMIT - 2)), title: "a" },
          limit: 1,
        });
        expect(Array.isArray(mixedOk)).toBe(true);

        const mixedOver = await db.notes
          .find({
            where: { id: inList(ids(PG_PARAM_LIMIT - 1)), title: "a" },
            limit: 1,
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(mixedOver).toBeInstanceOf(OkmError);
        if (mixedOver instanceof OkmError) {
          expect(mixedOver.code).toBe("OKM1126");
          expect(mixedOver.message).toContain(String(PG_PARAM_LIMIT + 1));
        }
      } finally {
        await db.close();
      }
    });
  },
  120_000,
);
