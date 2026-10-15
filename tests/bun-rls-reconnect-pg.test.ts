/**
 * A Bun.sql reserved handle fails closed after its backend is killed and the
 * pool drains the closed socket.
 *
 * The next scoped read must not come back empty: the new connection has no
 * transaction and no tenant setting.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { open } from "../src/adapters/pg/bunsql.js";
import { connect } from "../src/runtime/pg/bun.js";
import { rlsTenancy } from "../src/runtime/tenancy/index.js";

const gate = await loadPostgresGate();
const TENANT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const NOTE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
const PASSWORD = "rlsappsecret";

const notes = table("notes", {
  id: id({ default: "none" }),
  title: text(),
});
const app = schema({
  casing: "snake",
  tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});

postgresTest(
  gate,
  "a scoped find after a drained backend kill is unavailable, never empty",
  async () => {
    await withPostgresSchema(async (admin, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await admin.unsafe(statement);
      }
      const role = `r_${schemaName}`;
      try {
        await admin.unsafe(
          `create role ${role} login password '${PASSWORD}' nosuperuser nobypassrls`,
        );
        await admin.unsafe(`grant connect on database okm to ${role}`);
        await admin.unsafe(`grant usage on schema ${schemaName} to ${role}`);
        await admin.unsafe(
          `grant select, insert, update, delete on all tables in schema ${schemaName} to ${role}`,
        );
        await admin.unsafe(
          `insert into ${schemaName}.notes (id, tenant_id, title) values ('${NOTE}', '${TENANT}', 'alpha')`,
        );
        const url = new URL(primaryUrl());
        url.username = role;
        url.password = PASSWORD;
        const pool = open({ url: url.toString(), searchPath: schemaName, max: 2 });
        const db = connect(pool, { schema: app });
        let empty = 0;
        let unavailable = 0;
        try {
          await db.connected;
          for (let run = 0; run < 40; run += 1) {
            try {
              await db.for({ tenantId: TENANT }).tx(async (tx) => {
                const first = await tx.notes.find({ limit: 5 });
                expect(first.length).toBe(1);
                await admin.unsafe(
                  "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'okmodel' and state = 'idle in transaction' and pid <> pg_backend_pid()",
                );
                await Bun.sleep(30);
                await pool.execute("select 1").catch(() => undefined);
                const second = await tx.notes.find({ limit: 5 });
                if (second.length === 0) empty += 1;
              });
            } catch (error) {
              expect(error).toBeInstanceOf(OkmError);
              const mapped = error as OkmError;
              expect(mapped.kind).toBe("unavailable");
              expect(mapped.retryable).toBe(true);
              unavailable += 1;
            }
          }
          expect(empty).toBe(0);
          expect(unavailable).toBe(40);
        } finally {
          await db.close();
          await pool.close();
        }
      } finally {
        await admin.unsafe(`drop owned by ${role} cascade`).catch(() => undefined);
        await admin.unsafe(`drop role if exists ${role}`);
      }
    });
  },
  60_000,
);
