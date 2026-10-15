/**
 * An id of 2^64 is kind and code `invalid` on every adapter.
 *
 * postgres.js, node-postgres, and PGlite get SQLSTATE 22003 from the server.
 * Bun.sql rejects the same wire integer before send. PGlite always runs. The
 * other adapters run when the topology is up.
 */

import { expect, test } from "bun:test";

import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { bigint, schema, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";

const gate = await loadPostgresGate();
const marks = table("marks", {
  id: bigint({ as: "bigint" }).primaryKey(),
});
const app = schema({ casing: "snake", tables: [marks] });
const WIDE = 2n ** 64n;
const MAX = 9223372036854775807n;

test("pglite rejects an id of 2^64", async () => {
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    const db = await connectPglite(pool, { schema: app });
    await expectInvalid(db.marks.find({ where: { id: WIDE }, limit: 1 }));
    expect(await db.marks.find({ where: { id: MAX }, limit: 1 })).toEqual([]);
    await db.close();
  } finally {
    await pool.close();
  }
});

for (const driver of ["postgresjs", "pg", "bun"] as const) {
  postgresTest(
    gate,
    `${driver} rejects an id of 2^64`,
    async () => {
      await withPostgresSchema(async (sql, schemaName) => {
        for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
        const db = openDriver(driver, schemaName);
        try {
          await db.connected;
          await expectInvalid(db.marks.find({ where: { id: WIDE }, limit: 1 }));
          expect(await db.marks.find({ where: { id: MAX }, limit: 1 })).toEqual([]);
        } finally {
          await db.close();
        }
      });
    },
    30_000,
  );
}

function openDriver(driver: "postgresjs" | "pg" | "bun", schemaName: string) {
  const url = primaryUrl();
  if (driver === "postgresjs") {
    return connectPostgres(openPostgres({ url, searchPath: schemaName, max: 1 }), { schema: app });
  }
  if (driver === "pg") {
    return connectPg(openPg({ url, searchPath: schemaName, max: 1 }), { schema: app });
  }
  return connectBun(openBun({ url, searchPath: schemaName, max: 1 }), { schema: app });
}

async function expectInvalid(pending: Promise<unknown>): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (!(error instanceof OkmError)) return;
    expect(error.kind).toBe("invalid");
    expect(error.code).toBe("invalid");
    return;
  }
  throw new Error("expected invalid");
}
