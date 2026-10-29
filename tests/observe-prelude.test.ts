/**
 * `onQuery` on a `with()` client: one event per call.
 *
 * The `set_config` prelude, BEGIN, COMMIT, and RESET ALL are library
 * statements. They are part of the call and are not their own events.
 * Setting values and the tenant id stay out of the event, its params, and
 * the OTel span.
 */

import { expect, test } from "bun:test";

import { open } from "../src/adapters/pg/pglite.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { queryObserver, toOtel } from "../src/runtime/observe.js";
import type { QueryEvent } from "../src/runtime/observe-types.js";
import { sessionSettings } from "../src/runtime/session/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { connect } from "../src/runtime/pg/pglite.js";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";

const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });
const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});
const session = sessionSettings({
  userId: { name: "app.user_id", type: "uuid", required: true },
});

test("a with() client reports one query event per call and not the prelude", async () => {
  const pool = await open();
  await pool.execute(
    "create table notes (id int primary key, title text not null, tenant_id uuid not null)",
  );
  const events: QueryEvent[] = [];
  const onQuery = queryObserver({
    params: true,
    query: (event) => {
      events.push(event);
    },
  });
  const db = await connect(pool, { schema: app, session, onQuery });
  try {
    const scoped = db.for({ tenantId: TENANT }).with({ userId: USER });
    await scoped.notes.insert({ id: 1, title: "hello" });
    await scoped.notes.find({ where: { id: 1 }, limit: 1 });
    await onQuery.flush();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.op)).toEqual(["insert", "find"]);
    const dumped = JSON.stringify({
      events,
      spans: events.map((event) => toOtel(event, { statement: true })),
    });
    expect(dumped).not.toContain("set_config");
    expect(dumped.toLowerCase()).not.toContain("begin");
    expect(dumped.toLowerCase()).not.toContain("commit");
    expect(dumped).not.toContain("RESET ALL");
    expect(dumped).not.toContain(USER);
    expect(dumped).not.toContain(TENANT);
  } finally {
    await db.close();
  }
});
