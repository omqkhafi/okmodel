/**
 * WriteEvent.settings names the settings of a with() client and never their values.
 *
 * A client with no with() keeps []. Autocommit, tx(), typed raw(), archive,
 * restore, and two settings all report the names.
 */

import { afterEach, expect, test } from "bun:test";

import { open } from "../src/adapters/pg/pglite.js";
import { raw, registerRawLock, schema, t, table } from "../src/dialects/pg/index.js";
import { rawStatementKey } from "../src/dialects/pg/raw-key.js";
import { writeObserver } from "../src/runtime/observe.js";
import type { ObserveEvent, WriteEvent } from "../src/runtime/observe-types.js";
import { connect } from "../src/runtime/pg/pglite.js";
import { sessionSettings } from "../src/runtime/session/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";

const USER = "11111111-1111-4111-8111-111111111111";
const ROLE = "role-secret-9c2e";
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const notes = table(
  "notes",
  { id: t.integer().primaryKey(), title: t.text() },
  { traits: [archivable()] },
);
const docs = table("docs", { id: t.integer().primaryKey(), title: t.text() });

const plain = schema({ casing: "snake", tables: [notes] });
const tenant = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [docs],
});
const one = sessionSettings({
  userId: { name: "app.user_id", type: "uuid", required: true },
});
const two = sessionSettings({
  role: { name: "app.role", type: "text", required: true },
  userId: { name: "app.user_id", type: "uuid", required: true },
});
const optional = sessionSettings({
  userId: { name: "app.user_id", type: "uuid" },
});

const RAW = "insert into notes (id, title) values ($1, $2)";

afterEach(() => {
  registerRawLock(undefined);
});

function collect(): {
  readonly events: ObserveEvent[];
  readonly onWrite: ReturnType<typeof writeObserver>;
} {
  const events: ObserveEvent[] = [];
  const onWrite = writeObserver({
    onEvent(event) {
      events.push(event);
    },
  });
  return { events, onWrite };
}

function writes(events: readonly ObserveEvent[]): WriteEvent[] {
  return events.filter((event): event is WriteEvent => event.type === "write");
}

test("with() fills setting names on autocommit, tx, raw, archive, and restore", async () => {
  registerRawLock({
    version: 1,
    dialect: "postgres",
    catalogHash: "h",
    statements: {
      [rawStatementKey(RAW)]: {
        sql: RAW,
        kind: "write",
        params: [{ pgType: "integer" }, { pgType: "text" }],
        columns: [],
      },
    },
  });
  const pool = await open();
  await pool.execute(
    "create table notes (id int primary key, title text not null, archived_at timestamptz, archive_id uuid)",
  );
  await pool.execute(
    "create table docs (id int primary key, title text not null, tenant_id uuid not null)",
  );
  const seen = collect();
  const db = await connect(pool, { schema: plain, session: two, onWrite: seen.onWrite });
  const scoped = await connect(pool, { schema: tenant, session: one, onWrite: seen.onWrite });
  const bare = await connect(pool, { schema: plain, session: optional, onWrite: seen.onWrite });
  try {
    const me = db.with({ userId: USER, role: ROLE });
    await me.notes.insert({ id: 1, title: "auto" });
    await me.tx(async (tx) => {
      await tx.notes.insert({ id: 2, title: "inside" });
    });
    const run = raw as unknown as (db: object, sql: string, params: unknown) => Promise<unknown>;
    await run(me, RAW, [3, "raw"]);
    const archived = await me.notes.archive({ where: { id: 1 } });
    await me.notes.restore({ archiveId: archived.archiveId });
    await scoped
      .for({ tenantId: TENANT })
      .with({ userId: USER })
      .docs.insert({ id: 1, title: "tenant" });
    await bare.notes.insert({ id: 4, title: "none" });
    await seen.onWrite.flush();

    const found = writes(seen.events);
    expect(found.map((event) => event.op)).toEqual([
      "insert",
      "insert",
      "raw",
      "archive",
      "restore",
      "insert",
      "insert",
    ]);
    expect(found[0]?.settings).toEqual(["app.role", "app.user_id"]);
    expect(found[1]?.settings).toEqual(["app.role", "app.user_id"]);
    expect(found[2]?.settings).toEqual(["app.role", "app.user_id"]);
    expect(found[3]?.settings).toEqual(["app.role", "app.user_id"]);
    expect(found[4]?.settings).toEqual(["app.role", "app.user_id"]);
    expect(found[5]?.settings).toEqual(["app.user_id"]);
    expect(found[6]?.settings).toEqual([]);
    const dumped = JSON.stringify(seen.events);
    expect(dumped).not.toContain(USER);
    expect(dumped).not.toContain(ROLE);
  } finally {
    await db.close();
    await scoped.close();
    await bare.close();
  }
});
