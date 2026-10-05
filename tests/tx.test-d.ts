/**
 * `tx`, `batch`, row locks, and the options every call takes are typed by the schema.
 */

import { expectTypeOf } from "expect-type";

import { schema, table, t } from "../src/dialects/pg/index.js";
import type { Connected, TxClient, TxOptions } from "../src/runtime/types.js";
import { tenantApp } from "./presets-schema.js";

const accounts = table("accounts", { id: t.text().primaryKey(), balance: t.integer() });
const app = schema({ casing: "snake", tables: [accounts] });
type Db = Connected<typeof app>;
type Tx = TxClient<typeof app>;
type Has<T, K extends string> = K extends keyof T ? true : false;

// tx returns what the callback returns, with or without options.
void ((db: Db) => {
  const plain = db.tx(async (tx) => tx.accounts.find({ limit: 1 }));
  expectTypeOf(plain).resolves.toExtend<readonly unknown[]>();
  expectTypeOf(plain).resolves.items.toHaveProperty("balance").toEqualTypeOf<number>();
  const counted = db.tx({ isolation: "serializable", retry: 3, timeout: 5_000 }, async () => 7);
  expectTypeOf(counted).resolves.toEqualTypeOf<number>();
});

// The callback's client has the tables, locks, afterCommit, advisoryLock, and nested tx.
expectTypeOf<Has<Tx, "accounts">>().toEqualTypeOf<true>();
expectTypeOf<Tx["afterCommit"]>().parameters.toEqualTypeOf<[fn: () => void | Promise<void>]>();
expectTypeOf<Tx["advisoryLock"]>().returns.toEqualTypeOf<Promise<void>>();
expectTypeOf<Has<Tx, "tx">>().toEqualTypeOf<true>();
expectTypeOf<Has<Tx, "batch">>().toEqualTypeOf<true>();
// It cannot close the pool or open a tenant scope.
expectTypeOf<Has<Tx, "close">>().toEqualTypeOf<false>();
expectTypeOf<Has<Tx, "for">>().toEqualTypeOf<false>();

// Locks are on find inside a transaction only.
void ((tx: Tx) => tx.accounts.find({ limit: 1, lock: "update", wait: "skip" }));
void ((tx: Tx) => tx.accounts.find({ limit: 1, lock: "share", wait: "nowait" }));
// The root client does not list lock. It is refused at run time with OKM1830.
expectTypeOf<Parameters<Db["accounts"]["find"]>[0]>().not.toHaveProperty("lock");
// @ts-expect-error lock is update or share
void ((tx: Tx) => tx.accounts.find({ limit: 1, lock: "exclusive" }));
// @ts-expect-error wait is nowait or skip
void ((tx: Tx) => tx.accounts.find({ limit: 1, lock: "update", wait: "forever" }));

// Every call takes a signal and a timeout.
void ((db: Db) => db.accounts.find({ limit: 1, signal: AbortSignal.abort(), timeout: 100 }));
void ((db: Db) => db.accounts.count({ timeout: 100 }));
void ((db: Db) =>
  db.accounts.update({ where: { id: "a" }, set: { balance: 1 } }, { signal: AbortSignal.abort() }));

// Options are closed.
expectTypeOf<TxOptions["isolation"]>().toEqualTypeOf<
  "read committed" | "repeatable read" | "serializable" | undefined
>();
// @ts-expect-error isolation is one of three levels
void ((db: Db) => db.tx({ isolation: "snapshot" }, async () => 1));
// @ts-expect-error retry is a number
void ((db: Db) => db.tx({ retry: true }, async () => 1));

// batch takes write handles and returns one result per operation, in order.
void (async (db: Db) => {
  const results = await db.batch([
    db.accounts.insert({ id: "a", balance: 1 }),
    db.accounts.update({ where: { id: "a" }, set: { balance: 2 } }),
  ]);
  expectTypeOf(results[0]).toEqualTypeOf<{ readonly id: string; readonly balance: number }>();
  expectTypeOf(results[1]).toEqualTypeOf<{ readonly count: number }>();
  expectTypeOf(results).toHaveProperty("length").toEqualTypeOf<2>();
});
// @ts-expect-error a read is not a write
void ((db: Db) => db.batch([db.accounts.find({ limit: 1 })]));

// A scoped client has tx and batch too, with the same tables.
type Scoped = ReturnType<Connected<typeof tenantApp>["for"]>;
expectTypeOf<Has<Scoped, "tx">>().toEqualTypeOf<true>();
expectTypeOf<Has<Scoped, "batch">>().toEqualTypeOf<true>();
