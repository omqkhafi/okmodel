/**
 * Atomic operators stay on the column they fit, and a claim is `lock: "skip"`.
 */

import { expectTypeOf } from "expect-type";

import { bigint, inc, integer, numeric, schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const jobs = table("jobs", {
  id: text(),
  title: text(),
  status: text(),
  qty: integer(),
  left: integer().nullable(),
  whole: bigint({ as: "bigint" }),
  exact: numeric(12, 2, { as: "number" }),
  digits: numeric(),
  note: text().nullable(),
});

const app = schema({ casing: "snake", tables: [jobs] });

async function shapes(url: string): Promise<void> {
  const db = connect(url, { schema: app });
  await db.jobs.update({ where: { id: "a" }, set: { qty: inc(1), left: inc(1) } });
  await db.jobs.update({ where: { id: "a" }, set: { left: null, whole: inc(1n) } });
  await db.jobs.update({ where: { id: "a" }, set: { exact: inc(1) } });
  await db.jobs.update({
    where: { status: "pending" },
    set: { title: "running" },
    limit: 10,
    lock: "skip",
  });
  const counted = db.jobs.update({
    where: { status: "pending" },
    set: { title: "running" },
    limit: 1,
    lock: "skip",
  });
  expectTypeOf(counted).resolves.toEqualTypeOf<{ readonly count: number }>();
  const rows = db.jobs.update(
    { where: { status: "pending" }, set: { title: "running" }, limit: 1, lock: "skip" },
    { returning: true },
  );
  expectTypeOf(rows).resolves.toEqualTypeOf<
    readonly {
      readonly id: string;
      readonly title: string;
      readonly status: string;
      readonly qty: number;
      readonly left: number | null;
      readonly whole: bigint;
      readonly exact: number;
      readonly digits: string;
      readonly note: string | null;
    }[]
  >();

  // @ts-expect-error text does not take inc
  await db.jobs.update({ where: { id: "a" }, set: { title: inc(1) } });
  // @ts-expect-error a nullable text column does not take inc
  await db.jobs.update({ where: { id: "a" }, set: { note: inc(1) } });
  // @ts-expect-error numeric stored as a string is not a number here
  await db.jobs.update({ where: { id: "a" }, set: { digits: inc(1) } });
  // @ts-expect-error inc takes a number, not null
  await db.jobs.update({ where: { id: "a" }, set: { left: inc(null) } });
  // @ts-expect-error an update lock is skip, not nowait
  await db.jobs.update({ where: { id: "a" }, set: { title: "r" }, limit: 1, lock: "nowait" });
  // @ts-expect-error wait is a read option
  await db.jobs.update({ where: { id: "a" }, set: { title: "running" }, limit: 1, wait: "skip" });

  await db.tx(async (tx) => {
    await tx.jobs.find({ limit: 1, lock: "update", wait: "skip" });
    await tx.jobs.find({
      limit: 1,
      // @ts-expect-error lock skip is an update claim
      lock: "skip",
    });
  });

  expectTypeOf(inc(1)).toMatchTypeOf<{ readonly value: number }>();
}

void shapes;
