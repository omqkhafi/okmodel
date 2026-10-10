/**
 * `onConflict: { on: "title" }` on a tenant unique of (tenant key, title).
 *
 * Real Postgres. Two tenants keep the same title. A conflict updates only the
 * caller's row, including when the upsert races a delete.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { ORG, TASK, TENANT_A, TENANT_B, app } from "./tenancy-schema.js";

const ROW_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c11";
const ROW_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c12";
const TITLE = "shared-title";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "tenant onConflict includes the tenant key and does not update the other tenant",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 4 });
      try {
        await db.connected;
        await db.countries.insert({ id: TASK, name: "unused" });
        const a = db.for({ tenantId: TENANT_A });
        const b = db.for({ tenantId: TENANT_B });
        await a.orgs.insert({ id: ORG, name: "Acme" });
        await b.orgs.insert({ id: ORG, name: "Acme" });

        await a.tasks.insert({ id: ROW_A, title: TITLE, code: "a-code", orgId: ORG });
        await b.tasks.insert({ id: ROW_B, title: TITLE, code: "b-code", orgId: ORG });

        const described = await a.tasks
          .insert(
            { id: TASK, title: TITLE, code: "a-next", orgId: ORG },
            { onConflict: { on: "title", update: ["code"] } },
          )
          .sql();
        expect(described.statements[0]?.text).toContain(
          'on conflict ("tenant_id", "title") do update set "code"',
        );
        expect(described.statements[0]?.text).toContain('"tenant_id"');

        const updated = await a.tasks.insert(
          { id: TASK, title: TITLE, code: "a-next", orgId: ORG },
          { onConflict: { on: "title", update: ["code"] } },
        );
        expect(updated.id).toBe(ROW_A);
        expect(updated.code).toBe("a-next");
        expect(updated.tenantId).toBe(TENANT_A);
        const other = await b.tasks.one({ where: { id: ROW_B } });
        expect(other?.title).toBe(TITLE);
        expect(other?.code).toBe("b-code");
        expect(other?.tenantId).toBe(TENANT_B);

        await expectCode(
          a.tasks.insert({ id: TASK, title: TITLE, code: "named-key", orgId: ORG }, {
            onConflict: { on: ["tenantId", "title"], update: ["code"] },
          } as never),
          "OKM1104",
        );

        for (let round = 0; round < 24; round += 1) {
          const aCode = `a-${String(round)}`;
          const bCode = `b-${String(round)}`;
          await a.tasks.delete({ where: { title: TITLE } });
          await a.tasks.insert({ id: ROW_A, title: TITLE, code: "a-base", orgId: ORG });
          await b.tasks.update({ where: { id: ROW_B }, set: { code: "b-base", title: TITLE } });
          await Promise.all([
            a.tasks.insert(
              { id: TASK, title: TITLE, code: aCode, orgId: ORG },
              { onConflict: { on: "title", update: ["code"] } },
            ),
            b.tasks.insert(
              { id: TASK, title: TITLE, code: bCode, orgId: ORG },
              { onConflict: { on: "title", update: ["code"] } },
            ),
            a.tasks.delete({ where: { id: ROW_A } }),
          ]);
          const kept = await b.tasks.one({ where: { title: TITLE } });
          expect(kept?.id).toBe(ROW_B);
          expect(kept?.code).toBe(bCode);
          expect(kept?.tenantId).toBe(TENANT_B);
          const leaked = await a.tasks.find({ where: { code: bCode }, limit: 5 });
          expect(leaked).toEqual([]);
          const stolen = await b.tasks.find({ where: { code: aCode }, limit: 5 });
          expect(stolen).toEqual([]);
        }
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

async function expectCode(pending: Promise<unknown>, code: string): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}
