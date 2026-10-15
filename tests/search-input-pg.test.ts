/**
 * A malformed advanced search and an unknown text-search configuration.
 *
 * SQLSTATE 42601 on a tsquery is OKM1120. A missing configuration is OKM1122.
 * PGlite always runs. The other adapters run when the topology is up.
 */

import { expect, test } from "bun:test";

import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text, tsvector } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import type { Connected } from "../src/runtime/types.js";

const gate = await loadPostgresGate();
const pages = table("pages", {
  id: id({ default: "none" }),
  title: text(),
  body: tsvector(),
});
const app = schema({ casing: "snake", tables: [pages] });
const ID = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d11";
const BAD = ["'", "!", "&&", "(", "<->", ":*", "deploy OR cats"] as const;

type Db = Connected<typeof app>;

test("pglite maps a bad search and a missing language", async () => {
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    const db = await connectPglite(pool, { schema: app });
    await check(db);
    await db.close();
  } finally {
    await pool.close();
  }
});

for (const driver of ["postgresjs", "pg", "bun"] as const) {
  postgresTest(
    gate,
    `${driver} maps a bad search and a missing language`,
    async () => {
      await withPostgresSchema(async (sql, schemaName) => {
        for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
        const db = openDriver(driver, schemaName);
        try {
          await db.connected;
          await check(db);
        } finally {
          await db.close();
        }
      });
    },
    30_000,
  );
}

function openDriver(driver: "postgresjs" | "pg" | "bun", schemaName: string): Db {
  const url = primaryUrl();
  if (driver === "postgresjs") {
    return connectPostgres(openPostgres({ url, searchPath: schemaName, max: 1 }), { schema: app });
  }
  if (driver === "pg") {
    return connectPg(openPg({ url, searchPath: schemaName, max: 1 }), { schema: app });
  }
  return connectBun(openBun({ url, searchPath: schemaName, max: 1 }), { schema: app });
}

async function check(db: Db): Promise<void> {
  await db.pages.insert({ id: ID, title: "a", body: "'cats':1" });
  for (const search of BAD) {
    const error = await rejection(
      db.pages.find({ search: { for: search, match: "advanced" }, limit: 5 }),
    );
    expect(error.code).toBe("OKM1120");
    expect(error.kind).toBe("invalid");
    expect(error.message.toLowerCase()).toContain("search");
  }
  for (const language of ["nosuchlang", "public.english"] as const) {
    const error = await rejection(
      db.pages.find({ search: { for: "cats", language, match: "advanced" }, limit: 5 }),
    );
    expect(error.code).toBe("OKM1122");
    expect(error.kind).toBe("invalid");
  }
}

async function rejection(pending: Promise<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    return error as OkmError;
  }
  throw new Error("expected a refusal");
}
