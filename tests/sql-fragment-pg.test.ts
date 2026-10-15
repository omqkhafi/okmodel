/**
 * Composed fragments on Postgres 17: nesting, a bound injection, and tenancy.
 */

import { expect } from "bun:test";

import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { fragment, ident, id, schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
const NOTE_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c01";
const NOTE_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02";
const PAYLOAD = "'; drop table notes; --";

const notes = table("notes", {
  id: id({ default: "none" }),
  title: text(),
  status: text(),
});

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});

const gate = await loadPostgresGate();

postgresTest(gate, "a fragment keeps the tenant and binds the injection", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    try {
      await db.connected;
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      await a.notes.insert({ id: NOTE_A, title: "hello", status: "open" });
      await b.notes.insert({ id: NOTE_B, title: PAYLOAD, status: "open" });
      const open = fragment`${ident("status")} = ${"open"}`;
      const rows = await a.notes.find({
        where: { title: fragment`length(${fragment.column}) > ${3} and ${open}` },
        select: ["id", fragment`length(${ident("title")})`.as("len")],
        limit: 5,
      });
      expect(rows.map((row) => row.id)).toEqual([NOTE_A]);
      expect(rows[0]?.len).toBe(5);
      const injected = await a.notes.find({
        where: { title: fragment`${ident("title")} = ${PAYLOAD}` },
        limit: 5,
      });
      expect(injected).toEqual([]);
      const other = await b.notes.find({
        where: { title: fragment`${ident("title")} = ${PAYLOAD}` },
        limit: 5,
      });
      expect(other.map((row) => row.id)).toEqual([NOTE_B]);
    } finally {
      await db.close();
    }
  });
});
