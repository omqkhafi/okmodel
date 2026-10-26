/**
 * N-152: `onQuery` with `params: true` redacts tenant ids on every path.
 *
 * A tenant-scoped insert, find, `db.batch`, `tx.batch`, and a page that
 * follows a cursor keep the tenant id out of the event. postgres.js, pg,
 * and Bun.sql each run the same calls.
 */

import { afterAll, expect } from "bun:test";

import { schema, t, table } from "../src/dialects/pg/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  DRIVERS,
  openRig,
  runnable,
  type DriverName,
  type Rig,
} from "./observe-conformance-kit.js";
import { watch } from "./observe-conformance-watch.js";

const docs = table("docs", { id: t.integer().primaryKey(), title: t.text() });
const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [docs],
});

const DDL = `
create table docs (id int primary key, title text not null, tenant_id uuid not null);
`;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const gate = await loadPostgresGate();
const rigs = new Map<DriverName, Promise<Rig>>();

afterAll(async () => {
  for (const pending of rigs.values()) await (await pending).close();
});

for (const driver of DRIVERS) {
  if (driver === "pglite") continue;
  const title = `${driver}: onQuery redacts a tenant id on insert, find, batch, and page`;
  if (!runnable(driver)) continue;
  postgresTest(
    gate,
    title,
    async () => {
      let pending = rigs.get(driver);
      if (pending === undefined) {
        pending = openRig(driver, DDL);
        rigs.set(driver, pending);
      }
      const rig = await pending;
      await rig.exec("truncate docs");
      const seen = watch({ params: true });
      const db = await rig.connect({ schema: app, onQuery: seen.onQuery });
      try {
        const scoped = db.for({ tenantId: TENANT });
        await scoped.docs.insert({ id: 1, title: "one" });
        await scoped.docs.insert({ id: 2, title: "two" });
        await scoped.docs.find({ where: { id: 1 }, limit: 1 });
        await scoped.batch([
          scoped.docs.insert({ id: 3, title: "three" }),
          scoped.docs.insert({ id: 4, title: "four" }),
        ]);
        await scoped.tx(async (tx) => {
          await tx.batch([tx.docs.insert({ id: 5, title: "five" })]);
        });
        const first = await scoped.docs.page({ orderBy: { id: "asc" }, limit: 1 });
        expect(first.next).not.toBeNull();
        await scoped.docs.page({ orderBy: { id: "asc" }, limit: 1, after: first.next });
        await seen.flush();
        const params = JSON.stringify(seen.queries.map((query) => query.params));
        expect(params).toContain("[redacted]");
        expect(params).not.toContain(TENANT);
        expect(params).toContain("one");
        expect(seen.queries.length).toBeGreaterThan(0);
      } finally {
        await db.close();
      }
    },
    60_000,
  );
}
