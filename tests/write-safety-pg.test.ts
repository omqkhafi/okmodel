/**
 * Refused writes leave the row count unchanged, including on a tenant table.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { LIST, TASK, TENANT_A, tenantApp } from "./archive-schema.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "QA-C1: an undefined-only where changes no tenant row",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(tenantApp.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: tenantApp, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const scoped = db.for({ tenantId: TENANT_A });
        await scoped.orgs.insert({ id: LIST, name: "Acme" });
        await scoped.tasks.insert({ id: TASK, title: "ship", orgId: LIST });
        const before = await scoped.orgs.count();
        const refused = await scoped.orgs
          .update({ where: { id: undefined }, set: { name: "gone" } })
          .catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(OkmError);
        expect((refused as OkmError).code).toBe("OKM1102");
        const deleted = await scoped.tasks
          .delete({ where: { title: undefined } })
          .catch((error: unknown) => error);
        expect((deleted as OkmError).code).toBe("OKM1102");
        expect(await scoped.orgs.count()).toBe(before);
        expect(await scoped.tasks.count()).toBe(1);
        expect((await scoped.orgs.find({ where: { id: LIST }, limit: 1 }))[0]?.name).toBe("Acme");
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);
