/**
 * Write observer conformance on a real database (G-8): rollback, savepoints,
 * delivery, concurrent units, isolation between clients, and no leaks.
 *
 * Every case runs on postgres.js, node-postgres, Bun.sql, and PGlite. The
 * Postgres drivers share the Docker topology. No pool is faked.
 */

import { afterAll, expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { queryObserver, toOtel, writeObserver } from "../src/runtime/observe.js";
import type { OutcomeEvent, SavepointEvent } from "../src/runtime/observe-types.js";
import { sessionSettings } from "../src/runtime/session/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  DRIVERS,
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
const vault = table("vault", {
  id: t.integer().primaryKey(),
  label: t.text(),
  secret: t.text().sensitive().hidden(),
});
const docs = table("docs", { id: t.integer().primaryKey(), title: t.text() });

const plain = schema({ casing: "snake", tables: [notes, vault] });
const tenant = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [docs],
});
const session = sessionSettings({
  userId: { name: "app.user_id", type: "uuid", required: true },
});

const DDL = `
create table notes (id int primary key, body text not null);
create table vault (id int primary key, label text not null, secret text not null);
create table docs (id int primary key, title text not null, tenant_id uuid not null);
`;

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_1 = "11111111-1111-4111-8111-111111111111";
const USER_2 = "22222222-2222-4222-8222-222222222222";
const USER_3 = "33333333-3333-4333-8333-333333333333";

const gate = await loadPostgresGate();
const rigs = new Map<DriverName, Promise<Rig>>();

afterAll(async () => {
  for (const pending of rigs.values()) await (await pending).close();
});

/** Registers one case on every adapter, on a rig with empty tables. */
function each(
  name: string,
  body: (rig: Rig) => Promise<void>,
  options: { readonly timeoutMs?: number; readonly overlap?: true } = {},
): void {
  const timeoutMs = options.timeoutMs ?? 30_000;
  for (const driver of DRIVERS) {
    const title = `${driver}: ${name}`;
    if (!runnable(driver)) {
      test.skip(title, () => {});
      continue;
    }
    if (driver === "pglite" && options.overlap === true) {
      // PGlite has one exclusive connection: a second unit cannot start while the first holds it.
      test.skip(`${title} (needs two connections)`, () => {});
      continue;
    }
    const run = async (): Promise<void> => {
      let pending = rigs.get(driver);
      if (pending === undefined) {
        pending = openRig(driver, DDL);
        rigs.set(driver, pending);
      }
      const rig = await pending;
      await rig.exec("truncate notes, vault, docs");
      await body(rig);
    };
    if (driver === "pglite") test(title, run, { timeout: timeoutMs });
    else postgresTest(gate, title, run, timeoutMs);
  }
}

async function ids(rig: Rig, from = "notes"): Promise<number[]> {
  return (await rig.rows(`select id from ${from} order by id`)).map((row) => Number(row.id));
}

function savepoints(events: readonly { readonly type: string }[]): SavepointEvent[] {
  return events.filter((event): event is SavepointEvent => event.type === "savepoint");
}

each("a rolled-back unit reports one rolled_back outcome and no committed one", async (rig) => {
  const seen = watch();
  const db = await rig.connect({
    schema: plain,
    max: 2,
    onWrite: seen.onWrite,
    onQuery: seen.onQuery,
  });
  try {
    const failure = await rejection(
      db.tx(async (tx) => {
        await tx.notes.insert({ id: 1, body: "gone" });
        await tx.notes.insert({ id: 2, body: "gone too" });
        await tx.notes.find({ limit: 5 });
        throw new Error("rollback please");
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    await seen.flush();

    const outcomes = outcomesOf(seen.events);
    expect(outcomes.map((event) => event.outcome)).toEqual(["rolled_back"]);
    expect(seen.committed).toEqual([]);
    expect(seen.unknown).toEqual([]);
    expect(seen.rolledBack).toEqual([{ unit: outcomes[0]?.unit as string }]);
    expect(await ids(rig)).toEqual([]);

    expect(seen.queries.map((event) => event.summary)).toEqual([
      "INSERT notes",
      "INSERT notes",
      "SELECT notes",
    ]);
    expect(new Set(seen.queries.map((event) => event.unit))).toEqual(new Set([outcomes[0]?.unit]));
    expect(seen.queries.map((event) => event.rowCountMode)).toEqual([
      "returned",
      "returned",
      "returned",
    ]);
  } finally {
    await db.close();
  }
});

each("a statement that fails ends the unit as rolled_back and leaves no row", async (rig) => {
  const seen = watch();
  const db = await rig.connect({
    schema: plain,
    max: 2,
    onWrite: seen.onWrite,
    onQuery: seen.onQuery,
  });
  try {
    await db.notes.insert({ id: 9, body: "existing" });
    seen.events.length = 0;
    seen.queries.length = 0;
    seen.committed.length = 0;

    const failure = await rejection(
      db.tx(async (tx) => {
        await tx.notes.insert({ id: 1, body: "lost with the unit" });
        await tx.notes.insert({ id: 9, body: "duplicate key" });
      }),
    );
    expect(failure).toBeInstanceOf(OkmError);
    const batched = await rejection(
      db.batch([
        db.notes.insert({ id: 2, body: "lost with the batch" }),
        db.notes.insert({ id: 9, body: "duplicate key" }),
      ]),
    );
    expect(batched).toBeInstanceOf(OkmError);
    await seen.flush();

    expect(outcomesOf(seen.events).map((event) => event.outcome)).toEqual([
      "rolled_back",
      "rolled_back",
    ]);
    expect(seen.committed).toEqual([]);
    expect(seen.rolledBack).toHaveLength(2);
    expect(await ids(rig)).toEqual([9]);
    const failed = seen.queries.filter((event) => event.error !== undefined);
    expect(failed.length).toBeGreaterThan(0);
    for (const event of failed) expect(event.error?.sqlstate).toBe("23505");
  } finally {
    await db.close();
  }
});

for (const keyed of [false, true]) {
  each(
    `a nested savepoint that rolls back removes only its writes (keys ${keyed ? "on" : "off"})`,
    async (rig) => {
      const seen = watch(keyed ? { keys: ["notes"] } : {});
      const db = await rig.connect({ schema: plain, max: 2, onWrite: seen.onWrite });
      try {
        await db.tx(async (tx) => {
          await tx.notes.insert({ id: 1, body: "outer" });
          await tx.tx(async (one) => {
            await one.notes.insert({ id: 2, body: "level one" });
            const inner = await rejection(
              one.tx(async (two) => {
                await two.notes.insert({ id: 3, body: "level two, rolled back" });
                throw new Error("inner failure");
              }),
            );
            expect(inner).toBeInstanceOf(Error);
            await one.notes.insert({ id: 4, body: "level one after the rollback" });
          });
          await tx.notes.insert({ id: 5, body: "outer again" });
        });
        await seen.flush();

        expect(await ids(rig)).toEqual([1, 2, 4, 5]);
        const outcomes = outcomesOf(seen.events);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]?.outcome).toBe("committed");
        expect(outcomes[0]?.writes).toBe(4);
        expect(seen.committed).toHaveLength(1);
        expect(seen.committed[0]?.writes).toHaveLength(4);
        expect(writesOf(seen.events).map((event) => event.op)).toEqual([
          "insert",
          "insert",
          "insert",
          "insert",
        ]);
        expect(writesOf(seen.events).map((event) => event.seq)).toEqual([0, 1, 3, 4]);
        if (keyed) {
          expect(writesOf(seen.events).map((event) => event.keys)).toEqual([
            [{ id: 1 }],
            [{ id: 2 }],
            [{ id: 4 }],
            [{ id: 5 }],
          ]);
        } else {
          for (const event of writesOf(seen.events)) expect(event.keys).toBeUndefined();
        }
        expect(savepoints(seen.events).map((event) => [event.depth, event.state])).toEqual([
          [2, "rolled_back"],
          [1, "released"],
        ]);
      } finally {
        await db.close();
      }
    },
  );

  each(
    `a rolled-back outer savepoint takes the released inner one with it (keys ${keyed ? "on" : "off"})`,
    async (rig) => {
      const seen = watch(keyed ? { keys: ["notes"] } : {});
      const db = await rig.connect({ schema: plain, max: 2, onWrite: seen.onWrite });
      try {
        await db.tx(async (tx) => {
          await tx.notes.insert({ id: 1, body: "kept" });
          const outer = await rejection(
            tx.tx(async (one) => {
              await one.notes.insert({ id: 2, body: "dropped with level one" });
              await one.tx(async (two) => {
                await two.notes.insert({ id: 3, body: "released, then dropped" });
              });
              throw new Error("level one fails after level two released");
            }),
          );
          expect(outer).toBeInstanceOf(Error);
        });
        await seen.flush();

        expect(await ids(rig)).toEqual([1]);
        const outcome = outcomesOf(seen.events)[0] as OutcomeEvent;
        expect(outcome.outcome).toBe("committed");
        expect(outcome.writes).toBe(1);
        expect(seen.committed[0]?.writes.map((event) => event.table)).toEqual(["notes"]);
        expect(writesOf(seen.events)).toHaveLength(1);
        if (keyed) expect(writesOf(seen.events)[0]?.keys).toEqual([{ id: 1 }]);
        expect(savepoints(seen.events).map((event) => event.state)).toEqual(["rolled_back"]);
      } finally {
        await db.close();
      }
    },
  );
}

each("a unit whose only write sat in a rolled-back savepoint calls nothing", async (rig) => {
  const seen = watch();
  const db = await rig.connect({ schema: plain, max: 2, onWrite: seen.onWrite });
  try {
    await db.tx(async (tx) => {
      await rejection(
        tx.tx(async (inner) => {
          await inner.notes.insert({ id: 1, body: "x" });
          throw new Error("inner");
        }),
      );
    });
    await seen.flush();
    expect(await ids(rig)).toEqual([]);
    expect(outcomesOf(seen.events).map((event) => [event.outcome, event.writes])).toEqual([
      ["committed", 0],
    ]);
    expect(seen.committed).toEqual([]);
    expect(seen.rolledBack).toEqual([]);
  } finally {
    await db.close();
  }
});

each("events of one unit arrive in seq order and the outcome comes last", async (rig) => {
  const seen = watch();
  const db = await rig.connect({ schema: plain, max: 2, onWrite: seen.onWrite });
  try {
    await db.tx(async (tx) => {
      await tx.notes.insert({ id: 1, body: "a" });
      await tx.notes.update({ where: { id: 1 }, set: { body: "b" } });
      await tx.notes.delete({ where: { id: 1 } });
    });
    await db.notes.insert({ id: 2, body: "autocommit" });
    await db.batch([
      db.notes.insert({ id: 3, body: "batch one" }),
      db.notes.insert({ id: 4, body: "batch two" }),
    ]);
    await seen.flush();

    const units = new Map<string, string[]>();
    for (const event of seen.events) {
      const list = units.get(event.unit) ?? [];
      list.push(event.type === "write" ? `write:${event.seq}:${event.op}` : event.type);
      units.set(event.unit, list);
    }
    expect([...units.values()]).toEqual([
      ["write:0:insert", "write:1:update", "write:2:delete", "outcome"],
      ["write:0:insert", "outcome"],
      ["write:0:insert", "write:1:insert", "outcome"],
    ]);
    expect(seen.committed.map((entry) => entry.writes.length)).toEqual([3, 1, 2]);
    expect(seen.rolledBack).toEqual([]);
    expect(seen.unknown).toEqual([]);
    expect(await ids(rig)).toEqual([2, 3, 4]);
  } finally {
    await db.close();
  }
});

each("flush waits for a slow handler and the write path does not", async (rig) => {
  let finished = false;
  let handled = 0;
  const onWrite = writeObserver({
    committed: async () => {
      await Bun.sleep(200);
      finished = true;
      handled += 1;
    },
  });
  const db = await rig.connect({ schema: plain, max: 2, onWrite });
  try {
    await db.tx(async (tx) => {
      await tx.notes.insert({ id: 1, body: "slow observer" });
    });
    expect(finished).toBe(false);
    expect(await ids(rig)).toEqual([1]);
    await onWrite.flush();
    expect(finished).toBe(true);
    expect(handled).toBe(1);
  } finally {
    await db.close();
  }
});

each("a throwing and a rejecting handler never change the write result", async (rig) => {
  const failures: string[] = [];
  const onWrite = writeObserver({
    onEvent: (event) => {
      if (event.type === "write") throw new Error("event handler throws");
    },
    committed: () => Promise.reject(new Error("committed handler rejects")),
    onObserverError: (error) => void failures.push((error as Error).message),
  });
  const onQuery = queryObserver({
    query: (event) => {
      if (event.table === "notes") throw new Error("query handler throws");
    },
    onObserverError: (error) => void failures.push((error as Error).message),
  });
  const db = await rig.connect({ schema: plain, max: 2, onWrite, onQuery });
  try {
    const value = await db.tx(async (tx) => {
      const row = await tx.notes.insert({ id: 1, body: "survives its observers" });
      await tx.notes.insert({ id: 2, body: "and again" });
      return row;
    });
    expect(value).toMatchObject({ id: 1 });
    expect(await db.notes.insert({ id: 3, body: "autocommit" })).toMatchObject({ id: 3 });
    await onWrite.flush();
    await onQuery.flush();
    expect(await ids(rig)).toEqual([1, 2, 3]);
    expect(new Set(failures)).toEqual(
      new Set(["event handler throws", "committed handler rejects", "query handler throws"]),
    );
  } finally {
    await db.close();
  }
});

each(
  "overflow drops the oldest unit with OKM2200 and the writes still commit",
  async (rig) => {
    const seen = watch({ maxPending: 3 });
    const db = await rig.connect({ schema: plain, max: 2, onWrite: seen.onWrite });
    try {
      const wait = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const first = db.tx(async (tx) => {
        await tx.notes.insert({ id: 1, body: "first unit" });
        await tx.notes.insert({ id: 2, body: "first unit" });
        entered.resolve();
        await wait.promise;
      });
      await entered.promise;
      await db.tx(async (tx) => {
        await tx.notes.insert({ id: 3, body: "second unit" });
        await tx.notes.insert({ id: 4, body: "second unit" });
      });
      wait.resolve();
      await first;
      await seen.flush();

      const overflow = seen.errors.filter(
        (error): error is OkmError => error instanceof OkmError && error.code === "OKM2200",
      );
      expect(overflow).toHaveLength(1);
      expect(seen.committed.map((entry) => entry.writes.map((event) => event.table))).toEqual([
        ["notes", "notes"],
      ]);
      expect(await ids(rig)).toEqual([1, 2, 3, 4]);
    } finally {
      await db.close();
    }
  },
  { overlap: true },
);

each(
  "two concurrent units keep their own events, seq, and outcome",
  async (rig) => {
    const seen = watch({ keys: ["notes"] });
    const db = await rig.connect({ schema: plain, max: 4, onWrite: seen.onWrite });
    try {
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const committing = db.tx(async (tx) => {
        await tx.notes.insert({ id: 10, body: "a" });
        entered.resolve();
        await gate.promise;
        await tx.notes.insert({ id: 11, body: "a" });
      });
      await entered.promise;
      const rollingBack = db
        .tx(async (tx) => {
          await tx.notes.insert({ id: 20, body: "b" });
          await tx.notes.insert({ id: 21, body: "b" });
          gate.resolve();
          await Bun.sleep(50);
          throw new Error("b rolls back");
        })
        .catch(() => undefined);
      await Promise.all([committing, rollingBack]);
      await seen.flush();

      const byUnit = unitsOf(seen.events);
      expect(byUnit).toHaveLength(2);
      const shapes = byUnit.map((list) => ({
        keys: writesOf(list).flatMap((event) => event.keys?.map((key) => key.id) ?? []),
        seqs: writesOf(list).map((event) => event.seq),
        outcome: outcomesOf(list).map((event) => [event.outcome, event.writes]),
        last: list.at(-1)?.type,
      }));
      shapes.sort((a, b) => (a.keys[0] as number) - (b.keys[0] as number));
      expect(shapes).toEqual([
        { keys: [10, 11], seqs: [0, 1], outcome: [["committed", 2]], last: "outcome" },
        { keys: [20, 21], seqs: [0, 1], outcome: [["rolled_back", 2]], last: "outcome" },
      ]);
      expect(seen.committed).toHaveLength(1);
      expect(seen.rolledBack).toHaveLength(1);
      expect(await ids(rig)).toEqual([10, 11]);
    } finally {
      await db.close();
    }
  },
  { overlap: true },
);

each("units interleaved with autocommit writes and batches stay apart", async (rig) => {
  const seen = watch({ keys: ["notes"] });
  const db = await rig.connect({ schema: plain, max: 6, onWrite: seen.onWrite });
  try {
    const work: Promise<unknown>[] = [];
    for (let unit = 0; unit < 6; unit += 1) {
      const base = (unit + 1) * 100;
      work.push(
        db.tx(async (tx) => {
          await tx.notes.insert({ id: base, body: "tx" });
          await Bun.sleep(unit % 3 === 0 ? 30 : 5);
          await tx.notes.insert({ id: base + 1, body: "tx" });
          await Bun.sleep(5);
          await tx.notes.insert({ id: base + 2, body: "tx" });
        }),
        db.notes.insert({ id: base + 50, body: "autocommit" }),
        db.batch([
          db.notes.insert({ id: base + 60, body: "batch" }),
          db.notes.insert({ id: base + 61, body: "batch" }),
        ]),
      );
    }
    await Promise.all(work);
    await seen.flush();

    expect(seen.committed).toHaveLength(18);
    const outcomes = outcomesOf(seen.events);
    expect(outcomes).toHaveLength(18);
    expect(new Set(outcomes.map((event) => event.unit)).size).toBe(18);
    const written = new Map<string, number[]>();
    for (const event of writesOf(seen.events)) {
      const list = written.get(event.unit) ?? [];
      expect(event.seq).toBe(list.length);
      list.push((event.keys as readonly { id: number }[])[0]!.id);
      written.set(event.unit, list);
    }
    const groups = [...written.values()].map((list) => list.map((id) => id % 100));
    const sorted = groups.map((list) => list.join(",")).sort();
    expect(sorted).toEqual(
      [
        ...Array.from({ length: 6 }, () => "0,1,2"),
        ...Array.from({ length: 6 }, () => "50"),
        ...Array.from({ length: 6 }, () => "60,61"),
      ].sort(),
    );
    for (const list of written.values()) {
      expect(new Set(list.map((id) => Math.floor(id / 100))).size).toBe(1);
    }
    expect((await ids(rig)).length).toBe(36);
  } finally {
    await db.close();
  }
});

each("clients scoped by for, unscoped, and with report only their own tenant", async (rig) => {
  const seen = watch({ keys: ["docs"], params: true });
  const db = await rig.connect({
    schema: tenant,
    session,
    max: 6,
    onWrite: seen.onWrite,
    onQuery: seen.onQuery,
  });
  try {
    await db
      .for({ tenantId: TENANT_A })
      .with({ userId: USER_1 })
      .docs.insert({ id: 1, title: "alpha" });
    await db
      .for({ tenantId: TENANT_B })
      .with({ userId: USER_2 })
      .docs.insert({ id: 2, title: "beta" });
    await db
      .for({ tenantId: TENANT_A })
      .with({ userId: USER_1 })
      .docs.insert({ id: 7, title: "to be removed by the unscoped client" });
    await seen.flush();
    seen.events.length = 0;
    seen.queries.length = 0;

    const one = db.for({ tenantId: TENANT_A }).with({ userId: USER_1 });
    const two = db.for({ tenantId: TENANT_B }).with({ userId: USER_2 });
    const root = db.unscoped("conformance backfill").with({ userId: USER_3 });
    await Promise.all([
      one.docs.insert({ id: 3, title: "alpha again" }),
      two.docs.insert({ id: 4, title: "beta again" }),
      one.tx(async (tx) => {
        await tx.docs.update({ where: { id: 1 }, set: { title: "alpha updated" } });
        await Bun.sleep(20);
        await tx.docs.insert({ id: 5, title: "alpha in tx" });
      }),
      two.tx(async (tx) => {
        await tx.docs.update({ where: { id: 2 }, set: { title: "beta updated" } });
        await Bun.sleep(5);
        await tx.docs.insert({ id: 6, title: "beta in tx" });
      }),
      root.docs.delete({ where: { id: 7 } }),
    ]);
    await seen.flush();

    const tenants = new Map<number, unknown>();
    for (const event of writesOf(seen.events)) {
      const id = (event.keys as readonly { id: number }[])[0]!.id;
      tenants.set(id, event.tenant);
    }
    const forA = { tenantId: TENANT_A };
    const forB = { tenantId: TENANT_B };
    expect(tenants.get(7)).toBeNull();
    expect(tenants.get(3)).toEqual(forA);
    expect(tenants.get(4)).toEqual(forB);
    expect(tenants.get(1)).toEqual(forA);
    expect(tenants.get(5)).toEqual(forA);
    expect(tenants.get(2)).toEqual(forB);
    expect(tenants.get(6)).toEqual(forB);

    for (const list of unitsOf(seen.events)) {
      const seenTenants = new Set(writesOf(list).map((event) => JSON.stringify(event.tenant)));
      expect(seenTenants.size).toBe(1);
    }

    const everything = JSON.stringify([
      seen.events,
      seen.queries,
      seen.queries.map((query) => toOtel(query, { statement: true })),
    ]);
    for (const value of [USER_1, USER_2, USER_3]) expect(everything).not.toContain(value);
    const queries = JSON.stringify([
      seen.queries,
      seen.queries.map((query) => toOtel(query, { statement: true })),
    ]);
    for (const value of [TENANT_A, TENANT_B]) expect(queries).not.toContain(value);
    for (const event of writesOf(seen.events)) {
      expect(event.settings.every((name) => typeof name === "string")).toBe(true);
    }
    expect(await ids(rig, "docs")).toEqual([1, 2, 3, 4, 5, 6]);
  } finally {
    await db.close();
  }
});

test.skip("a write from a with() client names its settings and never their values (#528: settings is always empty)", async () => {
  const seen = watch();
  const rig = await openRig("pglite", DDL);
  const db = await rig.connect({ schema: tenant, session, onWrite: seen.onWrite });
  try {
    await db
      .for({ tenantId: TENANT_A })
      .with({ userId: USER_1 })
      .docs.insert({ id: 1, title: "named" });
    await seen.flush();
    expect(writesOf(seen.events)[0]?.settings).toEqual(["app.user_id"]);
    expect(JSON.stringify(seen.events)).not.toContain(USER_1);
  } finally {
    await db.close();
    await rig.close();
  }
});

function unitsOf<E extends { readonly unit: string }>(events: readonly E[]): E[][] {
  const units = new Map<string, E[]>();
  for (const event of events) {
    const list = units.get(event.unit) ?? [];
    list.push(event);
    units.set(event.unit, list);
  }
  return [...units.values()];
}

each("bound values and hidden or sensitive columns stay out of every event", async (rig) => {
  const label = "label-value-4f1a";
  const secret = "secret-value-9c2e";
  const changed = "changed-secret-5d7b";
  const quiet = watch();
  const loud = watch({ params: true });
  const dbQuiet = await rig.connect({
    schema: plain,
    max: 2,
    onWrite: quiet.onWrite,
    onQuery: quiet.onQuery,
  });
  const dbLoud = await rig.connect({
    schema: plain,
    max: 2,
    onWrite: loud.onWrite,
    onQuery: loud.onQuery,
  });
  try {
    for (const [db, id] of [
      [dbQuiet, 1],
      [dbLoud, 2],
    ] as const) {
      await db.vault.insert({ id, label, secret });
      await db.vault.update({ where: { id }, set: { secret: changed } });
      await db.vault.find({ where: { label }, limit: 5 });
      await db.tx(async (tx) => {
        await tx.vault.insert({ id: id + 10, label, secret });
        await tx.vault.delete({ where: { id: id + 10 } });
      });
      const failure = await rejection(db.vault.insert({ id, label, secret }));
      expect(failure).toBeInstanceOf(OkmError);
    }
    await quiet.flush();
    await loud.flush();

    for (const seen of [quiet, loud]) {
      const events = JSON.stringify(seen.events);
      const spans = JSON.stringify(seen.queries.map((query) => toOtel(query, { statement: true })));
      const failures = JSON.stringify(seen.queries.map((query) => query.error));
      for (const value of [label, secret, changed]) {
        expect(events).not.toContain(value);
        expect(spans).not.toContain(value);
        expect(failures).not.toContain(value);
      }
      for (const query of seen.queries) {
        for (const value of [secret, changed]) expect(query.text).not.toContain(value);
      }
    }
    for (const query of quiet.queries) expect(query.params).toBeUndefined();
    const withParams = loud.queries.filter((query) => query.params !== undefined);
    expect(withParams.length).toBe(loud.queries.length);
    const blob = JSON.stringify(loud.queries.map((query) => query.params));
    expect(blob).toContain(label);
    expect(blob).toContain("[redacted]");
    expect(blob).not.toContain(secret);
    expect(blob).not.toContain(changed);
  } finally {
    await dbQuiet.close();
    await dbLoud.close();
  }
});
