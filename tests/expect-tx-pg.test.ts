/**
 * `.expect(n)` runs after the write. Outside `tx()` the rows stay changed.
 * Inside `tx()` the throw rolls the transaction back.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const gate = await loadPostgresGate();
const notes = table("notes", { id: t.identity(), title: t.text() });
const app = schema({ tables: [notes] });

postgresTest(
  gate,
  "expect throws after the update, and tx rolls that update back",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        await db.notes.insert({ title: "a" });
        await db.notes.insert({ title: "a" });
        await db.notes.insert({ title: "a" });

        const rolled = await catchError(() =>
          db.tx(async (tx) => {
            await tx.notes.update({ where: { title: "a" }, set: { title: "b" } }).expect(1);
          }),
        );
        expect(rolled).toBeInstanceOf(OkmError);
        if (rolled instanceof OkmError) expect(rolled.code).toBe("not_found");
        const kept = await db.notes.find({ where: { title: "a" }, limit: 10 });
        expect(kept).toHaveLength(3);

        const committed = await catchError(() =>
          db.notes.update({ where: { title: "a" }, set: { title: "b" } }).expect(1),
        );
        expect(committed).toBeInstanceOf(OkmError);
        if (committed instanceof OkmError) expect(committed.code).toBe("not_found");
        const changed = await db.notes.find({ where: { title: "b" }, limit: 10 });
        expect(changed).toHaveLength(3);
        const left = await db.notes.find({ where: { title: "a" }, limit: 10 });
        expect(left).toHaveLength(0);
      } finally {
        await db.close();
      }
    });
  },
  20_000,
);

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}
