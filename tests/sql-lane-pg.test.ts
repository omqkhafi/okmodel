/**
 * Typed raw SQL and `explain()` on Postgres 17.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import {
  explain,
  fragment,
  ident,
  id,
  raw,
  schema,
  table,
  text,
} from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl, replicaUrl } from "../packages/harness/src/topology.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
const NOTE_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c01";
const NOTE_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02";
const PAYLOAD = "'; drop table notes; --";

const notes = table("notes", {
  id: id({ default: "none" }),
  title: text(),
  secret: text().hidden().nullable(),
});

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});

class NoteRow {
  id = "";
  title = "";
  n = 0;
}

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "raw SQL keeps the tenant, binds the payload, and explain returns a plan",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const a = db.for({ tenantId: TENANT_A });
        const b = db.for({ tenantId: TENANT_B });
        await a.notes.insert({ id: NOTE_A, title: "hello" });
        await b.notes.insert({ id: NOTE_B, title: PAYLOAD });
        const rows = await raw(
          a.notes,
          NoteRow,
          "read",
          fragment`select ${ident("id")}, ${ident("title")}, ${5} from notes`,
        );
        expect(rows.map((row) => row.id)).toEqual([NOTE_A]);
        expect(rows[0]?.title).toBe("hello");
        expect(rows[0]?.n).toBe(5);
        expect(rows[0]).toBeInstanceOf(NoteRow);
        const injected = await raw(
          a.notes,
          NoteRow,
          "read",
          fragment`select ${ident("id")}, ${ident("title")}, ${0} from notes where ${ident("title")} = ${PAYLOAD}`,
        );
        expect(injected).toEqual([]);
        const other = await raw(
          b.notes,
          NoteRow,
          "read",
          fragment`select ${ident("id")}, ${ident("title")}, ${0} from notes where ${ident("title")} = ${PAYLOAD}`,
        );
        expect(other.map((row) => row.id)).toEqual([NOTE_B]);
        let hidden: unknown;
        try {
          await raw(
            a.notes,
            NoteRow,
            "read",
            fragment`select ${ident("id")}, ${ident("secret")} from notes`,
          );
        } catch (error) {
          hidden = error;
        }
        expect(hidden).toBeInstanceOf(OkmError);
        if (hidden instanceof OkmError) {
          expect(hidden.code).toBe("OKM1120");
          expect(hidden.fix.summary.length).toBeGreaterThan(0);
        }
        const plan = await explain(a.notes, a.notes.find({ limit: 1 }));
        expect(plan.text.toLowerCase()).toContain("select");
        expect(plan.plan?.length).toBeGreaterThan(0);
        expect(typeof plan.plan?.[0]).toBe("string");
        let refused: unknown;
        try {
          await raw(
            a.notes,
            NoteRow,
            "write",
            fragment`delete from notes where ${ident("id")} = ${NOTE_A}`,
          );
        } catch (error) {
          refused = error;
        }
        expect(refused).toBeInstanceOf(OkmError);
        if (refused instanceof OkmError) expect(refused.code).toBe("OKM1702");
        const kept = await a.notes.find({ where: { id: NOTE_A }, limit: 1 });
        expect(kept).toHaveLength(1);
        const open = db.unscoped("reviewed");
        await raw(
          open.notes,
          NoteRow,
          "write",
          fragment`delete from notes where ${ident("id")} = ${NOTE_A}`,
        );
        expect(await a.notes.find({ where: { id: NOTE_A }, limit: 1 })).toEqual([]);
        const seen = await a.notes.find({ limit: 1 }).inspect();
        expect(seen.routing.reason).toBe("single-endpoint");
      } finally {
        await db.close();
      }
    });
  },
);

postgresTest(
  gate,
  "inspect on a topology reports a routing reason",
  async () => {
    const db = await connect(
      { primary: primaryUrl(), replicas: [{ url: replicaUrl("a"), name: "east" }] },
      { schema: app, max: 1 },
    );
    try {
      await db.connected;
      const seen = await db.for({ tenantId: TENANT_A }).notes.find({ limit: 1 }).inspect();
      expect(seen.routing.reason).toMatch(/^(auto:east|constraint:|fallback:|primary-required)/);
    } finally {
      await db.close();
    }
  },
  15_000,
);
