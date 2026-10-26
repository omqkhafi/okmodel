/**
 * Two sensitive columns that share a field name, on postgres.js, pg, and Bun.sql.
 *
 * Schema order [a, b] used to encode `b_items.pin` with `a_items`' jsonb codec,
 * so the text parameter stayed in clear text. Both orders redact.
 */

import { expect } from "bun:test";

import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { explain, schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import type { Connected } from "../src/runtime/types.js";

const A_PIN = "pin-a-secret-7f3a9c";
const B_PIN = "pin-b-secret-7f3a9c";

function items(order: "ab" | "ba") {
  const aItems = table("a_items", {
    id: t.text().primaryKey(),
    pin: t.jsonb().sensitive(),
  });
  const bItems = table("b_items", {
    id: t.text().primaryKey(),
    pin: t.text().sensitive(),
  });
  return schema({
    casing: "snake",
    tables: order === "ab" ? [aItems, bItems] : [bItems, aItems],
  });
}

const app = items("ab");
const gate = await loadPostgresGate();

type Db = Connected<typeof app>;

function openDriver(
  driver: "postgresjs" | "pg" | "bun",
  schemaName: string,
  built: typeof app,
): Db {
  const url = primaryUrl();
  const options = { schema: built, searchPath: schemaName, max: 1 };
  if (driver === "postgresjs") {
    return connectPostgres(openPostgres({ url, searchPath: schemaName, max: 1 }), options);
  }
  if (driver === "pg") {
    return connectPg(openPg({ url, searchPath: schemaName, max: 1 }), options) as Db;
  }
  return connectBun(openBun({ url, searchPath: schemaName, max: 1 }), options) as Db;
}

function concealed(value: unknown, secret: string): void {
  const text = JSON.stringify(value);
  expect(text).toContain("[redacted]");
  expect(text).not.toContain(secret);
}

postgresTest(
  gate,
  "both schema orders redact b_items.pin on postgres.js, pg, and Bun.sql",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      for (const order of ["ab", "ba"] as const) {
        const built = items(order) as typeof app;
        for (const driver of ["postgresjs", "pg", "bun"] as const) {
          const db = openDriver(driver, schemaName, built);
          try {
            await db.connected;
            concealed(await db.b_items.insert({ id: "1", pin: B_PIN }).inspect(), B_PIN);
            concealed(
              await db.b_items.update({ where: { id: "1" }, set: { pin: B_PIN } }).inspect(),
              B_PIN,
            );
            const found = db.b_items.find({ where: { pin: B_PIN }, limit: 1 });
            concealed(await found.inspect(), B_PIN);
            concealed(await explain(db.b_items, found), B_PIN);
            concealed(await db.a_items.insert({ id: "1", pin: A_PIN }).inspect(), A_PIN);
          } finally {
            await db.close();
          }
        }
      }
    });
  },
  120_000,
);
