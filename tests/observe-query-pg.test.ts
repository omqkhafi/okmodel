/**
 * Query observer conformance on a real database (G-8): the timing split on a
 * slow statement, the plan fingerprint, row count modes, the route a read
 * took, and the unit a read shares inside a transaction.
 *
 * Every case runs on postgres.js, node-postgres, Bun.sql, and PGlite. Replica
 * routing needs a streaming replica, so those cases run on the three Postgres
 * drivers against the Docker topology.
 */

import { afterAll, expect, test } from "bun:test";

import { schema, t, table } from "../src/dialects/pg/index.js";
import { toOtel } from "../src/runtime/observe.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import type { Connected } from "../src/runtime/types.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { readInsertLsn, waitForReplayLsn } from "../packages/harness/src/replication.js";
import { primaryUrl, replicaUrl } from "../packages/harness/src/topology.js";
import {
  DRIVERS,
  openRig,
  outcomesOf,
  runnable,
  writesOf,
  type DriverName,
  type Rig,
} from "./observe-conformance-kit.js";
import { watch } from "./observe-conformance-watch.js";

const notes = table("notes", { id: t.integer().primaryKey(), body: t.text() });
const slow = table("slow", { id: t.integer().primaryKey(), body: t.text() });
const naps = table("naps", { id: t.integer().primaryKey(), body: t.text() });
const app = schema({ casing: "snake", tables: [notes, slow, naps] });

const NAP_MS = 250;

const DDL = `
create table notes (id int primary key, body text not null);
create table slow (id int primary key, body text not null);
create function okm_nap() returns trigger language plpgsql as $$ begin perform pg_sleep(0.25); return new; end $$;
create trigger okm_nap before insert on slow for each row execute function okm_nap();
create view naps as select 1 as id, pg_sleep(0.25)::text as body;
`;

const gate = await loadPostgresGate();
const rigs = new Map<DriverName, Promise<Rig>>();

afterAll(async () => {
  for (const pending of rigs.values()) await (await pending).close();
});

function each(name: string, body: (rig: Rig) => Promise<void>): void {
  for (const driver of DRIVERS) {
    const title = `${driver}: ${name}`;
    if (!runnable(driver)) {
      test.skip(title, () => {});
      continue;
    }
    const run = async (): Promise<void> => {
      let pending = rigs.get(driver);
      if (pending === undefined) {
        pending = openRig(driver, DDL);
        rigs.set(driver, pending);
      }
      const rig = await pending;
      await rig.exec("truncate notes, slow");
      await body(rig);
    };
    if (driver === "pglite") test(title, run, { timeout: 30_000 });
    else postgresTest(gate, title, run, 30_000);
  }
}

each("the timing split is present and sane on a slow read and a slow write", async (rig) => {
  const seen = watch();
  const db = await rig.connect({
    schema: app,
    max: 2,
    onWrite: seen.onWrite,
    onQuery: seen.onQuery,
  });
  try {
    await db.notes.find({ limit: 5 });
    await db.naps.find({ limit: 5 });
    await db.slow.insert({ id: 1, body: "after a nap" });
    await seen.flush();

    const [fast, read, write] = seen.queries;
    expect(seen.queries).toHaveLength(3);
    for (const event of seen.queries) {
      expect(event.queueMs).toBeNull();
      expect(Number.isFinite(event.queryMs)).toBe(true);
      expect(event.queryMs).toBeGreaterThanOrEqual(0);
      expect(event.decodeMs).not.toBeNull();
      expect(event.decodeMs as number).toBeGreaterThanOrEqual(0);
      expect(event.durationMs).toBe(event.queryMs + (event.decodeMs as number));
    }
    expect(fast?.queryMs as number).toBeLessThan(NAP_MS - 50);
    for (const event of [read, write]) {
      expect(event?.queryMs as number).toBeGreaterThanOrEqual(NAP_MS - 25);
      expect(event?.queryMs as number).toBeLessThan(10_000);
      expect(event?.decodeMs as number).toBeLessThan(event?.queryMs as number);
    }
    expect(writesOf(seen.events)[0]?.durationMs).toBeGreaterThanOrEqual(NAP_MS - 25);
    expect(outcomesOf(seen.events).map((event) => event.outcome)).toEqual(["committed"]);
  } finally {
    await db.close();
  }
});

each("the plan fingerprint is stable for a shape and differs for another", async (rig) => {
  const seen = watch();
  const db = await rig.connect({ schema: app, max: 2, onQuery: seen.onQuery });
  try {
    const inspected = await db.notes.find({ where: { id: 1 }, limit: 5 }).inspect();
    await db.notes.find({ where: { id: 1 }, limit: 5 });
    await db.notes.find({ where: { id: 2 }, limit: 5 });
    await db.notes.find({ where: { id: 3 }, limit: 5 });
    await db.notes.find({ where: { body: "other shape" }, limit: 5 });
    await db.notes.find({ limit: 5 });
    await db.notes.insert({ id: 1, body: "write shape" });
    await db.notes.insert({ id: 2, body: "write shape" });
    await db.notes.delete({ where: { id: 1 } });
    await seen.flush();

    const prints = seen.queries.map((event) => event.fingerprint);
    expect(prints[0]).toBe(inspected.plan.fingerprint);
    expect(prints[1]).toBe(prints[0]);
    expect(prints[2]).toBe(prints[0]);
    expect(new Set(prints.slice(0, 3)).size).toBe(1);
    expect(prints[3]).not.toBe(prints[0]);
    expect(prints[4]).not.toBe(prints[0]);
    expect(prints[4]).not.toBe(prints[3]);
    expect(prints[5]).toBe(prints[6]);
    expect(prints[5]).not.toBe(prints[0]);
    expect(prints[7]).not.toBe(prints[5]);
    for (const print of prints) expect(print).toMatch(/^Q_[0-9a-f]{16}$/);
    const spans = seen.queries.map((event) => toOtel(event).attributes["db.query.summary"]);
    expect(spans).toEqual(prints);
  } finally {
    await db.close();
  }
});

each("the row count mode follows the command tag on every driver", async (rig) => {
  const seen = watch();
  const keyed = watch({ keys: ["notes"] });
  const db = await rig.connect({
    schema: app,
    max: 2,
    onWrite: seen.onWrite,
    onQuery: seen.onQuery,
  });
  const withKeys = await rig.connect({
    schema: app,
    max: 2,
    onWrite: keyed.onWrite,
    onQuery: keyed.onQuery,
  });
  try {
    await db.notes.insert({ id: 1, body: "grp" });
    await db.notes.insert({ id: 2, body: "grp" });
    await db.notes.insert({ id: 3, body: "grp" });
    await db.notes.update({ where: { body: "grp" }, set: { body: "same" } });
    await db.notes.update({ where: { id: 99 }, set: { body: "none" } });
    await db.notes.insert({ id: 1, body: "dup" }, { onConflict: "ignore" });
    await db.notes.insert(
      { id: 2, body: "upsert" },
      { onConflict: { on: "id", update: ["body"] } },
    );
    await db.notes.find({ limit: 10 });
    await db.notes.delete({ where: { id: 3 } });
    await withKeys.notes.delete({ where: { id: 2 } });
    await withKeys.notes.delete({ where: { id: 77 } });
    await seen.flush();
    await keyed.flush();

    const summary = (watched: typeof seen): string[] =>
      watched.queries.map((event) => `${event.op}:${event.rowCountMode}:${String(event.rowCount)}`);
    expect(summary(seen)).toEqual([
      "insert:returned:1",
      "insert:returned:1",
      "insert:returned:1",
      "update:changed:3",
      "update:changed:0",
      "upsert:changed:0",
      "upsert:changed:1",
      "find:returned:3",
      "delete:changed:1",
    ]);
    const modes = (watched: typeof seen): string[] =>
      writesOf(watched.events).map(
        (event) => `${event.op}:${event.rowCountMode}:${String(event.rowCount)}`,
      );
    expect(modes(seen)).toEqual([
      "insert:returned:1",
      "insert:returned:1",
      "insert:returned:1",
      "update:changed:3",
      "update:changed:0",
      "upsert:changed:0",
      "upsert:changed:1",
      "delete:changed:1",
    ]);
    expect(summary(keyed)).toEqual(["delete:returned:1", "delete:returned:0"]);
    expect(modes(keyed)).toEqual(["delete:returned:1", "delete:returned:0"]);
    expect(writesOf(keyed.events).map((event) => event.keys)).toEqual([[{ id: 2 }], []]);
  } finally {
    await db.close();
    await withKeys.close();
  }
});

each(
  "reads inside a transaction share the unit of its writes, savepoints included",
  async (rig) => {
    const both = watch();
    const readsOnly = watch();
    const db = await rig.connect({
      schema: app,
      max: 2,
      onWrite: both.onWrite,
      onQuery: both.onQuery,
    });
    const quiet = await rig.connect({ schema: app, max: 2, onQuery: readsOnly.onQuery });
    try {
      for (const client of [db, quiet]) {
        await client.notes.find({ limit: 1 });
        await client.tx(async (tx) => {
          await tx.notes.find({ limit: 1 });
          await tx.notes.insert({ id: 1, body: "in the unit" });
          await tx.tx(async (inner) => {
            await inner.notes.find({ limit: 1 });
            await inner.tx(async (deeper) => {
              await deeper.notes.find({ limit: 1 });
            });
          });
          await tx.notes.find({ limit: 1 });
        });
        await client.tx(async (tx) => {
          await tx.notes.find({ limit: 1 });
        });
        await client.notes.delete({ where: { id: 1 } });
      }
      await both.flush();
      await readsOnly.flush();

      for (const seen of [both, readsOnly]) {
        const [before, ...rest] = seen.queries;
        expect(before?.unit).toBeUndefined();
        expect(before?.seq).toBeUndefined();
        const first = rest.slice(0, 5);
        expect(new Set(first.map((event) => event.unit)).size).toBe(1);
        expect(first.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);
        const second = rest[5];
        expect(second?.unit).toBeDefined();
        expect(second?.unit).not.toBe(first[0]?.unit);
        expect(second?.seq).toBe(0);
      }
      const writeUnit = writesOf(both.events)[0]?.unit;
      expect(both.queries.slice(1, 6).every((event) => event.unit === writeUnit)).toBe(true);
      expect(both.queries[7]?.unit).toBe(writesOf(both.events)[1]?.unit);
      expect(both.queries[7]?.unit).not.toBe(writeUnit);
    } finally {
      await db.close();
      await quiet.close();
    }
  },
);

const REPLICA_DRIVERS = ["postgresjs", "pg", "bun"] as const;
const connectors = {
  postgresjs: connectPostgres,
  pg: connectPg,
  bun: connectBun,
} as const;

const where = table("where_am_i", { id: t.integer().primaryKey(), replica: t.boolean() });
const placement = schema({ casing: "snake", tables: [where] });

for (const driver of REPLICA_DRIVERS) {
  const title = `${driver}: a read the router sent to a replica is labelled replica`;
  if (!runnable(driver)) {
    test.skip(title, () => {});
    continue;
  }
  postgresTest(
    gate,
    title,
    async () => {
      await withPostgresSchema(async (sql, name) => {
        await sql.unsafe(
          "create view where_am_i as select 1 as id, pg_is_in_recovery() as replica",
        );
        await sql.unsafe("create table audit (id int primary key)");
        await waitForReplayLsn("a", await readInsertLsn(sql));
        const seen = watch();
        const open = connectors[driver] as unknown as (
          target: unknown,
          options: unknown,
        ) => Promise<Connected<typeof placement, undefined> & { using(route: string): never }>;
        const db = await open(
          { primary: primaryUrl(), replicas: [{ url: replicaUrl("a"), name: "east" }] },
          {
            schema: placement,
            searchPath: name,
            max: 2,
            onWrite: seen.onWrite,
            onQuery: seen.onQuery,
          },
        );
        const replicaClient = db.using("replica") as typeof db;
        const primaryClient = db.using("primary") as typeof db;
        try {
          await db.connected;
          const automatic = await db.where_am_i.find({ limit: 5 });
          const forced = await replicaClient.where_am_i.find({ limit: 5 });
          const pinned = await primaryClient.where_am_i.find({ limit: 5 });
          const inside = await db.tx(async (tx) => tx.where_am_i.find({ limit: 5 }));
          await seen.flush();

          expect(automatic[0]?.replica).toBe(true);
          expect(forced[0]?.replica).toBe(true);
          expect(pinned[0]?.replica).toBe(false);
          expect(inside[0]?.replica).toBe(false);
          expect(seen.queries.map((event) => event.route)).toEqual([
            { endpoint: "east", role: "replica" },
            { endpoint: "east", role: "replica" },
            { endpoint: "primary", role: "primary" },
            { endpoint: "primary", role: "primary" },
          ]);
          expect(seen.queries[3]?.unit).toBeDefined();
          expect(seen.queries[0]?.unit).toBeUndefined();
        } finally {
          await db.close();
        }
      });
    },
    60_000,
  );
}

test.skip("pglite: a replica route has no endpoint to reach (PGlite has no streaming replica)", () => {});
