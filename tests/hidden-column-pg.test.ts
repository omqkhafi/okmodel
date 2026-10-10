/**
 * A hidden column is refused in `where` and `orderBy`.
 *
 * `hidden({ filterable: true })` may be named there and stays out of the
 * default row. `filters()` still refuses it. A tenant client cannot probe a
 * hidden column. Real Postgres.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";
const ROW_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c23";
const ROW_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c24";

const notes = table("notes", {
  id: uuid().primaryKey(),
  title: text(),
  secret: text().hidden(),
  code: text().hidden({ filterable: true }),
});

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});

const gate = await loadPostgresGate();

async function expectHidden(pending: PromiseLike<unknown>): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1120");
      expect(error.fix.summary).toContain("hidden({ filterable: true })");
    }
    return;
  }
  throw new Error("expected OKM1120");
}

postgresTest(gate, "hidden columns stay out of where and orderBy unless filterable", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 4 });
    try {
      await db.connected;
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      const inserted = await a.notes.insert({
        id: ROW_A,
        title: "a",
        secret: "a-secret",
        code: "shared",
      });
      expect(inserted).toEqual({ id: ROW_A, title: "a", tenantId: TENANT_A });
      await b.notes.insert({ id: ROW_B, title: "b", secret: "b-secret", code: "shared" });

      await expectHidden(a.notes.find({ where: { secret: "a-secret" }, limit: 5 }));
      await expectHidden(a.notes.find({ orderBy: { secret: "asc" } as never, limit: 5 }));
      await expectHidden(a.notes.one({ where: { secret: "a-secret" } }));
      await expectHidden(a.notes.one({ orderBy: { secret: "desc" } as never }));
      await expectHidden(a.notes.count({ where: { secret: "b-secret" } as never }));
      await expectHidden(a.notes.aggregate({ where: { secret: "a-secret" }, count: true }));
      await expectHidden(
        a.notes.aggregate({ count: true, orderBy: { secret: "asc" }, limit: 5 } as never),
      );
      await expectHidden(
        a.notes.page({ where: { secret: "a-secret" }, orderBy: { title: "asc" }, limit: 2 }),
      );
      await expectHidden(a.notes.page({ orderBy: { secret: "asc" }, limit: 2 } as never));
      await expectHidden(
        a.notes.update({ where: { secret: "a-secret" } as never, set: { title: "no" } }),
      );
      await expectHidden(a.notes.delete({ where: { secret: "a-secret" } as never }));

      const found = await a.notes.find({ where: { code: "shared" }, limit: 5 });
      expect(found).toEqual([{ id: ROW_A, title: "a", tenantId: TENANT_A }]);
      const ordered = await a.notes.find({ orderBy: { code: "asc" } as never, limit: 5 });
      expect(ordered.map((row) => row.id)).toEqual([ROW_A]);
      const named = (await a.notes.find({
        select: ["secret"] as never,
        where: { id: ROW_A },
        limit: 1,
      })) as unknown as readonly { readonly secret: string }[];
      expect(named[0]?.secret).toBe("a-secret");

      expect(() => notes.filters({ allow: { secret: ["eq"] } })).toThrow(OkmError);
      expect(() => notes.filters({ allow: { code: ["eq"] } })).toThrow(OkmError);
      try {
        notes.filters({ allow: { code: ["eq"] } });
      } catch (error) {
        expect(error).toBeInstanceOf(OkmError);
        if (error instanceof OkmError) expect(error.code).toBe("OKM1123");
      }

      await expectHidden(b.notes.count({ where: { secret: "a-secret" } as never }));
      await expectHidden(b.notes.find({ where: { secret: "a-secret" }, limit: 5 }));
    } finally {
      await db.close();
    }
  });
});
