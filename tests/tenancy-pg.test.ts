/**
 * Two tenants on real Postgres share ids and names, and do not see each other.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { every, has, none } from "../src/dialects/pg/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { app, COUNTRY, ORG, ORG_B_ONLY, TASK, TENANT_A, TENANT_B } from "./tenancy-schema.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "two tenants keep the same ids and names, and the scope stays on the SQL",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const columns = await sql<{ table_name: string; column_name: string }[]>`
        select table_name, column_name
        from information_schema.columns
        where table_schema = ${schemaName} and column_name = 'tenant_id'
        order by table_name
      `;
      expect(columns.map((column) => column.table_name)).toEqual(["orgs", "tasks"]);

      const constraints = await sql<{ def: string }[]>`
        select pg_get_constraintdef(c.oid) as def
        from pg_constraint c
        join pg_namespace n on n.oid = c.connamespace
        where n.nspname = ${schemaName}
      `;
      const defs = constraints.map((row) => row.def);
      expect(defs).toContain("PRIMARY KEY (id, tenant_id)");
      expect(defs).toContain("UNIQUE (id, tenant_id)");
      expect(defs).toContain("UNIQUE (tenant_id, title)");
      expect(defs).toContain("UNIQUE (code)");
      expect(defs.some((def) => def.includes("FOREIGN KEY (org_id, tenant_id)"))).toBe(true);

      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        await db.countries.insert({ id: COUNTRY, name: "France" });
        const a = db.for({ tenantId: TENANT_A });
        const b = db.for({ tenantId: TENANT_B });

        const stored = await a.orgs.insert([
          { id: ORG, name: "Acme" },
          { id: TASK, name: "Other" },
        ]);
        expect(stored.map((row) => row.tenantId)).toEqual([TENANT_A, TENANT_A]);
        expect(stored.map((row) => row.name)).toEqual(["Acme", "Other"]);
        await b.orgs.insert([
          { id: ORG, name: "Acme" },
          { id: ORG_B_ONLY, name: "Only B" },
        ]);
        await a.tasks.insert({ id: TASK, title: "ship", code: "a-code", orgId: ORG });
        await b.tasks.insert({ id: TASK, title: "ship", code: "b-code", orgId: ORG });
        await b.tasks.insert({
          id: ORG_B_ONLY,
          title: "secret",
          code: "b-secret",
          orgId: ORG_B_ONLY,
        });

        const read = a.tasks.find({ where: { title: "ship" }, limit: 5 });
        const described = read.sql();
        if (described instanceof Promise) throw new Error("find planned asynchronously");
        expect(described.text).toContain('"tenant_id" = ');
        expect(described.params[0]).toBe(TENANT_A);
        expect(described.text.includes(TENANT_A)).toBe(false);
        expect((await read).map((row) => row.id)).toEqual([TASK]);

        expect(
          (await b.tasks.find({ where: { title: "ship" }, limit: 5 })).map((row) => row.code),
        ).toEqual(["b-code"]);
        expect(await a.tasks.count({ where: { title: "ship" } })).toBe(1);
        expect(await b.tasks.exists({ where: { title: "secret" } })).toBe(true);
        expect(await a.tasks.exists({ where: { title: "secret" } })).toBe(false);

        const withOrg = await a.tasks.find({
          where: { id: TASK },
          limit: 1,
          include: { org: true },
        });
        expect(withOrg[0]?.org).toMatchObject({ id: ORG, name: "Acme", tenantId: TENANT_A });
        const orgSql = await a.tasks
          .find({ where: { id: TASK }, limit: 1, include: { org: true } })
          .sql();
        expect(orgSql.text).toContain('"tenant_id" = ');
        expect(orgSql.params[0]).toBe(TENANT_A);

        const withTasks = await a.orgs.find({
          where: { id: ORG },
          limit: 1,
          include: { tasks: { limit: 5 } },
        });
        expect(withTasks[0]?.tasks.map((row) => row.title)).toEqual(["ship"]);
        expect(withTasks[0]?.tasks.every((row) => row.tenantId === TENANT_A)).toBe(true);

        expect(
          (await a.orgs.find({ where: { tasks: has({ title: "secret" }) }, limit: 5 })).map(
            (row) => row.id,
          ),
        ).toEqual([]);
        expect(
          (await b.orgs.find({ where: { tasks: has({ title: "secret" }) }, limit: 5 })).map(
            (row) => row.id,
          ),
        ).toEqual([ORG_B_ONLY]);
        expect(
          (await a.orgs.find({ where: { tasks: none({ title: "secret" }) }, limit: 5 }))
            .map((row) => row.id)
            .sort(),
        ).toEqual([ORG, TASK].sort());
        expect(
          (
            await a.orgs.find({
              where: { id: ORG, tasks: every({ title: "ship" }) },
              limit: 5,
            })
          ).map((row) => row.id),
        ).toEqual([ORG]);

        const hasSql = a.orgs.find({ where: { tasks: has({ title: "ship" }) }, limit: 5 }).sql();
        if (hasSql instanceof Promise) throw new Error("has planned asynchronously");
        expect(hasSql.text).toContain('"tenant_id" = ');
        const everySql = a.orgs
          .find({ where: { tasks: every({ title: "ship" }) }, limit: 5 })
          .sql();
        if (everySql instanceof Promise) throw new Error("every planned asynchronously");
        expect(everySql.text).toContain('"tenant_id" = ');

        expect(await a.orgs.update({ where: { id: ORG }, set: { name: "Acme A" } })).toEqual({
          count: 1,
        });
        const updateSql = await a.orgs
          .update({ where: { id: ORG }, set: { name: "Acme A" } })
          .sql();
        expect(updateSql.statements[0]?.text).toContain('"tenant_id" = ');
        expect(updateSql.statements[0]?.params).toContain(TENANT_A);
        expect((await b.orgs.find({ where: { id: ORG }, limit: 1 }))[0]?.name).toBe("Acme");

        expect(await b.tasks.update([{ where: { id: TASK }, set: { title: "renamed" } }])).toEqual({
          count: 1,
        });
        expect((await a.tasks.find({ where: { id: TASK }, limit: 1 }))[0]?.title).toBe("ship");
        expect((await b.tasks.find({ where: { id: TASK }, limit: 1 }))[0]?.title).toBe("renamed");

        const open = db.unscoped("nightly report");
        const report = open.tasks.find({ where: { title: "ship" }, limit: 5 });
        const reportSql = report.sql();
        if (reportSql instanceof Promise) throw new Error("unscoped find planned asynchronously");
        expect(reportSql.text.includes('"tenant_id" = ')).toBe(false);
        expect(await report).toHaveLength(1);
        const viewed = open.orgs.find({ limit: 5 }).inspect();
        if (viewed instanceof Promise) throw new Error("unscoped inspect planned asynchronously");
        expect(viewed.rules.some((rule) => rule.contribution === "unscoped nightly report")).toBe(
          true,
        );
        await expectCode(open.orgs.insert({ id: ORG, name: "nope" }), "OKM1701");

        await expectCode(
          a.tasks.insert({ id: ORG, title: "ship", code: "other", orgId: ORG }),
          "unique",
        );
        await expectCode(
          a.tasks.insert({ id: ORG, title: "fresh", code: "b-code", orgId: ORG }),
          "unique",
        );
        await expectCode(
          a.tasks.insert({ id: ORG, title: "fresh", code: "fresh", orgId: ORG_B_ONLY }),
          "foreign_key",
        );

        expect(await a.tasks.delete({ where: { title: "ship" } })).toEqual({ count: 1 });
        const deleteSql = await b.tasks.delete({ where: { id: TASK } }).sql();
        expect(deleteSql.statements[0]?.text).toContain('"tenant_id" = ');
        expect(await b.tasks.exists({ where: { id: TASK } })).toBe(true);
        expect(await a.tasks.exists({ where: { id: TASK } })).toBe(false);
        expect(await b.tasks.delete({ where: { id: TASK } })).toEqual({ count: 1 });

        await expectCode(
          a.tasks.insert({
            id: ORG,
            title: "input",
            code: "input",
            orgId: ORG,
            tenantId: TENANT_A,
          } as never),
          "OKM1190",
        );
        await expectCode(
          a.orgs.update({ where: { id: ORG }, set: { tenantId: TENANT_B } } as never),
          "OKM1704",
        );

        expect((await db.countries.find({ limit: 5 })).map((row) => row.name)).toEqual(["France"]);
        expect(await db.countries.count()).toBe(1);
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
