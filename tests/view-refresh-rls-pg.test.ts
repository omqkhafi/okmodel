/**
 * Refresh under `rlsTenancy` on real Postgres.
 *
 * The owner is not a superuser. `FORCE ROW LEVEL SECURITY` would refresh zero
 * rows unless the refresh transaction sets `app.unscoped`. The application
 * role is not the owner.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { materializedView } from "../src/dialects/pg/view/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { rlsTenancy } from "../src/runtime/tenancy/index.js";

const PASSWORD = "rlsappsecret";
const TENANT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d01";
const ROW = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d11";

const notes = table("notes", {
  id: uuid().primaryKey(),
  title: text(),
});

const app = schema({
  casing: "snake",
  tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
  views: [
    materializedView("daily_totals", {
      columns: [
        { name: "tenant_id", type: "uuid" },
        { name: "id", type: "uuid" },
        { name: "title", type: "text" },
      ],
      query: "select tenant_id, id, title from notes",
    }),
  ],
});

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "the owner refresh sees rows and the application role is not_owner",
  async () => {
    await withPostgresSchema(async (admin, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await admin.unsafe(statement);
      }
      const ownerRole = `o_${schemaName}`;
      const appRole = `a_${schemaName}`;
      try {
        await admin.unsafe(
          `insert into ${schemaName}.notes (id, tenant_id, title) values ('${ROW}', '${TENANT}', 'a')`,
        );
        for (const role of [ownerRole, appRole]) {
          await admin.unsafe(
            `create role ${role} login password '${PASSWORD}' nosuperuser nobypassrls`,
          );
          await admin.unsafe(`grant connect on database okm to ${role}`);
          await admin.unsafe(`grant usage on schema ${schemaName} to ${role}`);
          await admin.unsafe(`alter role ${role} set search_path to ${schemaName}`);
        }
        await admin.unsafe(`alter table ${schemaName}.notes owner to ${ownerRole}`);
        await admin.unsafe(
          `alter materialized view ${schemaName}.daily_totals owner to ${ownerRole}`,
        );

        const owner = connect(roleUrl(primaryUrl(), ownerRole), {
          schema: app,
          searchPath: schemaName,
          max: 2,
        });
        try {
          await owner.views.dailyTotals.refresh();
          const rows = await admin<{ id: string }[]>`select id from daily_totals`;
          expect(rows.map((row) => row.id)).toEqual([ROW]);
        } finally {
          await owner.close();
        }

        const application = connect(roleUrl(primaryUrl(), appRole), {
          schema: app,
          searchPath: schemaName,
          max: 1,
        });
        try {
          let thrown: unknown;
          try {
            await application.views.dailyTotals.refresh();
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(OkmError);
          if (thrown instanceof OkmError) {
            expect(thrown.fieldReason).toBe("not_owner");
            expect(thrown.message).toContain("migration role");
            expect(thrown.fix.summary).toContain("migration role");
            expect(thrown.fix.summary).toContain("refresh()");
          }
        } finally {
          await application.close();
        }
      } finally {
        await admin
          .unsafe(`alter table if exists ${schemaName}.notes owner to current_user`)
          .catch(() => undefined);
        await admin
          .unsafe(
            `alter materialized view if exists ${schemaName}.daily_totals owner to current_user`,
          )
          .catch(() => undefined);
        await admin.unsafe(`drop role if exists ${ownerRole}`).catch(() => undefined);
        await admin.unsafe(`drop role if exists ${appRole}`).catch(() => undefined);
      }
    });
  },
);

/**
 * A login URL for one role on the same database.
 *
 * @param base - Topology primary URL
 * @param role - Role name
 * @returns The URL
 */
function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = PASSWORD;
  return url.toString();
}
