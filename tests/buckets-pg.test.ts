/**
 * Aggregate time buckets on real Postgres, on every driver that runs aggregate.
 *
 * PGlite always runs. postgres.js, node-postgres, and Bun.sql run when the
 * topology is up. A missing three-argument `date_trunc` fails the file.
 */

import { expect, test } from "bun:test";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import {
  bucket,
  date,
  inList,
  integer,
  rowNumber,
  schema,
  table,
  text,
  timestamp,
  timestamptz,
  uuid,
} from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";
import type { Connected } from "../src/runtime/types.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";

const orders = table(
  "orders",
  {
    id: uuid().primaryKey(),
    status: text(),
    total: integer(),
    createdAt: timestamptz(),
    at: timestamptz().nullable(),
    openedOn: date(),
    localAt: timestamp().nullable(),
    secret: text().hidden(),
  },
  { traits: [archivable()] },
);

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [orders],
});

type Db = Connected<typeof app>;
type Scoped = ReturnType<Db["for"]>;

const gate = await loadPostgresGate();
const TRUNC = "select date_trunc('hour', timestamptz '2020-01-01 00:00:00+00', 'UTC')";

test("buckets on pglite", async () => {
  const pool = await openPglite();
  try {
    await assertTrunc(() => pool.execute(TRUNC));
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    const db = await connectPglite(pool, { schema: app });
    await db.connected;
    try {
      await prove(db);
    } finally {
      await db.close();
    }
  } finally {
    await pool.close();
  }
}, 60_000);

for (const driver of ["postgres.js", "node-postgres", "bun.sql"] as const) {
  postgresTest(
    gate,
    `buckets on ${driver}`,
    async () => {
      await withPostgresSchema(async (sql, schemaName) => {
        await assertTrunc(() => sql.unsafe(TRUNC));
        for (const statement of renderCatalog(app.catalog, schemaName)) {
          await sql.unsafe(statement);
        }
        const db = openDriver(driver, schemaName);
        await db.connected;
        try {
          await prove(db);
        } finally {
          await db.close();
        }
      });
    },
    60_000,
  );
}

function openDriver(driver: "postgres.js" | "node-postgres" | "bun.sql", schemaName: string): Db {
  const options = { schema: app, searchPath: schemaName, max: 1 };
  if (driver === "postgres.js") return connectPostgres(primaryUrl(), options);
  if (driver === "node-postgres") return connectPg(primaryUrl(), options);
  return connectBun(primaryUrl(), options);
}

async function assertTrunc(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `date_trunc(unit, timestamptz, tz) is not available on this server. Stop. ${message}`,
    );
  }
}

async function prove(db: Db): Promise<void> {
  const a = db.for({ tenantId: TENANT_A });
  const b = db.for({ tenantId: TENANT_B });
  await refusals(a);
  await sharedPrototypeGuard(a);

  const early = await add(a, {
    status: "open",
    total: 10,
    createdAt: at("2026-06-15T20:30:00Z"),
    at: null,
    openedOn: day("2026-03-31"),
  });
  const noon = await add(a, {
    status: "open",
    total: 30,
    createdAt: at("2026-06-15T21:30:45Z"),
    at: at("2026-06-15T21:30:45Z"),
    openedOn: day("2026-04-15"),
  });
  const later = await add(a, {
    status: "shut",
    total: 5,
    createdAt: at("2026-06-15T22:00:00Z"),
    at: null,
    openedOn: day("2026-04-01"),
  });
  const extra = await add(a, {
    status: "open",
    total: 10,
    createdAt: at("2026-06-16T00:00:00Z"),
    at: at("2026-06-15T21:30:45Z"),
    openedOn: day("2026-01-15"),
  });
  await add(b, {
    status: "open",
    total: 99,
    createdAt: at("2026-06-15T21:30:45Z"),
    at: null,
    openedOn: day("2026-04-15"),
  });

  // 21:00Z is midnight in Riyadh (UTC+3). UTC would keep both instants on June 15.
  const riyadh = await a.orders.aggregate({
    groupBy: [bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" })],
    count: true,
    orderBy: { day: "asc" },
    limit: 10,
  });
  expect(riyadh.map((row) => [stamp(row.day), row.count])).toEqual([
    ["2026-06-15", 1],
    ["2026-06-16", 3],
  ]);

  const one = { where: { id: noon }, limit: 5 } as const;
  const units = [
    ["second", "2026-06-15T21:30:45Z"],
    ["minute", "2026-06-15T21:30:00Z"],
    ["hour", "2026-06-15T21:00:00Z"],
  ] as const;
  for (const [unit, expectAt] of units) {
    const rows = await a.orders.aggregate({
      groupBy: [bucket("createdAt", unit, { tz: "Asia/Riyadh", as: "tick" })],
      count: true,
      ...one,
    });
    expect(rows).toHaveLength(1);
    expect(instant(rows[0]?.tick)).toBe(expectAt);
  }
  const dates = [
    ["day", "2026-06-16"],
    ["week", "2026-06-15"],
    ["month", "2026-06-01"],
    ["quarter", "2026-04-01"],
    ["year", "2026-01-01"],
  ] as const;
  for (const [unit, expectDay] of dates) {
    const rows = await a.orders.aggregate({
      groupBy: [bucket("createdAt", unit, { tz: "Asia/Riyadh", as: "period" })],
      count: true,
      ...one,
    });
    expect(stamp(rows[0]?.period)).toBe(expectDay);
  }
  expect(
    stamp(
      (
        await a.orders.aggregate({
          groupBy: [
            bucket("createdAt", "week", { tz: "Asia/Riyadh", as: "period", weekStart: "sunday" }),
          ],
          count: true,
          ...one,
        })
      )[0]?.period,
    ),
  ).toBe("2026-06-14");
  expect(
    stamp(
      (
        await a.orders.aggregate({
          groupBy: [
            bucket("createdAt", "week", {
              tz: "Asia/Riyadh",
              as: "period",
              weekStart: "saturday",
            }),
          ],
          count: true,
          ...one,
        })
      )[0]?.period,
    ),
  ).toBe("2026-06-13");

  await expectWeek(a, "2025-12-27T12:00:00Z", "2025-12-22", "2025-12-21", "2025-12-27");
  await expectWeek(a, "2026-01-01T12:00:00Z", "2025-12-29", "2025-12-28", "2025-12-27");
  await expectWeek(a, "2026-02-28T12:00:00Z", "2026-02-23", "2026-02-22", "2026-02-28");
  await expectWeek(a, "2026-03-01T12:00:00Z", "2026-02-23", "2026-03-01", "2026-02-28");

  const q1 = await add(a, {
    status: "open",
    total: 1,
    createdAt: at("2026-03-31T20:30:00Z"),
    at: null,
    openedOn: day("2026-03-31"),
  });
  const q2 = await add(a, {
    status: "open",
    total: 1,
    createdAt: at("2026-03-31T21:30:00Z"),
    at: null,
    openedOn: day("2026-04-01"),
  });
  expect(await period(a, q1, "quarter")).toBe("2026-01-01");
  expect(await period(a, q2, "quarter")).toBe("2026-04-01");
  const y1 = await add(a, {
    status: "open",
    total: 1,
    createdAt: at("2026-12-31T20:30:00Z"),
    at: null,
    openedOn: day("2026-12-31"),
  });
  const y2 = await add(a, {
    status: "open",
    total: 1,
    createdAt: at("2026-12-31T21:30:00Z"),
    at: null,
    openedOn: day("2026-01-01"),
  });
  expect(await period(a, y1, "year")).toBe("2026-01-01");
  expect(await period(a, y2, "year")).toBe("2027-01-01");

  await expectDays(a, "Europe/London", [
    ["2026-03-28T23:30:00Z", "2026-03-28"],
    ["2026-03-29T00:30:00Z", "2026-03-29"],
    ["2026-03-29T01:30:00Z", "2026-03-29"],
  ]);
  await expectDays(a, "America/New_York", [
    ["2026-03-08T04:30:00Z", "2026-03-07"],
    ["2026-03-08T05:30:00Z", "2026-03-08"],
    ["2026-03-08T07:30:00Z", "2026-03-08"],
    ["2026-11-01T04:30:00Z", "2026-11-01"],
    ["2026-11-01T05:30:00Z", "2026-11-01"],
    ["2026-11-01T06:30:00Z", "2026-11-01"],
    ["2026-11-01T07:30:00Z", "2026-11-01"],
    ["2026-11-02T05:30:00Z", "2026-11-02"],
  ]);
  const firstHour = await add(a, {
    status: "open",
    total: 1,
    createdAt: at("2026-11-01T05:30:00Z"),
    at: null,
    openedOn: day("2026-11-01"),
  });
  const secondHour = await add(a, {
    status: "open",
    total: 1,
    createdAt: at("2026-11-01T06:30:00Z"),
    at: null,
    openedOn: day("2026-11-01"),
  });
  const hours = await a.orders.aggregate({
    where: { id: inList([firstHour, secondHour]) },
    groupBy: [bucket("createdAt", "hour", { tz: "America/New_York", as: "hour" })],
    count: true,
    orderBy: { hour: "asc" },
    limit: 5,
  });
  expect(hours.map((row) => [instant(row.hour), row.count])).toEqual([
    ["2026-11-01T05:00:00Z", 1],
    ["2026-11-01T06:00:00Z", 1],
  ]);

  const nulls = await a.orders.aggregate({
    where: { id: inList([early, noon, later, extra]) },
    groupBy: [bucket("at", "day", { tz: "Asia/Riyadh", as: "day" })],
    count: true,
    orderBy: { day: "asc" },
    limit: 5,
  });
  expect(nulls.map((row) => [row.day === null ? null : stamp(row.day), row.count])).toEqual([
    ["2026-06-16", 2],
    [null, 2],
  ]);

  expect(await period(a, noon, "month", "openedOn")).toBe("2026-04-01");
  const dated = await a.orders
    .aggregate({
      where: { id: noon },
      groupBy: [bucket("openedOn", "month", { as: "month" })],
      count: true,
      limit: 1,
    })
    .sql();
  expect(dated.text.includes("AT TIME ZONE")).toBe(false);
  expect(dated.params.includes("Asia/Riyadh")).toBe(false);

  const isolated = await a.orders.aggregate({
    where: { id: noon },
    groupBy: [bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" })],
    count: true,
    limit: 1,
  });
  expect(stamp(isolated[0]?.day)).toBe("2026-06-16");
  expect(isolated[0]?.count).toBe(1);
  const planned = await a.orders
    .aggregate({
      where: { status: "open" },
      groupBy: [bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" })],
      count: true,
      limit: 10,
    })
    .sql();
  expect(planned.text.split("date_trunc").length - 1).toBe(1);
  expect(planned.text).toContain("group by 1");
  expect(planned.params.filter((param) => param === "Asia/Riyadh")).toEqual(["Asia/Riyadh"]);
  expect(planned.text).toContain('"tenant_id"');
  expect(planned.text).toContain('"archived_at" is null');
  expect(planned.text.includes(TENANT_A)).toBe(false);

  const grouped = await a.orders.aggregate({
    where: { id: inList([early, noon, later, extra]) },
    groupBy: ["status", bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" })],
    sum: ["total"],
    avg: ["total"],
    min: ["total"],
    max: ["total"],
    count: true,
    orderBy: { day: "asc", status: "asc" },
    limit: 10,
  });
  expect(
    grouped.map((row) => [
      row.status,
      stamp(row.day),
      row.count,
      row.sum.total,
      row.avg.total,
      row.min.total,
      row.max.total,
    ]),
  ).toEqual([
    ["open", "2026-06-15", 1, 10, 10, 10, 10],
    ["open", "2026-06-16", 2, 40, 20, 10, 30],
    ["shut", "2026-06-16", 1, 5, 5, 5, 5],
  ]);

  const both = await a.orders.aggregate({
    where: { id: noon },
    groupBy: [
      bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" }),
      bucket("createdAt", "month", { tz: "Asia/Riyadh", as: "month" }),
    ],
    count: true,
    orderBy: { day: "desc" },
    limit: 1,
  });
  expect(stamp(both[0]?.day)).toBe("2026-06-16");
  expect(stamp(both[0]?.month)).toBe("2026-06-01");
  const bothSql = await a.orders
    .aggregate({
      where: { id: noon },
      groupBy: [
        bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" }),
        bucket("createdAt", "month", { tz: "Asia/Riyadh", as: "month" }),
      ],
      count: true,
      limit: 1,
    })
    .sql();
  expect(bothSql.text).toContain("group by 1, 2");
  expect(bothSql.params.filter((param) => param === "Asia/Riyadh")).toHaveLength(2);

  const plain = await a.orders.aggregate({ groupBy: ["status"], count: true, limit: 5 }).sql();
  expect(plain.text).toContain('group by t."status"');
  expect(plain.text.includes("date_trunc")).toBe(false);

  await a.orders.archive({ where: { id: extra } });
  const active = await a.orders.aggregate({
    where: { status: "open" },
    groupBy: [bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" })],
    count: true,
    orderBy: { day: "asc" },
    limit: 10,
  });
  const june16 = active.find((row) => stamp(row.day) === "2026-06-16");
  expect(june16?.count).toBe(1);
  const archived = await a.orders.withArchived().aggregate({
    where: { id: extra },
    groupBy: [bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" })],
    count: true,
    limit: 1,
  });
  expect(stamp(archived[0]?.day)).toBe("2026-06-16");
  expect(archived[0]?.count).toBe(1);
  const wide = await a.orders
    .withArchived()
    .aggregate({
      groupBy: [bucket("createdAt", "day", { tz: "UTC", as: "day" })],
      count: true,
      limit: 1,
    })
    .sql();
  expect(wide.text.includes('"archived_at" is null')).toBe(false);
}

async function refusals(a: Scoped): Promise<void> {
  const forged: unknown = JSON.parse(
    JSON.stringify(bucket("createdAt", "day", { tz: "Asia/Riyadh", as: "day" })),
  );
  const cases: readonly (readonly [string, object])[] = [
    ["forged", { groupBy: [forged], count: true, limit: 1 }],
    ["zone", { groupBy: [bucket("createdAt", "day", { tz: "Not/AZone", as: "day" })], limit: 1 }],
    ["missing zone", { groupBy: [bucket("createdAt", "day", { as: "day" })], limit: 1 }],
    ["timestamp", { groupBy: [bucket("localAt", "day", { tz: "UTC", as: "day" })], limit: 1 }],
    ["date zone", { groupBy: [bucket("openedOn", "month", { tz: "UTC", as: "month" })], limit: 1 }],
    ["date hour", { groupBy: [bucket("openedOn", "hour", { as: "hour" })], limit: 1 }],
    [
      "week start",
      {
        groupBy: [bucket("createdAt", "day", { tz: "UTC", as: "day", weekStart: "sunday" })],
        limit: 1,
      },
    ],
    [
      "bad week",
      {
        groupBy: [
          bucket("createdAt", "week", {
            tz: "UTC",
            as: "week",
            weekStart: "tuesday" as "monday",
          }),
        ],
        limit: 1,
      },
    ],
    [
      "bad unit",
      {
        groupBy: [bucket("createdAt", "fortnight" as "day", { tz: "UTC", as: "day" })],
        limit: 1,
      },
    ],
    ["missing as", { groupBy: [bucket("createdAt", "day", { tz: "UTC", as: "" })], limit: 1 }],
    ...(
      [
        "__proto__",
        "constructor",
        "toString",
        "hasOwnProperty",
        "valueOf",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toLocaleString",
        "__defineGetter__",
        "__defineSetter__",
        "__lookupGetter__",
        "__lookupSetter__",
        "then",
      ] as const
    ).map(
      (key) =>
        [key, { groupBy: [bucket("createdAt", "day", { tz: "UTC", as: key })], limit: 1 }] as const,
    ),
    [
      "clash field",
      {
        groupBy: ["status", bucket("createdAt", "day", { tz: "UTC", as: "status" })],
        limit: 1,
      },
    ],
    [
      "clash bucket",
      {
        groupBy: [
          bucket("createdAt", "day", { tz: "UTC", as: "day" }),
          bucket("createdAt", "month", { tz: "UTC", as: "day" }),
        ],
        limit: 1,
      },
    ],
    ["hidden", { groupBy: [bucket("secret", "day", { tz: "UTC", as: "day" })], limit: 1 }],
  ];
  for (const [name, options] of cases) {
    const error = await caught(a.orders.aggregate(options as never));
    expect(error.code, name).toBe("OKM1120");
    if (name === "timestamp") expect(error.message).toContain("timestamptz");
    if (name === "timestamp") expect(error.message).toContain("date");
    if (name === "hidden") expect(error.message).toContain("hidden");
    if (name === "zone") expect(error.message).toContain("Not/AZone");
    if (
      name === "__proto__" ||
      name === "constructor" ||
      name === "toString" ||
      name === "hasOwnProperty" ||
      name === "valueOf" ||
      name === "isPrototypeOf" ||
      name === "propertyIsEnumerable" ||
      name === "toLocaleString" ||
      name === "__defineGetter__" ||
      name === "__defineSetter__" ||
      name === "__lookupGetter__" ||
      name === "__lookupSetter__" ||
      name === "then"
    ) {
      expect(error.message).toContain(name);
      expect(error.message).toContain("prototype key");
    }
  }
  const probe: { polluted?: boolean } = {};
  expect(probe.polluted).toBeUndefined();
  expect(typeof Object.prototype.valueOf).toBe("function");
  expect(Object.prototype.hasOwnProperty("then")).toBe(false);
}

async function expectWeek(
  a: Scoped,
  instantText: string,
  monday: string,
  sunday: string,
  saturday: string,
): Promise<void> {
  const id = await add(a, {
    status: "open",
    total: 1,
    createdAt: at(instantText),
    at: null,
    openedOn: day("2026-01-01"),
  });
  expect(await week(a, id, "monday")).toBe(monday);
  expect(await week(a, id, "sunday")).toBe(sunday);
  expect(await week(a, id, "saturday")).toBe(saturday);
}

async function week(
  a: Scoped,
  id: string,
  weekStart: "monday" | "sunday" | "saturday",
): Promise<string> {
  const rows = await a.orders.aggregate({
    where: { id },
    groupBy: [bucket("createdAt", "week", { tz: "Asia/Riyadh", as: "period", weekStart })],
    count: true,
    limit: 1,
  });
  return stamp(rows[0]?.period);
}

async function period(
  a: Scoped,
  id: string,
  unit: "month" | "quarter" | "year",
  column: "createdAt" | "openedOn" = "createdAt",
): Promise<string> {
  const spec =
    column === "openedOn"
      ? bucket("openedOn", unit, { as: "period" })
      : bucket("createdAt", unit, { tz: "Asia/Riyadh", as: "period" });
  const rows = await a.orders.aggregate({
    where: { id },
    groupBy: [spec],
    count: true,
    limit: 1,
  });
  return stamp(rows[0]?.period);
}

async function expectDays(
  a: Scoped,
  tz: string,
  pairs: readonly (readonly [string, string])[],
): Promise<void> {
  for (const [instantText, expectDay] of pairs) {
    const id = await add(a, {
      status: "open",
      total: 1,
      createdAt: at(instantText),
      at: null,
      openedOn: day("2026-01-01"),
    });
    const rows = await a.orders.aggregate({
      where: { id },
      groupBy: [bucket("createdAt", "day", { tz, as: "day" })],
      count: true,
      limit: 1,
    });
    expect(stamp(rows[0]?.day), `${tz} ${instantText}`).toBe(expectDay);
  }
}

async function add(
  a: Scoped,
  row: {
    readonly status: string;
    readonly total: number;
    readonly createdAt: Temporal.Instant;
    readonly at: Temporal.Instant | null;
    readonly openedOn: Temporal.PlainDate;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await a.orders.insert({ id, secret: "x", ...row });
  return id;
}

function at(text: string): Temporal.Instant {
  return Temporal.Instant.from(text);
}

function day(text: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(text);
}

function stamp(value: unknown): string {
  return (value as Temporal.PlainDate).toString();
}

function instant(value: unknown): string {
  return (value as Temporal.Instant).toString({ fractionalSecondDigits: 0 });
}

/**
 * Both result-name paths refuse `__proto__`.
 *
 * A path that accepts the name fails this check. The messages are the shared
 * helper's text.
 */
async function sharedPrototypeGuard(a: Scoped): Promise<void> {
  const bucketError = await caught(
    a.orders.aggregate({
      groupBy: [bucket("createdAt", "day", { tz: "UTC", as: "__proto__" })],
      limit: 1,
    }),
  );
  expect(bucketError.message).toBe(
    "bucket as __proto__ is a prototype key. Use another name for the result.",
  );
  let windowError: OkmError | undefined;
  try {
    await a.orders
      .find({
        select: ["id", rowNumber({ orderBy: { id: "asc" }, as: "__proto__" })],
        limit: 1,
      })
      .sql();
  } catch (error) {
    if (error instanceof OkmError) windowError = error;
    else throw error;
  }
  if (windowError === undefined) throw new Error("expected OkmError");
  expect(windowError.message).toBe(
    "rowNumber as __proto__ is a prototype key. Use another name for the result.",
  );
}

async function caught(pending: PromiseLike<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}
