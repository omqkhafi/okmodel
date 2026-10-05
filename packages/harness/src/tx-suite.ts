/**
 * Runtime transaction conformance suite (spec §15).
 *
 * The same cases run on every adapter through its runtime `connect`: `tx`,
 * `batch`, savepoints, `afterCommit`, retry, row locks, cancellation, timeouts,
 * a commit cut on the wire, and state left on a pooled connection. A case that
 * needs a second connection is skipped on a one-connection driver, and a case
 * that needs `cancel` is skipped where the driver did not declare it. Every skip
 * names the reason in the test title.
 */

import { expect } from "bun:test";

import type {
  DriverCapabilities,
  DriverPool,
  DriverTimeouts,
} from "../../../src/contracts/driver.js";
import { OkmError } from "../../../src/contracts/error.js";
import { renderCatalog } from "../../../src/dialects/pg/ddl.js";
import { id, schema, table, t, text } from "../../../src/dialects/pg/index.js";
import type { QuerySchema } from "../../../src/dialects/pg/model.js";
import type { Connected, ConnectOptions, Hookm, TxClient } from "../../../src/runtime/types.js";
import { columnTenancy } from "../../../src/runtime/tenancy/index.js";
import type { SuiteTest } from "./driver-suite.js";
import { startCutProxy } from "./proxy.js";
import { openPostgres } from "./postgres.js";
import { isolatedSchemaName } from "./schema-name.js";
import { primaryUrl } from "./topology.js";

/** What one adapter run needs. */
export type TxSuite = {
  /** Name used in test titles. */
  readonly name: string;
  /** Flags the adapter declares. */
  readonly capabilities: DriverCapabilities;
  /** Opens a pool whose search path is `schema`. The suite closes it. */
  readonly open: (config: {
    readonly schema: string;
    readonly max: number;
    readonly timeouts?: DriverTimeouts;
    readonly url?: string;
  }) => DriverPool | Promise<DriverPool>;
  /** The runtime `connect` of the adapter, called with a pool. */
  readonly connect: <S extends QuerySchema>(
    pool: DriverPool,
    options: ConnectOptions<S>,
  ) => Connected<S> | Promise<Connected<S>>;
  /** One in-process connection: no second transaction can run beside the first. */
  readonly memory: boolean;
  /** The driver returns server notices. */
  readonly notices: boolean;
  /** Test registrar. */
  readonly test: SuiteTest;
};

const accounts = table("accounts", { id: t.text().primaryKey(), balance: t.integer() });
const events = table("events", { id: t.text().primaryKey(), note: t.text() });
const app = schema({ casing: "snake", tables: [accounts, events] });

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
const notes = table("notes", { id: id({ default: "none" }), body: text() });
const tenantApp = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});

type Db = Connected<typeof app>;

type EnvOptions = {
  readonly max?: number;
  readonly timeouts?: DriverTimeouts;
  readonly hookm?: readonly Hookm[];
  readonly url?: string;
  readonly sql?: readonly string[];
};

type Env<S extends QuerySchema> = {
  readonly db: Connected<S>;
  readonly pool: DriverPool;
  readonly schemaName: string;
  /** A second client on a pool of its own, for checks that must not share the first connection. */
  readonly direct: () => Promise<DriverPool>;
};

/**
 * Registers the transaction cases for one adapter.
 *
 * @param suite - The adapter under test
 */
export function registerTxSuite(suite: TxSuite): void {
  const { name } = suite;
  const test = suite.test;
  const needsSecond = suite.memory ? skipped(test, "one connection") : test;
  const cancels = suite.capabilities.cancel && !suite.memory ? test : skipped(test, "no cancel");
  const race = needsSecond;
  const proxied = suite.memory ? skipped(test, "no socket to cut") : test;

  async function withEnv<S extends QuerySchema>(
    built: S & { readonly catalog: Parameters<typeof renderCatalog>[0] },
    options: EnvOptions,
    fn: (env: Env<S>) => Promise<void>,
  ): Promise<void> {
    const schemaName = suite.memory ? "public" : isolatedSchemaName();
    const admin = suite.memory ? undefined : openPostgres();
    const pools: DriverPool[] = [];
    try {
      if (admin !== undefined) await admin.unsafe(`create schema ${schemaName}`);
      const open = async (config: { max: number; url?: string }): Promise<DriverPool> => {
        const pool = await suite.open({
          schema: schemaName,
          max: config.max,
          ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
          ...(config.url !== undefined ? { url: config.url } : {}),
        });
        pools.push(pool);
        return pool;
      };
      const setup = options.url === undefined || suite.memory ? undefined : await open({ max: 1 });
      const pool = await open({
        max: options.max ?? 4,
        ...(options.url ? { url: options.url } : {}),
      });
      const ddl = [...renderCatalog(built.catalog, schemaName), ...(options.sql ?? [])];
      for (const statement of ddl) await (setup ?? pool).execute(statement);
      const db = await suite.connect(pool, {
        schema: built,
        ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
        ...(options.hookm !== undefined ? { hookm: options.hookm } : {}),
      } as ConnectOptions<S>);
      try {
        await fn({
          db,
          pool,
          schemaName,
          direct: () => open({ max: 1 }),
        });
      } finally {
        await db.close();
      }
    } finally {
      for (const pool of pools) await pool.close().catch(() => undefined);
      if (admin !== undefined) {
        await admin.unsafe(`drop schema if exists ${schemaName} cascade`).catch(() => undefined);
        await admin.end({ timeout: 5 });
      }
    }
  }

  const withApp = (options: EnvOptions, fn: (env: Env<typeof app>) => Promise<void>) =>
    withEnv(app, options, fn);

  async function seed(db: Db): Promise<void> {
    await db.accounts.insert({ id: "a", balance: 100 });
    await db.accounts.insert({ id: "b", balance: 100 });
  }

  const balances = async (db: Db): Promise<Record<string, number>> => {
    const rows = await db.accounts.find({ limit: 100 });
    return Object.fromEntries(rows.map((row) => [row.id, row.balance]));
  };

  // ── commit, rollback, savepoints ────────────────────────────────────────

  test(`${name} tx commits its writes and returns the callback's value`, async () => {
    await withApp({}, async ({ db }) => {
      const value = await db.tx(async (tx) => {
        await tx.accounts.insert({ id: "a", balance: 1 });
        await tx.accounts.insert({ id: "b", balance: 2 });
        const inside = await tx.accounts.find({ limit: 10 });
        return inside.length;
      });
      expect(value).toBe(2);
      expect(await balances(db)).toEqual({ a: 1, b: 2 });
    });
  });

  test(`${name} tx rolls back on a throw and the caller's own error comes back as thrown`, async () => {
    await withApp({}, async ({ db }) => {
      const boom = new TypeError("mine");
      const error = await failure(
        db.tx(async (tx) => {
          await tx.accounts.insert({ id: "a", balance: 1 });
          throw boom;
        }),
      );
      expect(error).toBe(boom);
      expect(await balances(db)).toEqual({});
    });
  });

  test(`${name} tx refuses to commit after a handled statement error`, async () => {
    await withApp({}, async ({ db }) => {
      await seed(db);
      const error = await failure(
        db.tx(async (tx) => {
          await tx.accounts.update({ where: { id: "a" }, set: { balance: 5 } });
          await tx.accounts.insert({ id: "b", balance: 9 }).catch(() => undefined);
        }),
      );
      expect(error).toBeInstanceOf(OkmError);
      expect((error as OkmError).kind).toBe("unique");
      expect(await balances(db)).toEqual({ a: 100, b: 100 });
    });
  });

  test(`${name} a nested tx is a savepoint: the inner failure rolls back only the inner writes`, async () => {
    await withApp({}, async ({ db }) => {
      await db.tx(async (tx) => {
        await tx.accounts.insert({ id: "x", balance: 1 });
        const inner = new Error("inner");
        const error = await failure(
          tx.tx(async (nested) => {
            await nested.accounts.insert({ id: "y", balance: 2 });
            throw inner;
          }),
        );
        expect(error).toBe(inner);
        await tx.accounts.insert({ id: "z", balance: 3 });
      });
      expect(await balances(db)).toEqual({ x: 1, z: 3 });
    });
  });

  test(`${name} a nested tx that swallows its own failed statement rolls back and throws it`, async () => {
    await withApp({}, async ({ db }) => {
      await seed(db);
      await db.tx(async (tx) => {
        await tx.accounts.update({ where: { id: "a" }, set: { balance: 7 } });
        const error = await failure(
          tx.tx(async (nested) => {
            await nested.accounts.insert({ id: "b", balance: 1 }).catch(() => undefined);
          }),
        );
        expect((error as OkmError).kind).toBe("unique");
        // The outer transaction goes on.
        await tx.accounts.update({ where: { id: "b" }, set: { balance: 8 } });
      });
      expect(await balances(db)).toEqual({ a: 7, b: 8 });
    });
  });

  test(`${name} nested tx refuses isolation, retry, timeout, and signal, which belong to the outermost tx`, async () => {
    await withApp({}, async ({ db }) => {
      const error = await failure(
        db.tx(async (tx) => {
          await tx.tx({ isolation: "serializable" }, async () => undefined);
        }),
      );
      expect((error as OkmError).code).toBe("OKM1121");
    });
  });

  test(`${name} a client the callback leaked cannot touch the connection after the tx ends`, async () => {
    await withApp({ max: 1 }, async ({ db }) => {
      let leaked: TxClient<typeof app> | undefined;
      await db.tx(async (tx) => {
        leaked = tx;
      });
      const error = await failure(leaked!.accounts.find({ limit: 1 }));
      expect((error as OkmError).message).toContain("transaction has finished");
      expect(await balances(db)).toEqual({});
    });
  });

  // ── batch ───────────────────────────────────────────────────────────────

  test(`${name} batch is atomic and returns results in order`, async () => {
    await withApp({}, async ({ db }) => {
      const results = await db.batch([
        db.accounts.insert({ id: "a", balance: 1 }),
        db.accounts.insert({ id: "b", balance: 2 }),
        db.accounts.update({ where: { id: "a" }, set: { balance: 10 } }),
      ]);
      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({ id: "a", balance: 1 });
      expect(results[1]).toMatchObject({ id: "b", balance: 2 });
      expect(results[2]).toMatchObject({ count: 1 });
      expect(await balances(db)).toEqual({ a: 10, b: 2 });
    });
  });

  test(`${name} a failing batch rolls everything back and names the operation`, async () => {
    await withApp({}, async ({ db }) => {
      await seed(db);
      const error = await failure(
        db.batch([
          db.accounts.update({ where: { id: "a" }, set: { balance: 1 } }),
          db.accounts.insert({ id: "b", balance: 2 }),
          db.accounts.update({ where: { id: "b" }, set: { balance: 3 } }),
        ]),
      );
      expect((error as OkmError).kind).toBe("unique");
      expect((error as OkmError).batchIndex).toBe(1);
      expect(await balances(db)).toEqual({ a: 100, b: 100 });
    });
  });

  test(`${name} batch inside tx is a savepoint: a failing batch can be handled and the tx survives`, async () => {
    await withApp({}, async ({ db }) => {
      await seed(db);
      await db.tx(async (tx) => {
        await tx.accounts.update({ where: { id: "a" }, set: { balance: 1 } });
        const error = await failure(
          tx.batch([
            tx.accounts.update({ where: { id: "a" }, set: { balance: 2 } }),
            tx.accounts.insert({ id: "b", balance: 3 }),
          ]),
        );
        expect((error as OkmError).batchIndex).toBe(1);
        const ok = await tx.batch([
          tx.accounts.update({ where: { id: "b" }, set: { balance: 4 } }),
        ]);
        expect(ok).toHaveLength(1);
      });
      expect(await balances(db)).toEqual({ a: 1, b: 4 });
    });
  });

  test(`${name} batch refuses .replica() (OKM1840) and anything that is not a write`, async () => {
    await withApp({}, async ({ db }) => {
      const replica = await failure(
        (
          db.batch([db.accounts.insert({ id: "a", balance: 1 })]) as unknown as {
            replica(): Promise<unknown>;
          }
        ).replica(),
      );
      expect((replica as OkmError).code).toBe("OKM1840");
      const read = await failure(db.batch([db.accounts.find({ limit: 1 }) as never]));
      expect((read as OkmError).code).toBe("OKM1121");
      expect(await balances(db)).toEqual({});
    });
  });

  // ── afterCommit ─────────────────────────────────────────────────────────

  test(`${name} afterCommit runs in order after the commit, never after a rollback`, async () => {
    await withApp({}, async ({ db, pool }) => {
      const calls: string[] = [];
      await db.tx(async (tx) => {
        tx.afterCommit(async () => {
          const rows = await pool.execute("select count(*) from accounts");
          calls.push(`first:${String(rows.rows[0]?.[0])}`);
        });
        tx.afterCommit(() => {
          calls.push("second");
        });
        await tx.accounts.insert({ id: "a", balance: 1 });
        await tx.tx(async (nested) => {
          nested.afterCommit(() => {
            calls.push("nested");
          });
        });
        const failed = await failure(
          tx.tx(async (nested) => {
            nested.afterCommit(() => {
              calls.push("rolled-back nested");
            });
            throw new Error("no");
          }),
        );
        expect(failed).toBeInstanceOf(Error);
        expect(calls).toEqual([]);
      });
      expect(calls).toEqual(["first:1", "second", "nested"]);
      calls.length = 0;
      await failure(
        db.tx(async (tx) => {
          tx.afterCommit(() => {
            calls.push("never");
          });
          throw new Error("rollback");
        }),
      );
      expect(calls).toEqual([]);
    });
  });

  test(`${name} an afterCommit error reaches hookm.onError and never changes the commit`, async () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    await withApp({ hookm: [{ onError: (error) => errors.push(error) }] }, async ({ db }) => {
      const value = await db.tx(async (tx) => {
        tx.afterCommit(() => {
          throw new Error("callback broke");
        });
        tx.afterCommit(() => {
          calls.push("after the broken one");
        });
        await tx.accounts.insert({ id: "a", balance: 1 });
        return "done";
      });
      expect(value).toBe("done");
      expect(calls).toEqual(["after the broken one"]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe("callback broke");
      expect(await balances(db)).toEqual({ a: 1 });
    });
  });

  // ── row locks ───────────────────────────────────────────────────────────

  test(`${name} a row lock outside tx is OKM1830, and a bad lock or wait is refused`, async () => {
    await withApp({}, async ({ db }) => {
      const outside = await failure(db.accounts.find({ limit: 1, lock: "update" } as never));
      expect((outside as OkmError).code).toBe("OKM1830");
      await db.tx(async (tx) => {
        const bad = await failure(tx.accounts.find({ limit: 1, lock: "exclusive" } as never));
        expect((bad as OkmError).code).toBe("OKM1120");
      });
    });
  });

  test(`${name} find takes update and share locks with nowait and skip inside tx`, async () => {
    await withApp({}, async ({ db }) => {
      await seed(db);
      await db.tx(async (tx) => {
        for (const lock of ["update", "share"] as const) {
          for (const wait of [undefined, "nowait", "skip"] as const) {
            const rows = await tx.accounts.find({
              where: { id: "a" },
              limit: 1,
              lock,
              ...(wait !== undefined ? { wait } : {}),
            });
            expect(rows).toHaveLength(1);
          }
        }
      });
    });
  });

  race(`${name} nowait fails at once and skip leaves the locked row out`, async () => {
    await withApp({}, async ({ db }) => {
      await seed(db);
      const hold = await holdRow(db, "a");
      try {
        const refused = await failure(
          db.tx((tx) =>
            tx.accounts.find({ where: { id: "a" }, limit: 1, lock: "update", wait: "nowait" }),
          ),
        );
        expect((refused as OkmError).kind).toBe("lock_timeout");
        const skipped = await db.tx((tx) =>
          tx.accounts.find({ limit: 10, lock: "update", wait: "skip" }),
        );
        expect(skipped.map((row) => row.id)).toEqual(["b"]);
        // Two share locks do not wait for each other.
        const shared = await db.tx((tx) =>
          tx.accounts.find({ where: { id: "b" }, limit: 1, lock: "share", wait: "nowait" }),
        );
        expect(shared).toHaveLength(1);
      } finally {
        await hold.release();
      }
    });
  });

  // ── retry ───────────────────────────────────────────────────────────────

  race(
    `${name} two serializable transactions that conflict: the loser is retried on a fresh transaction`,
    async () => {
      await withApp({}, async ({ db }) => {
        await seed(db);
        const attempts = { a: 0, b: 0 };
        const ready = barrier(2);
        const run = (me: "a" | "b") =>
          db.tx({ isolation: "serializable", retry: 3 }, async (tx) => {
            attempts[me] += 1;
            const rows = await tx.accounts.find({ limit: 10 });
            const total = rows.reduce((sum, row) => sum + row.balance, 0);
            if (attempts[me] === 1) await ready();
            await tx.accounts.update({ where: { id: me }, set: { balance: total } });
          });
        await Promise.all([run("a"), run("b")]);
        expect(attempts.a + attempts.b).toBe(3);
        expect(Object.values(await balances(db)).toSorted((a, b) => a - b)).toEqual([200, 300]);
      });
    },
    20_000,
  );

  race(
    `${name} without retry the serialization failure surfaces as a retryable error`,
    async () => {
      await withApp({}, async ({ db }) => {
        await seed(db);
        const ready = barrier(2);
        const run = (me: "a" | "b") =>
          db.tx({ isolation: "serializable" }, async (tx) => {
            const rows = await tx.accounts.find({ limit: 10 });
            await ready();
            await tx.accounts.update({
              where: { id: me },
              set: { balance: rows.reduce((sum, row) => sum + row.balance, 0) },
            });
          });
        const settled = await Promise.allSettled([run("a"), run("b")]);
        const rejected = settled.filter((item) => item.status === "rejected");
        expect(rejected).toHaveLength(1);
        const error = (rejected[0] as PromiseRejectedResult).reason as OkmError;
        expect(error.kind).toBe("serialization");
        expect(error.retryable).toBe(true);
      });
    },
    20_000,
  );

  race(
    `${name} a real deadlock: the victim is retried and both finish`,
    async () => {
      await withApp({}, async ({ db }) => {
        await seed(db);
        const attempts = { a: 0, b: 0 };
        const ready = barrier(2);
        const run = (me: "a" | "b", first: string, second: string) =>
          db.tx({ retry: 2 }, async (tx) => {
            attempts[me] += 1;
            await tx.accounts.find({ where: { id: first }, limit: 1, lock: "update" });
            if (attempts[me] === 1) await ready();
            await tx.accounts.find({ where: { id: second }, limit: 1, lock: "update" });
            await tx.accounts.update({ where: { id: first }, set: { balance: attempts[me] } });
          });
        await Promise.all([run("a", "a", "b"), run("b", "b", "a")]);
        expect(attempts.a + attempts.b).toBe(3);
      });
    },
    20_000,
  );

  race(
    `${name} a deadlock with retry 0 fails as kind deadlock`,
    async () => {
      await withApp({}, async ({ db }) => {
        await seed(db);
        const ready = barrier(2);
        const run = (first: string, second: string) =>
          db.tx(async (tx) => {
            await tx.accounts.find({ where: { id: first }, limit: 1, lock: "update" });
            await ready();
            await tx.accounts.find({ where: { id: second }, limit: 1, lock: "update" });
          });
        const settled = await Promise.allSettled([run("a", "b"), run("b", "a")]);
        const rejected = settled.filter((item) => item.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect(((rejected[0] as PromiseRejectedResult).reason as OkmError).kind).toBe("deadlock");
      });
    },
    20_000,
  );

  race(`${name} repeatable read keeps one snapshot, read committed does not`, async () => {
    await withApp({}, async ({ db }) => {
      await seed(db);
      const snapshot = async (isolation: "repeatable read" | "read committed") =>
        db.tx({ isolation }, async (tx) => {
          const before = await tx.accounts.find({ where: { id: "a" }, limit: 1 });
          await db.accounts.update({
            where: { id: "a" },
            set: { balance: before[0]!.balance + 1 },
          });
          const after = await tx.accounts.find({ where: { id: "a" }, limit: 1 });
          return [before[0]!.balance, after[0]!.balance] as const;
        });
      expect(await snapshot("repeatable read")).toEqual([100, 100]);
      expect(await snapshot("read committed")).toEqual([101, 102]);
    });
  });

  // ── cancellation and timeouts ───────────────────────────────────────────

  cancels(
    `${name} a statement killed by its timeout fails as kind timeout and the pool is fine`,
    async () => {
      await withApp({}, async ({ db }) => {
        await seed(db);
        const hold = await holdRow(db, "a");
        try {
          const started = Date.now();
          const error = await failure(
            db.accounts.update({ where: { id: "a" }, set: { balance: 7 } }, { timeout: 200 }),
          );
          expect((error as OkmError).kind).toBe("timeout");
          expect(Date.now() - started).toBeLessThan(3_000);
        } finally {
          await hold.release();
        }
        expect(await balances(db)).toEqual({ a: 100, b: 100 });
        await db.accounts.update({ where: { id: "a" }, set: { balance: 8 } });
        expect((await balances(db)).a).toBe(8);
      });
    },
  );

  cancels(
    `${name} a statement killed by abort fails as kind cancelled and is never retried`,
    async () => {
      await withApp({}, async ({ db }) => {
        await seed(db);
        const hold = await holdRow(db, "a");
        try {
          const controller = new AbortController();
          setTimeout(() => controller.abort(), 150);
          let runs = 0;
          const error = await failure(
            db.tx({ retry: 3 }, async (tx) => {
              runs += 1;
              await tx.accounts.update(
                { where: { id: "a" }, set: { balance: 7 } },
                { signal: controller.signal },
              );
            }),
          );
          expect((error as OkmError).kind).toBe("cancelled");
          expect((error as OkmError).retryable).toBe(false);
          expect(runs).toBe(1);
        } finally {
          await hold.release();
        }
        expect(await balances(db)).toEqual({ a: 100, b: 100 });
      });
    },
  );

  cancels(`${name} a timeout on a statement inside tx rolls the whole tx back`, async () => {
    await withApp({}, async ({ db }) => {
      await seed(db);
      const hold = await holdRow(db, "a");
      try {
        const error = await failure(
          db.tx(async (tx) => {
            await tx.accounts.insert({ id: "c", balance: 1 });
            await tx.accounts.update({ where: { id: "a" }, set: { balance: 9 } }, { timeout: 200 });
          }),
        );
        expect((error as OkmError).kind).toBe("timeout");
      } finally {
        await hold.release();
      }
      expect(await balances(db)).toEqual({ a: 100, b: 100 });
    });
  });

  cancels(
    `${name} connect timeouts.statement is the default for a call with no timeout`,
    async () => {
      await withApp({ timeouts: { statement: 200 } }, async ({ db }) => {
        await seed(db);
        const hold = await holdRow(db, "a");
        try {
          const error = await failure(
            db.accounts.update({ where: { id: "a" }, set: { balance: 7 } }),
          );
          expect((error as OkmError).kind).toBe("timeout");
        } finally {
          await hold.release();
        }
      });
    },
  );

  cancels(`${name} tx({ timeout }) stops a blocked transaction and rolls it back`, async () => {
    await withApp({}, async ({ db }) => {
      await seed(db);
      const hold = await holdRow(db, "a");
      try {
        const started = Date.now();
        const error = await failure(
          db.tx({ timeout: 300 }, async (tx) => {
            await tx.accounts.insert({ id: "c", balance: 1 });
            await tx.accounts.update({ where: { id: "a" }, set: { balance: 9 } });
          }),
        );
        expect((error as OkmError).kind).toBe("timeout");
        expect(Date.now() - started).toBeLessThan(3_000);
      } finally {
        await hold.release();
      }
      expect(await balances(db)).toEqual({ a: 100, b: 100 });
    });
  });

  cancels(`${name} tx({ signal }) cancels the transaction and rolls it back`, async () => {
    await withApp({}, async ({ db }) => {
      await seed(db);
      const hold = await holdRow(db, "a");
      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 150);
        const error = await failure(
          db.tx({ signal: controller.signal }, async (tx) => {
            await tx.accounts.insert({ id: "c", balance: 1 });
            await tx.accounts.update({ where: { id: "a" }, set: { balance: 9 } });
          }),
        );
        expect((error as OkmError).kind).toBe("cancelled");
      } finally {
        await hold.release();
      }
      expect(await balances(db)).toEqual({ a: 100, b: 100 });
    });
  });

  test(`${name} an abort after the transaction finished has no effect`, async () => {
    await withApp({}, async ({ db }) => {
      const controller = new AbortController();
      const value = await db.tx({ signal: controller.signal }, async (tx) => {
        await tx.accounts.insert({ id: "a", balance: 1 });
        return 42;
      });
      controller.abort();
      await sleep(30);
      expect(value).toBe(42);
      expect(await balances(db)).toEqual({ a: 1 });
    });
  });

  test(`${name} an already-aborted signal fails before a connection is taken`, async () => {
    await withApp({ max: 1 }, async ({ db }) => {
      const controller = new AbortController();
      controller.abort();
      const error = await failure(
        db.tx({ signal: controller.signal }, async (tx) => {
          await tx.accounts.insert({ id: "a", balance: 1 });
        }),
      );
      expect((error as OkmError).kind).toBe("cancelled");
      expect(await balances(db)).toEqual({});
    });
  });

  test(`${name} timeouts.idleInTransaction stops a transaction that waits between statements`, async () => {
    await withApp({ timeouts: { idleInTransaction: 150 } }, async ({ db }) => {
      const error = await failure(
        db.tx(async (tx) => {
          await tx.accounts.insert({ id: "a", balance: 1 });
          await sleep(500);
          await tx.accounts.insert({ id: "b", balance: 2 });
        }),
      );
      expect((error as OkmError).kind).toBe("timeout");
      expect(await balances(db)).toEqual({});
    });
  });

  test(`${name} timeouts.transaction bounds a callback that never settles and frees the connection`, async () => {
    await withApp({ max: 1, timeouts: { transaction: 250 } }, async ({ db }) => {
      const error = await failure(
        db.tx(async (tx) => {
          await tx.accounts.insert({ id: "a", balance: 1 });
          await new Promise(() => undefined);
        }),
      );
      expect((error as OkmError).kind).toBe("timeout");
      expect(await balances(db)).toEqual({});
    });
  });

  // ── a commit cut on the wire ────────────────────────────────────────────

  proxied(
    `${name} a commit cut on the wire is outcome_unknown (OKM1401) and is never retried`,
    async () => {
      const proxy = await startCutProxy(primaryUrl());
      try {
        await withApp({ url: proxy.url, max: 2 }, async ({ db, direct }) => {
          let runs = 0;
          proxy.cutNextCommit();
          const error = await failure(
            db.tx({ retry: 3 }, async (tx) => {
              runs += 1;
              await tx.accounts.insert({ id: "a", balance: 1 });
            }),
          );
          expect((error as OkmError).code).toBe("OKM1401");
          expect((error as OkmError).kind).toBe("outcome_unknown");
          expect((error as OkmError).retryable).toBe(false);
          expect(runs).toBe(1);
          // The commit reached the server: the caller could not know.
          const check = await (await direct()).execute("select id from accounts");
          expect(check.rows).toEqual([["a"]]);
          // The pool replaced the dead connection.
          await db.accounts.insert({ id: "b", balance: 2 });
          expect(Object.keys(await balances(db)).toSorted()).toEqual(["a", "b"]);
        });
      } finally {
        await proxy.close();
      }
    },
  );

  proxied(
    `${name} a batch whose commit is cut is outcome_unknown with a null batchIndex`,
    async () => {
      const proxy = await startCutProxy(primaryUrl());
      try {
        await withApp({ url: proxy.url, max: 2 }, async ({ db }) => {
          proxy.cutNextCommit();
          const error = await failure(
            db.batch([
              db.accounts.insert({ id: "a", balance: 1 }),
              db.accounts.insert({ id: "b", balance: 2 }),
            ]),
          );
          expect((error as OkmError).code).toBe("OKM1401");
          expect((error as OkmError).batchIndex).toBeNull();
        });
      } finally {
        await proxy.close();
      }
    },
  );

  // ── pooled connections keep no state ────────────────────────────────────

  test(`${name} after a rollback the pooled connection has no transaction, lock, or isolation left`, async () => {
    await withApp({ max: 1 }, async ({ db, pool }) => {
      const probe = async () =>
        (
          await pool.execute(
            `select pg_backend_pid()::text,
                    current_setting('transaction_isolation'),
                    (select count(*) from pg_locks where pid = pg_backend_pid() and locktype = 'advisory')::text,
                    (pg_current_xact_id_if_assigned() is null)::text`,
          )
        ).rows[0];
      const before = await probe();
      const rolled = await failure(
        db.tx({ isolation: "serializable" }, async (tx) => {
          await tx.advisoryLock("jobs");
          await tx.advisoryLock(42);
          await tx.accounts.insert({ id: "a", balance: 1 });
          throw new Error("rollback");
        }),
      );
      expect(rolled).toBeInstanceOf(Error);
      const after = await probe();
      expect(after?.[0]).toBe(before?.[0]);
      expect(after?.slice(1)).toEqual(["read committed", "0", "true"]);
      // The same holds after a commit and after a failed statement.
      await db.tx({ isolation: "repeatable read" }, async (tx) => {
        await tx.advisoryLock(7n);
        await tx.accounts.insert({ id: "b", balance: 1 });
      });
      await failure(
        db.tx(async (tx) => {
          await tx.accounts.insert({ id: "b", balance: 1 });
        }),
      );
      expect((await probe())?.slice(1)).toEqual(["read committed", "0", "true"]);
      expect(await balances(db)).toEqual({ b: 1 });
    });
  });

  race(`${name} an advisory lock is held for the transaction and released at its end`, async () => {
    await withApp({}, async ({ db }) => {
      const first = deferred<void>();
      const gate = deferred<void>();
      let secondGot = false;
      const holder = db.tx(async (tx) => {
        await tx.advisoryLock("queue");
        first.resolve();
        await gate.promise;
      });
      await first.promise;
      const waiter = db.tx(async (tx) => {
        await tx.advisoryLock("queue");
        secondGot = true;
      });
      await sleep(250);
      expect(secondGot).toBe(false);
      gate.resolve();
      await Promise.all([holder, waiter]);
      expect(secondGot).toBe(true);
    });
  });

  test(`${name} tx keeps the tenant scope, and a scoped call never leaks to the next user of the connection`, async () => {
    await withEnv(tenantApp, { max: 1 }, async ({ db }) => {
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      const idA = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c01";
      const idB = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02";
      await b.notes.insert({ id: idB, body: "b" });
      const seen = await a.tx(async (tx) => {
        await tx.notes.insert({ id: idA, body: "a" });
        const inner = await tx.tx(async (nested) => nested.notes.find({ limit: 10 }));
        return [await tx.notes.find({ limit: 10 }), inner] as const;
      });
      expect(seen[0].map((row) => row.body)).toEqual(["a"]);
      expect(seen[1].map((row) => row.body)).toEqual(["a"]);
      // The next user of the one connection is another tenant and sees only its own rows.
      expect((await b.notes.find({ limit: 10 })).map((row) => row.body)).toEqual(["b"]);
      const rolled = await failure(
        b.tx(async (tx) => {
          await tx.notes.insert({ id: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c03", body: "gone" });
          throw new Error("rollback");
        }),
      );
      expect(rolled).toBeInstanceOf(Error);
      expect((await a.notes.find({ limit: 10 })).map((row) => row.body)).toEqual(["a"]);
      expect((await b.notes.find({ limit: 10 })).map((row) => row.body)).toEqual(["b"]);
    });
  });

  // ── hookm ───────────────────────────────────────────────────────────────

  test(`${name} hookm.onTransaction sees start, commit, and rollback, with savepoints one level down`, async () => {
    const seen: string[] = [];
    const hookm: Hookm = { onTransaction: (event) => seen.push(`${event.phase}:${event.depth}`) };
    await withApp({ hookm: [hookm] }, async ({ db }) => {
      await db.tx(async (tx) => {
        await tx.tx(async () => undefined);
        await failure(
          tx.tx(async () => {
            throw new Error("inner");
          }),
        );
      });
      await failure(
        db.tx(async () => {
          throw new Error("outer");
        }),
      );
    });
    expect(seen).toEqual([
      "start:0",
      "start:1",
      "commit:1",
      "start:1",
      "rollback:1",
      "commit:0",
      "start:0",
      "rollback:0",
    ]);
  });

  (suite.notices ? test : skipped(test, "no notices"))(
    `${name} server notices reach hookm.onNotice, inside tx too`,
    async () => {
      const notices: string[] = [];
      const hookm: Hookm = { onNotice: (notice) => notices.push(notice.message) };
      await withApp(
        {
          hookm: [hookm],
          sql: [
            `create function noisy() returns trigger language plpgsql as $$ begin raise notice 'event %', new.id; return new; end $$`,
            `create trigger noisy after insert on events for each row execute function noisy()`,
          ],
        },
        async ({ db }) => {
          await db.events.insert({ id: "e1", note: "x" });
          await db.tx(async (tx) => {
            await tx.events.insert({ id: "e2", note: "y" });
          });
          await sleep(30);
          expect(notices).toEqual(["event e1", "event e2"]);
        },
      );
    },
  );

  // ── helpers bound to the suite ──────────────────────────────────────────

  /** Starts a transaction that locks one account row and holds it until released. */
  async function holdRow(db: Db, rowId: string): Promise<{ release(): Promise<void> }> {
    const locked = deferred<void>();
    const gate = deferred<void>();
    const done = db.tx(async (tx) => {
      await tx.accounts.find({ where: { id: rowId }, limit: 1, lock: "update" });
      locked.resolve();
      await gate.promise;
    });
    await Promise.race([locked.promise, done]);
    return {
      release: async () => {
        gate.resolve();
        await done;
      },
    };
  }
}

function skipped(test: SuiteTest, reason: string): SuiteTest {
  const register: SuiteTest = (name, fn) => test.skip(`${name} (${reason})`, fn);
  register.skip = (name, fn) => test.skip(`${name} (${reason})`, fn);
  return register;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Deferred<T> = { readonly promise: Promise<T>; resolve(value: T): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A gate that opens when `parties` callers have arrived. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  const open = deferred<void>();
  return () => {
    arrived += 1;
    if (arrived >= parties) open.resolve();
    return open.promise;
  };
}
