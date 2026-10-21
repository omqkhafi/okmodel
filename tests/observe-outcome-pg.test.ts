/**
 * Unit outcomes when the connection dies (G-8): a cut before COMMIT, a cut
 * while COMMIT runs, and a COMMIT whose answer is lost.
 *
 * A cut before COMMIT is a rollback. Once COMMIT is on the wire the library
 * cannot know the result, so the outcome is `unknown` and the database is the
 * only witness: the tests read it afterwards to show both answers exist.
 * PGlite has one exclusive in-process connection, so there is no connection to
 * cut and it is skipped.
 */

import { afterAll, expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { startCutProxy } from "../packages/harness/src/proxy.js";
import {
  openRig,
  outcomesOf,
  rejection,
  runnable,
  writesOf,
  type DriverName,
  type Rig,
} from "./observe-conformance-kit.js";
import { watch } from "./observe-conformance-watch.js";

const notes = table("notes", { id: t.integer().primaryKey(), body: t.text() });
const held = table("held", { id: t.integer().primaryKey(), body: t.text() });
const app = schema({ casing: "snake", tables: [notes, held] });

const DDL = `
create table notes (id int primary key, body text not null);
create table held (id int primary key, body text not null);
create function okm_hold() returns trigger language plpgsql as $$ begin perform pg_sleep(8); return new; end $$;
create constraint trigger okm_hold after insert on held deferrable initially deferred for each row execute function okm_hold();
`;

const gate = await loadPostgresGate();
const rigs = new Map<DriverName, Promise<Rig>>();

afterAll(async () => {
  for (const pending of rigs.values()) await (await pending).close();
});

const DRIVERS = ["postgresjs", "pg", "bun", "pglite"] as const;

function each(name: string, body: (rig: Rig) => Promise<void>): void {
  for (const driver of DRIVERS) {
    const title = `${driver}: ${name}`;
    if (driver === "pglite") {
      test.skip(`${title} (one exclusive connection: nothing to cut)`, () => {});
      continue;
    }
    if (!runnable(driver)) {
      test.skip(title, () => {});
      continue;
    }
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
        await rig.exec("truncate notes, held");
        await body(rig);
      },
      60_000,
    );
  }
}

/** The pid of the client's backend that matches, polled until it shows. */
async function backend(rig: Rig, where: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await rig.rows(
      `select pid::text as pid from pg_stat_activity
       where application_name = 'okmodel' and datname = current_database()
         and pid <> pg_backend_pid() and ${where}`,
    );
    const pid = rows[0]?.pid;
    if (typeof pid === "string") return pid;
    await Bun.sleep(50);
  }
  throw new Error(`no okmodel backend matched ${where}`);
}

async function terminate(rig: Rig, pid: string): Promise<void> {
  await rig.rows(`select pg_terminate_backend(${pid})`);
}

async function count(rig: Rig, from: string): Promise<number> {
  return (await rig.rows(`select id from ${from}`)).length;
}

each("a cut before COMMIT is a rollback and never unknown", async (rig) => {
  const seen = watch();
  const db = await rig.connect({
    schema: app,
    max: 2,
    onWrite: seen.onWrite,
    onQuery: seen.onQuery,
  });
  try {
    const failure = await rejection(
      db.tx(async (tx) => {
        await tx.notes.insert({ id: 1, body: "never committed" });
        await terminate(rig, await backend(rig, "state = 'idle in transaction'"));
        await tx.notes.insert({ id: 2, body: "after the cut" });
      }),
    );
    expect(failure).toBeInstanceOf(OkmError);
    expect((failure as OkmError).kind).not.toBe("outcome_unknown");
    expect((failure as OkmError).code).not.toBe("OKM1401");
    await seen.flush();

    expect(outcomesOf(seen.events).map((event) => event.outcome)).toEqual(["rolled_back"]);
    expect(seen.unknown).toEqual([]);
    expect(seen.committed).toEqual([]);
    expect(seen.rolledBack).toHaveLength(1);
    expect(await count(rig, "notes")).toBe(0);
    expect(seen.queries.some((event) => event.error !== undefined)).toBe(true);
  } finally {
    await db.close();
  }
});

each(
  "a backend killed while COMMIT runs is unknown, and the database says rolled back",
  async (rig) => {
    const seen = watch();
    const db = await rig.connect({
      schema: app,
      max: 2,
      onWrite: seen.onWrite,
      onQuery: seen.onQuery,
    });
    try {
      const killer = (async () => {
        await terminate(rig, await backend(rig, "state = 'active' and query ilike 'commit%'"));
      })();
      const failure = await rejection(
        db.tx(async (tx) => {
          await tx.held.insert({ id: 1, body: "commit is in flight" });
        }),
      );
      await killer;
      expect(failure).toBeInstanceOf(OkmError);
      expect((failure as OkmError).code).toBe("OKM1401");
      expect((failure as OkmError).kind).toBe("outcome_unknown");
      await seen.flush();

      const outcomes = outcomesOf(seen.events);
      expect(outcomes.map((event) => event.outcome)).toEqual(["unknown"]);
      expect(outcomes[0]?.writes).toBe(1);
      expect(seen.unknown).toHaveLength(1);
      expect(seen.unknown[0]?.unit).toBe(outcomes[0]?.unit as string);
      expect(seen.committed).toEqual([]);
      expect(seen.rolledBack).toEqual([]);
      const written = writesOf(seen.events);
      expect(written).toHaveLength(1);
      expect(written[0]?.table).toBe("held");

      expect(await count(rig, "held")).toBe(0);
    } finally {
      await db.close();
    }
  },
);

each("a COMMIT whose answer is lost is unknown, and the database says committed", async (rig) => {
  const proxy = await startCutProxy(rig.url as string);
  const seen = watch();
  const db = await rig.connect({
    schema: app,
    max: 2,
    connectionUrl: proxy.url,
    onWrite: seen.onWrite,
    onQuery: seen.onQuery,
  });
  try {
    await db.notes.find({ limit: 1 });
    const failure = await rejection(
      db.tx(async (tx) => {
        await tx.notes.insert({ id: 1, body: "lands, then the answer is lost" });
        await tx.notes.insert({ id: 2, body: "lands too" });
        proxy.cutNextCommit();
      }),
    );
    expect(failure).toBeInstanceOf(OkmError);
    expect((failure as OkmError).code).toBe("OKM1401");
    expect((failure as OkmError).kind).toBe("outcome_unknown");
    await seen.flush();

    const outcomes = outcomesOf(seen.events);
    expect(outcomes.map((event) => event.outcome)).toEqual(["unknown"]);
    expect(outcomes[0]?.writes).toBe(2);
    expect(seen.unknown).toHaveLength(1);
    expect(seen.unknown[0]?.writes).toHaveLength(2);
    expect(seen.committed).toEqual([]);
    expect(seen.rolledBack).toEqual([]);
    expect(writesOf(seen.events).map((event) => event.seq)).toEqual([0, 1]);

    expect(await count(rig, "notes")).toBe(2);
  } finally {
    await db.close();
    await proxy.close();
  }
});

each("an unknown outcome is delivered once and later units are unaffected", async (rig) => {
  const proxy = await startCutProxy(rig.url as string);
  const seen = watch();
  const db = await rig.connect({
    schema: app,
    max: 2,
    connectionUrl: proxy.url,
    onWrite: seen.onWrite,
  });
  try {
    await db.notes.find({ limit: 1 });
    await rejection(
      db.tx(async (tx) => {
        await tx.notes.insert({ id: 1, body: "unknown" });
        proxy.cutNextCommit();
      }),
    );
    await db.tx(async (tx) => {
      await tx.notes.insert({ id: 2, body: "next unit" });
    });
    await seen.flush();

    expect(outcomesOf(seen.events).map((event) => event.outcome)).toEqual(["unknown", "committed"]);
    expect(seen.unknown).toHaveLength(1);
    expect(seen.committed).toHaveLength(1);
    expect(new Set(outcomesOf(seen.events).map((event) => event.unit)).size).toBe(2);
    expect(await count(rig, "notes")).toBe(2);
  } finally {
    await db.close();
    await proxy.close();
  }
});
