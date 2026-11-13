/**
 * Acquire waits and the class-form raw statement timeout on Postgres.
 *
 * postgres.js 3.4.9 runs in the suite. The postgres.js 4 step runs the
 * postgres.js cases in this file again.
 */

import { expect } from "bun:test";

import { openPostgres, withPostgresSchema } from "../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { fragment, raw, schema, t, table } from "../src/dialects/pg/index.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";

const notes = table("notes", {
  id: t.integer().primaryKey(),
  title: t.text(),
});
const app = schema({ tables: [notes] });

class Cell {
  ok = "";
}

type Timeouts = {
  readonly acquire?: number;
  readonly statement?: number;
};

type Handle = {
  notes: {
    find(options: { limit: number; timeout?: number }): Promise<unknown>;
    insert(row: { id: number; title: string }): Promise<unknown>;
    count(): Promise<number>;
  };
  tx<T>(run: (tx: Handle) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  connected: Promise<void>;
};

type Open = (url: string, searchPath: string, max: number, timeouts?: Timeouts) => Handle;

const drivers: Record<string, Open> = {
  "postgres.js": (url, searchPath, max, timeouts) =>
    connectPostgres(url, {
      schema: app,
      searchPath,
      max,
      ...(timeouts !== undefined ? { timeouts } : {}),
    }) as unknown as Handle,
  "node-postgres": (url, searchPath, max, timeouts) =>
    connectPg(url, {
      schema: app,
      searchPath,
      max,
      ...(timeouts !== undefined ? { timeouts } : {}),
    }) as unknown as Handle,
};

const gate = await loadPostgresGate();

function assertAcquire(error: unknown, ms: number, lo: number, hi: number): void {
  expect(error).toBeInstanceOf(OkmError);
  if (!(error instanceof OkmError)) return;
  expect(error.code).toBe("OKM1846");
  expect(error.kind).toBe("timeout");
  expect(error.retryable).toBe(true);
  expect(ms).toBeGreaterThanOrEqual(lo);
  expect(ms).toBeLessThanOrEqual(hi);
}

function assertStatement(error: unknown, ms: number): void {
  expect(error).toBeInstanceOf(OkmError);
  if (!(error instanceof OkmError)) return;
  expect(error.code).toBe("timeout");
  expect(error.kind).toBe("timeout");
  expect(error.retryable).toBe(true);
  expect(ms).toBeGreaterThanOrEqual(200);
  expect(ms).toBeLessThanOrEqual(800);
}

async function timed(run: () => Promise<unknown>): Promise<{ error: unknown; ms: number }> {
  const start = Date.now();
  try {
    await run();
    return { error: undefined, ms: Date.now() - start };
  } catch (error) {
    return { error, ms: Date.now() - start };
  }
}

function holdQuery(db: Handle, seconds: number): { ready: Promise<void>; done: Promise<unknown> } {
  let go: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    go = resolve;
  });
  const done = (async () => {
    go();
    await raw(db.notes, Cell, "read", fragment`select pg_sleep(${seconds})::text as ok`);
  })();
  done.catch(() => undefined);
  return { ready, done };
}

function hold(db: Handle, seconds: number): { ready: Promise<void>; done: Promise<unknown> } {
  let go: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    go = resolve;
  });
  const done = db.tx(async (tx) => {
    go();
    await raw(tx.notes, Cell, "read", fragment`select pg_sleep(${seconds})::text as ok`);
  });
  done.catch(() => undefined);
  return { ready, done };
}

async function withTable(run: (url: string, searchPath: string) => Promise<void>): Promise<void> {
  const url = primaryUrl();
  await withPostgresSchema(async (sql, searchPath) => {
    for (const statement of renderCatalog(app.catalog, searchPath)) {
      if (statement.trim().length === 0) continue;
      await sql.unsafe(statement);
    }
    await run(url, searchPath);
  }, url);
}

for (const [name, open] of Object.entries(drivers)) {
  postgresTest(gate, `${name} acquire bounds find, insert, count, and tx`, async () => {
    await withTable(async (url, searchPath) => {
      const db = open(url, searchPath, 1, { acquire: 200 });
      try {
        await db.connected;
        const held = hold(db, 1.5);
        await held.ready;
        const calls = await Promise.all([
          timed(() => db.notes.find({ limit: 1 })),
          timed(() => db.notes.insert({ id: 1, title: "queued" })),
          timed(() => db.notes.count()),
          timed(() => db.tx(async () => undefined)),
        ]);
        for (const call of calls) assertAcquire(call.error, call.ms, 150, 600);
        await held.done;
        expect(await db.notes.count()).toBe(0);
      } finally {
        await db.close();
      }
    });
  });

  postgresTest(gate, `${name} same-tick inserts keep the rows that landed`, async () => {
    await withTable(async (url, searchPath) => {
      const db = open(url, searchPath, 1, { acquire: 50 });
      try {
        await db.connected;
        const held = hold(db, 0.1);
        await held.ready;
        const results = await Promise.allSettled(
          Array.from({ length: 20 }, (_, index) =>
            db.notes.insert({ id: index + 1, title: "queued" }),
          ),
        );
        await held.done;
        let fulfilled = 0;
        for (const result of results) {
          if (result.status === "fulfilled") {
            fulfilled += 1;
            continue;
          }
          expect(result.reason).toBeInstanceOf(OkmError);
          if (result.reason instanceof OkmError) {
            expect(result.reason.code).toBe("OKM1846");
            expect(result.reason.kind).toBe("timeout");
            expect(result.reason.retryable).toBe(true);
          }
        }
        expect(await db.notes.count()).toBe(fulfilled);
        await db.notes.insert({ id: 100, title: "later" });
        expect(await db.notes.count()).toBe(fulfilled + 1);
      } finally {
        await db.close();
      }
    });
  });

  postgresTest(gate, `${name} class-form raw uses the statement timeout`, async () => {
    await withTable(async (url, searchPath) => {
      const db = open(url, searchPath, 1, { statement: 300 });
      try {
        await db.connected;
        const outer = await timed(() =>
          raw(db.notes, Cell, "read", fragment`select pg_sleep(2)::text as ok`),
        );
        assertStatement(outer.error, outer.ms);
        const inner = await timed(() =>
          db.tx((tx) => raw(tx.notes, Cell, "read", fragment`select pg_sleep(2)::text as ok`)),
        );
        assertStatement(inner.error, inner.ms);
      } finally {
        await db.close();
      }
      const plain = open(url, searchPath, 1);
      try {
        await plain.connected;
        const slept = await timed(() =>
          raw(plain.notes, Cell, "read", fragment`select pg_sleep(0.4)::text as ok`),
        );
        expect(slept.error).toBeUndefined();
        expect(slept.ms).toBeGreaterThanOrEqual(300);
        expect(slept.ms).toBeLessThan(1_000);
      } finally {
        await plain.close();
      }
    });
  });

  postgresTest(gate, `${name} a call timeout overrides the session statement timeout`, async () => {
    await withTable(async (url, searchPath) => {
      const db = open(url, searchPath, 2, { statement: 5_000 });
      const admin = openPostgres(url);
      try {
        await db.connected;
        await admin.unsafe("begin");
        await admin.unsafe(`lock table ${searchPath}.notes in access exclusive mode`);
        const outcome = await timed(() => db.notes.find({ limit: 1, timeout: 200 }));
        assertStatement(outcome.error, outcome.ms);
      } finally {
        await admin.unsafe("rollback").catch(() => undefined);
        await admin.end({ timeout: 1 }).catch(() => undefined);
        await db.close();
      }
    });
  });
}

postgresTest(gate, "node-postgres acquire bounds a plain statement holder", async () => {
  await withTable(async (url, searchPath) => {
    const open = drivers["node-postgres"];
    if (open === undefined) return;
    const db = open(url, searchPath, 1, { acquire: 200 });
    try {
      await db.connected;
      const held = holdQuery(db, 1.5);
      await held.ready;
      await Bun.sleep(40);
      const calls = await Promise.all([
        timed(() => db.notes.find({ limit: 1 })),
        timed(() => db.notes.insert({ id: 1, title: "queued" })),
        timed(() => db.notes.count()),
      ]);
      for (const call of calls) assertAcquire(call.error, call.ms, 150, 600);
      await held.done;
      expect(await db.notes.count()).toBe(0);
    } finally {
      await db.close();
    }
  });
});

postgresTest(
  gate,
  "node-postgres acquire 5500 is the pool deadline",
  async () => {
    await withTable(async (url, searchPath) => {
      const open = drivers["node-postgres"];
      if (open === undefined) return;
      const db = open(url, searchPath, 1, { acquire: 5500 });
      try {
        await db.connected;
        const held = hold(db, 6.5);
        await held.ready;
        const outcome = await timed(() => db.notes.find({ limit: 1 }));
        assertAcquire(outcome.error, outcome.ms, 5_200, 6_800);
        await held.done;
      } finally {
        await db.close();
      }
    });
  },
  15_000,
);

postgresTest(gate, "bun.sql class-form raw applies the statement timeout", async () => {
  await withTable(async (url, searchPath) => {
    const openBun = (timeouts?: Timeouts): Handle =>
      connectBun(url, {
        schema: app,
        searchPath,
        max: 1,
        ...(timeouts !== undefined ? { timeouts } : {}),
      }) as unknown as Handle;
    const db = openBun({ statement: 300 });
    try {
      await db.connected;
      const outer = await timed(() =>
        raw(db.notes, Cell, "read", fragment`select pg_sleep(2)::text as ok`),
      );
      assertRefused(outer.error, outer.ms);
      const inner = await timed(() =>
        db.tx((tx) => raw(tx.notes, Cell, "read", fragment`select pg_sleep(2)::text as ok`)),
      );
      assertRefused(inner.error, inner.ms);
    } finally {
      await db.close();
    }
    const plain = openBun();
    try {
      await plain.connected;
      const slept = await timed(() =>
        raw(plain.notes, Cell, "read", fragment`select pg_sleep(0.4)::text as ok`),
      );
      expect(slept.error).toBeUndefined();
      expect(slept.ms).toBeGreaterThanOrEqual(300);
      expect(slept.ms).toBeLessThan(1_000);
    } finally {
      await plain.close();
    }
  });
});

function assertRefused(error: unknown, ms: number): void {
  expect(ms).toBeLessThan(200);
  expect(error).toBeInstanceOf(OkmError);
  if (!(error instanceof OkmError)) return;
  expect(error.code).toBe("OKM1120");
  expect(error.kind).toBe("invalid");
  expect(error.message).toBe("timeout");
}
