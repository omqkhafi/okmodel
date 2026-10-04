/**
 * Child process for OKM1201 on real Postgres.
 *
 * This file is not a test. The parent spawns it so `okmodel/validate` stays unloaded.
 */

import type { Sql } from "postgres";

import { OkmError } from "../src/contracts/error.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, table, text } from "../src/dialects/pg/index.js";
import type { QuerySchema } from "../src/dialects/pg/model.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

type WriteDb = {
  readonly [name: string]: {
    insert(row: object, options?: object): Promise<{ readonly title: string }>;
  };
};

const schemaOn = table("schema_on", { id: text().primaryKey(), title: text() });
const tableOn = table("table_on", { id: text().primaryKey(), title: text() }, { validation: true });
const inlineOn = table("inline_on", {
  id: text().primaryKey(),
  title: text().validate([]),
});
const plain = table("plain", { id: text().primaryKey(), title: text() });

await prove(schema({ tables: [schemaOn], validation: true }), "schema_on", async (sql, db) => {
  await expectClosed(sql, db, "schema_on");
  const row = await insert(db, "schema_on", { id: "b", title: "ship" }, { validate: false });
  if (row.title !== "ship") throw new Error("validate: false did not write");
});

await prove(schema({ tables: [tableOn] }), "table_on", async (sql, db) => {
  await expectClosed(sql, db, "table_on");
});

await prove(schema({ tables: [inlineOn] }), "inline_on", async (sql, db) => {
  await expectClosed(sql, db, "inline_on");
});

await prove(schema({ tables: [plain], validation: false }), "plain", async (sql, db) => {
  const row = await insert(db, "plain", { id: "a", title: "ship" });
  if (row.title !== "ship") throw new Error("disabled write did not return the row");
  const called = await sql<{ readonly is_called: boolean }[]>`select is_called from proof_seq`;
  if (called[0]?.is_called !== true) throw new Error("disabled write sent nothing");
  const rows = await sql<{ readonly count: number }[]>`select count(*)::int as count from plain`;
  if (rows[0]?.count !== 1) throw new Error("disabled write did not commit");
});

async function prove(
  app: QuerySchema & { readonly catalog: Catalog },
  tableName: string,
  run: (sql: Sql, db: WriteDb) => Promise<void>,
): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    await sql.unsafe("create sequence proof_seq");
    await sql.unsafe(
      "create function proof_bump() returns trigger language plpgsql as $$ begin perform nextval('proof_seq'); return new; end $$",
    );
    await sql.unsafe(
      `create trigger proof_bi before insert on ${tableName} for each row execute function proof_bump()`,
    );
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    try {
      await db.connected;
      await run(sql, db as unknown as WriteDb);
    } finally {
      await db.close();
    }
  });
}

function insert(
  db: WriteDb,
  tableName: string,
  row: object,
  options?: object,
): Promise<{ readonly title: string }> {
  const handle = db[tableName];
  if (handle === undefined) throw new Error(`${tableName} is missing`);
  return handle.insert(row, options);
}

async function expectClosed(sql: Sql, db: WriteDb, tableName: string): Promise<void> {
  let failed: OkmError | undefined;
  try {
    await insert(db, tableName, { id: "a", title: "ship" });
  } catch (error) {
    if (error instanceof OkmError) failed = error;
    else throw error;
  }
  if (failed?.code !== "OKM1201") {
    throw new Error(`${tableName}: expected OKM1201, got ${failed?.code ?? "success"}`);
  }
  if (failed.category !== "input") throw new Error(`${tableName}: category ${failed.category}`);
  if (failed.message !== "Validation is enabled but `okmodel/validate` was not imported.") {
    throw new Error(failed.message);
  }
  const called = await sql<{ readonly is_called: boolean }[]>`select is_called from proof_seq`;
  if (called[0]?.is_called !== false) throw new Error(`${tableName}: a statement was sent`);
  const rows = await sql<{ readonly count: number }[]>`
    select count(*)::int as count from ${sql(tableName)}
  `;
  if (rows[0]?.count !== 0) throw new Error(`${tableName}: a row landed`);
}
