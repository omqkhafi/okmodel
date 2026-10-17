/**
 * Unknown keys on every write path against real Postgres (B-39).
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const NOTE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c51";
const OTHER = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c52";

const notes = table("notes", {
  id: id({ default: "none" }),
  title: text(),
});
const app = schema({ casing: "snake", tables: [notes] });
const gate = await loadPostgresGate();

async function refused(run: () => Promise<unknown>): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    return error as OkmError;
  }
  throw new Error("expected OKM1120");
}

postgresTest(
  gate,
  "B-39: insert, update, upsert, and first-or-create refuse an unknown key",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;

        const insert = await refused(() =>
          db.notes.insert({ id: NOTE, title: "a", nope: 5 } as never),
        );
        expect(insert.code).toBe("OKM1120");
        expect(insert.message).toContain("nope");
        expect(insert.message).toContain("notes");
        expect(await db.notes.count()).toBe(0);

        await db.notes.insert({ id: NOTE, title: "a" });

        const update = await refused(() =>
          db.notes.update({ where: { id: NOTE }, set: { title: "b", nope: 5 } as never }),
        );
        expect(update.code).toBe("OKM1120");
        expect(update.message).toContain("nope");
        expect((await db.notes.one({ where: { id: NOTE } }))?.title).toBe("a");

        const upsert = await refused(() =>
          db.notes.insert({ id: OTHER, title: "c", nope: 1 } as never, {
            onConflict: { on: "id", update: ["title"] },
          }),
        );
        expect(upsert.code).toBe("OKM1120");
        expect(await db.notes.count()).toBe(1);

        const first = await refused(() =>
          db.notes.insert({ id: OTHER, title: "d", nope: true } as never, {
            onConflict: { on: "id", return: true },
          }),
        );
        expect(first.code).toBe("OKM1120");
        expect(await db.notes.count()).toBe(1);

        await db.notes.update({ where: { id: NOTE }, set: { title: "ok" } });
        expect((await db.notes.one({ where: { id: NOTE } }))?.title).toBe("ok");
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);
