/**
 * Primary keys on a real Postgres: natural, composite, caller-supplied, and uuidv4 ids.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";

const app = schema({
  tables: [
    table("skus", { code: t.text().primaryKey(), name: t.text() }),
    table(
      "members",
      { userId: t.uuid(), orgId: t.uuid(), role: t.text() },
      { primaryKey: ["userId", "orgId"] },
    ),
    table("events", { id: t.id({ default: "none" }), name: t.text() }),
    table("sessions", { id: t.id({ default: "uuidv4" }) }),
  ],
});

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "natural keys, composite keys, and caller-supplied ids insert and find",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const sku = await db.skus.insert({ code: "ADA", name: "Ada" });
        expect(sku.code).toBe("ADA");
        expect(sku.name).toBe("Ada");
        const found = await db.skus.find({ where: { code: "ADA" }, limit: 1 });
        expect(found[0]?.name).toBe("Ada");
        const renamed = await db.skus.update({ where: { code: "ADA" }, set: { name: "Lovelace" } });
        expect(renamed).toEqual({ count: 1 });
        expect((await db.skus.find({ where: { code: "ADA" }, limit: 1 }))[0]?.name).toBe(
          "Lovelace",
        );
        await expectCode(
          db.skus.update({ where: { code: "ADA" }, set: { code: "B" } } as never),
          "OKM1190",
        );

        await db.members.insert({ userId: USER, orgId: ORG, role: "owner" });
        const members = await db.members.find({ where: { userId: USER, orgId: ORG }, limit: 1 });
        expect(members[0]?.role).toBe("owner");
        await expectCode(
          db.members.update({ where: { userId: USER }, set: { orgId: USER } } as never),
          "OKM1190",
        );

        const event = await db.events.insert({ id: EVENT, name: "open" });
        expect(event.id).toBe(EVENT);
        const events = await db.events.find({ where: { id: EVENT }, limit: 1 });
        expect(events[0]?.name).toBe("open");
        await expectCode(
          db.events.update({ where: { id: EVENT }, set: { id: USER } } as never),
          "OKM1190",
        );

        const session = await db.sessions.insert({});
        expect(session.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        const sessions = await db.sessions.find({ where: { id: session.id }, limit: 1 });
        expect(sessions).toHaveLength(1);
        await expectCode(db.sessions.insert({ id: EVENT } as never), "OKM1190");
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
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}
