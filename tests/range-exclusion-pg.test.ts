/**
 * Range types, exclusion constraints, and temporal keys on Postgres.
 *
 * Reads return the full range object. Writes accept that object or a
 * `[lower, upper)` tuple. An exclusion add is refused before its lock when
 * rows already overlap.
 */

import { expect, test } from "bun:test";
import postgres from "postgres";

import { OkmError } from "../src/contracts/error.js";
import { catalog } from "../src/contracts/catalog/build.js";
import { schemaDeclarations } from "../src/dialects/pg/declarations.js";
import {
  col,
  isEmpty as emptyExpr,
  lower,
  range as rangeExpr,
  rangeAgg,
  upper,
} from "../src/dialects/pg/expr/index.js";
import { decodeInstant } from "../src/dialects/pg/temporal.js";
import { readRange } from "../src/dialects/pg/range.js";
import {
  adjacent,
  after,
  before,
  contains,
  isEmpty,
  schema,
  t,
  table,
} from "../src/dialects/pg/index.js";
import type { CatalogQuery } from "../src/dialects/pg/introspect.js";
import { introspectSchema } from "../src/dialects/pg/introspect.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { featuresUsed } from "../src/tooling/capabilities/used.js";
import { assertTemporalKeysAvailable } from "../src/tooling/migrate/engine.js";
import { guardExclusion } from "../src/tooling/migrate/exclusion-probe.js";
import { printExpr } from "../src/tooling/migrate/expr-sql.js";
import { checkScratch } from "../src/tooling/migrate/scratch-check.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { emitPull } from "../src/tooling/migrate/pull-emit.js";
import { schemaAdvice } from "../src/tooling/migrate/schema-rules.js";
import type { DriverConnection } from "../src/contracts/driver.js";
import type { Sql } from "postgres";

const gate = await loadPostgresGate();

function wireValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw new Error("probe row was not a wire value");
}

function probing(sql: Sql, seen?: string[]): DriverConnection {
  return {
    execute: async (text, params) => {
      seen?.push(text);
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return {
        rows: [...rows].map((row) =>
          Object.values(row as Record<string, unknown>).map((value) => wireValue(value)),
        ),
        count: rows.length,
        notices: [],
      };
    },
    batch: () => Promise.resolve([]),
    release: () => Promise.resolve(),
  };
}

const span = t.range("span", {
  subtype: t.integer(),
  comment: "a span of integers",
  grants: { app: "read" },
});

function bookings() {
  return schema({
    casing: "snake",
    tables: [
      table(
        "bookings",
        {
          id: t.integer().primaryKey(),
          roomId: t.integer(),
          during: t.tstzrange(),
          active: t.boolean().default(true),
        },
        {
          exclusions: (columns) => ({
            noDouble: {
              on: [
                [columns.roomId, "eq"],
                [columns.during, "overlaps"],
              ],
              where: { active: true },
            },
          }),
        },
      ),
    ],
  });
}

function spans() {
  return schema({
    casing: "snake",
    tables: [
      table("spans", {
        id: t.integer().primaryKey(),
        during: span,
        many: span.multi(),
        listed: span.array(),
      }),
    ],
  });
}

postgresTest(
  gate,
  "proof:type.range a custom range round-trips and reads the full object",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const app = spans();
      await applyPlan(sql, catalog([]), app.catalog, schemaName);
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        await db.spans.insert({
          id: 1,
          during: [1, 10],
          many: [
            [1, 3],
            [5, 7],
          ],
          listed: [[1, 4]],
        });
        await db.spans.insert({
          id: 2,
          during: {
            empty: false,
            lower: null,
            upper: 4,
            lowerInclusive: true,
            upperInclusive: false,
          },
          many: [],
          listed: [],
        });
        const rows = await db.spans.find({ orderBy: { id: "asc" }, limit: 10 });
        expect(rows[0]?.during).toEqual({
          empty: false,
          lower: 1,
          upper: 10,
          lowerInclusive: true,
          upperInclusive: false,
        });
        expect(rows[1]?.during).toEqual({
          empty: false,
          lower: null,
          upper: 4,
          lowerInclusive: false,
          upperInclusive: false,
        });
        expect(rows[0]?.many).toEqual([
          { empty: false, lower: 1, upper: 3, lowerInclusive: true, upperInclusive: false },
          { empty: false, lower: 5, upper: 7, lowerInclusive: true, upperInclusive: false },
        ]);
        expect(Array.isArray(rows[0]?.listed)).toBe(true);
        const live = await introspectSchema(queryOf(sql), schemaName, "public");
        expect(
          planMigration({ before: live, after: app.catalog, schema: schemaName, name: "again" })
            .steps,
        ).toEqual([]);
        const text = emitPull(live, { schemaFile: "schema.ts", tablesDir: "tables" })
          .files.map((file) => file.text)
          .join("\n");
        expect(text).toContain('t.range("span"');
        expect(text).toContain(".multi()");
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "proof:range.operators",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const app = schema({
        casing: "snake",
        tables: [
          table("slots", {
            id: t.integer().primaryKey(),
            during: t.int4range(),
          }),
        ],
      });
      await applyPlan(sql, catalog([]), app.catalog, schemaName);
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        await db.slots.insert([
          { id: 1, during: [1, 5] },
          { id: 2, during: [5, 9] },
          { id: 3, during: { empty: true } },
        ]);
        const held = await db.slots.find({ where: { during: contains(3) }, limit: 5 });
        expect(held.map((row) => row.id)).toEqual([1]);
        const covered = await db.slots.find({
          where: { during: contains([1, 4] as const) },
          limit: 5,
        });
        expect(covered.map((row) => row.id)).toEqual([1]);
        const next = await db.slots.find({
          where: { during: adjacent([1, 5] as const) },
          limit: 5,
        });
        expect(next.map((row) => row.id)).toEqual([2]);
        const earlier = await db.slots.find({
          where: { during: before([6, 8] as const) },
          limit: 5,
        });
        expect(earlier.map((row) => row.id)).toEqual([1]);
        const later = await db.slots.find({ where: { during: after([0, 1] as const) }, limit: 5 });
        expect(later.map((row) => row.id)).toEqual([1, 2]);
        const empty = await db.slots.find({ where: { during: isEmpty() }, limit: 5 });
        expect(empty.map((row) => row.id)).toEqual([3]);
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "proof:constraint.exclusion",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const app = bookings();
      const steps = planMigration({
        before: catalog([]),
        after: app.catalog,
        schema: schemaName,
        name: "create",
      }).steps.map((step) => step.sql);
      expect(steps.some((statement) => statement.includes("btree_gist"))).toBe(true);
      expect(steps.some((statement) => /exclude using gist/i.test(statement))).toBe(true);
      expect(
        steps.some((statement) => statement.includes("44.7") || statement.includes("blocking")),
      ).toBe(false);
      const exclusion = steps.find((statement) => /exclude using gist/i.test(statement));
      expect(exclusion).toContain('"room_id" with =');
      expect(exclusion).toContain('"during" with &&');
      await apply(
        sql,
        steps.map((statement) =>
          statement.startsWith("create extension ")
            ? statement.replace("create extension ", "create extension if not exists ")
            : statement,
        ),
      );
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      const holder = postgres(primaryUrl(), { max: 1, onnotice: () => {} });
      const waiter = postgres(primaryUrl(), { max: 1, onnotice: () => {} });
      try {
        await db.connected;
        const start = Temporal.Instant.from("2024-01-01T00:00:00Z");
        const end = Temporal.Instant.from("2024-01-02T00:00:00Z");
        await db.bookings.insert({ id: 1, roomId: 7, during: [start, end], active: true });
        const conflict = await db.bookings
          .insert({
            id: 2,
            roomId: 7,
            during: [
              Temporal.Instant.from("2024-01-01T12:00:00Z"),
              Temporal.Instant.from("2024-01-03T00:00:00Z"),
            ],
            active: true,
          })
          .catch((error: unknown) => error);
        expect(conflict).toBeInstanceOf(OkmError);
        expect((conflict as OkmError).kind).toBe("exclusion");
        expect((conflict as OkmError).message).toContain("bookings_noDouble_excl");
        const skipped = await sql.unsafe(
          `insert into bookings (id, room_id, during, active) values (4, 7, tstzrange('2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', '[)'), true) on conflict on constraint "bookings_noDouble_excl" do nothing returning id`,
        );
        expect(skipped.length).toBe(0);
        await holder.unsafe(`set search_path to ${schemaName}`);
        await waiter.unsafe(`set search_path to ${schemaName}`);
        await waiter.unsafe("set lock_timeout to '5s'");
        await holder.unsafe("begin");
        await holder.unsafe(
          `insert into bookings (id, room_id, during, active) values (8, 9, tstzrange('2024-03-01T00:00:00Z', '2024-03-02T00:00:00Z', '[)'), true)`,
        );
        // postgres.js sends a query when the promise is attached. Attach it before
        // the commit so this session waits on the open row, then loses with 23P01.
        const waiting = waiter
          .unsafe(
            `insert into bookings (id, room_id, during, active) values (9, 9, tstzrange('2024-03-01T12:00:00Z', '2024-03-03T00:00:00Z', '[)'), true)`,
          )
          .catch((error: unknown) => error);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await holder.unsafe("commit");
        const waited = await waiting;
        expect(waited).toBeInstanceOf(Error);
        expect((waited as Error).message).toContain("bookings_noDouble_excl");
        await sql.unsafe(
          `create table later (id integer primary key, room_id integer, during tstzrange)`,
        );
        await sql.unsafe(
          `alter table later add constraint later_one_excl exclude using gist (room_id with =, during with &&) deferrable initially deferred`,
        );
        await holder.unsafe("begin");
        await holder.unsafe(
          `insert into later values (1, 1, tstzrange('2024-04-01T00:00:00Z', '2024-04-02T00:00:00Z', '[)'))`,
        );
        await holder.unsafe(
          `insert into later values (2, 1, tstzrange('2024-04-01T12:00:00Z', '2024-04-03T00:00:00Z', '[)'))`,
        );
        const deferred = await holder.unsafe("commit").catch((error: unknown) => error);
        expect(deferred).toBeInstanceOf(Error);
        expect((deferred as Error).message).toContain("later_one_excl");
      } finally {
        await holder.end({ timeout: 5 });
        await waiter.end({ timeout: 5 });
        await db.close();
      }

      const tenant = schema({
        casing: "snake",
        tenancy: columnTenancy({ key: "tenantId", type: "int" }),
        tables: [
          table(
            "rooms",
            {
              id: t.integer().primaryKey(),
              during: t.tstzrange(),
            },
            {
              exclusions: (columns) => ({
                one: { on: [[columns.during, "overlaps"]] },
              }),
            },
          ),
        ],
      });
      const tenantSql = planMigration({
        before: catalog([]),
        after: tenant.catalog,
        schema: schemaName,
        name: "tenant",
      }).steps.map((step) => step.sql);
      const line = tenantSql.find((statement) => /exclude using gist/i.test(statement));
      expect(line).toContain('"tenant_id" with =');
    });
  },
  60_000,
);

postgresTest(
  gate,
  "an exclusion pre-check stops before the lock and reports the count",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table bookings (id integer primary key, room_id integer, during tstzrange)`,
      );
      await sql.unsafe(
        `insert into bookings values (1, 1, '[2024-01-01,2024-01-02)'::tstzrange), (2, 1, '[2024-01-01,2024-01-03)'::tstzrange)`,
      );
      const statement = `alter table "${schemaName}"."bookings" add constraint "bookings_one_excl" exclude using gist ("room_id" with =, "during" with &&)`;
      const seen: string[] = [];
      const connection = probing(sql, seen);
      const error = await guardExclusion(connection, statement).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OkmError);
      expect((error as OkmError).code).toBe("OKM1922");
      expect((error as OkmError).message).toContain("Nothing was changed.");
      expect(seen.some((text) => /exclude using gist/i.test(text))).toBe(false);
      expect(seen.some((text) => text.startsWith("select count(*)"))).toBe(true);
      const constraints = await sql<{ name: string }[]>`
      select conname as name from pg_constraint where conname = 'bookings_one_excl'
    `;
      expect(constraints.length).toBe(0);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "proof:comment.range",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const noted = t.range("span", {
        subtype: t.integer(),
        comment: "a span of integers",
        grants: { app: "read" },
      });
      const app = schema({
        tables: [table("marks", { id: t.integer().primaryKey(), during: noted })],
      });
      expect(featuresUsed(app.catalog)).toContain("comment.range");
      await applyPlan(sql, catalog([]), app.catalog, schemaName);
      const live = await introspectSchema(queryOf(sql), schemaName, "public");
      const type = live.objects.find(
        (object) => object.kind === "type" && object.identity.name === "span",
      );
      expect(type?.comment).toBe("a span of integers");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "proof:temporal.keys",
  async () => {
    const temporal = schema({
      casing: "snake",
      tables: [
        table(
          "rooms",
          {
            id: t.integer(),
            available: t.tstzrange(),
          },
          { primaryKey: { columns: ["id", "available"], withoutOverlaps: true } },
        ),
        table(
          "bookings",
          {
            roomId: t.integer(),
            during: t.tstzrange(),
          },
          {
            primaryKey: { columns: ["roomId", "during"], withoutOverlaps: true },
            foreignKeys: () => ({
              room: {
                columns: ["roomId", "during"],
                references: { table: "rooms", columns: ["id", "available"] },
                period: true,
              },
            }),
          },
        ),
      ],
    });
    const text = planMigration({
      before: catalog([]),
      after: temporal.catalog,
      schema: "public",
      name: "temporal",
    })
      .steps.map((step) => step.sql)
      .join("\n");
    expect(text).toContain("without overlaps");
    expect(text).toContain('period "during"');
    await withPostgresSchema(async (sql, schemaName) => {
      const steps = planMigration({
        before: catalog([]),
        after: temporal.catalog,
        schema: schemaName,
        name: "temporal",
      }).steps;
      const version = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
      const major = Math.floor(Number(version[0]?.v ?? "0") / 10_000);
      const error = await assertTemporalKeysAvailable(probing(sql), [
        { id: "temporal", steps },
      ]).catch((caught: unknown) => caught);
      if (major < 18) {
        expect(error).toBeInstanceOf(OkmError);
        expect((error as OkmError).code).toBe("OKM1812");
        expect((error as OkmError).message).toContain("exclusion");
        expect((error as OkmError).message).toContain("Nothing was changed.");
        return;
      }
      expect(error).toBeUndefined();
      for (const step of steps) await sql.unsafe(step.sql);
      await sql.unsafe(
        `insert into rooms (id, available) values (1, tstzrange('2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', '[)'))`,
      );
      await sql.unsafe(
        `insert into bookings (room_id, during) values (1, tstzrange('2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', '[)'))`,
      );
      const overlap = await sql
        .unsafe(
          `insert into rooms (id, available) values (1, tstzrange('2024-01-01T12:00:00Z', '2024-01-03T00:00:00Z', '[)'))`,
        )
        .catch((caught: unknown) => caught);
      expect(overlap).toMatchObject({ code: "23P01" });
    });
  },
  30_000,
);

test("a declared floor below 18 refuses a temporal key before SQL", () => {
  expect(() =>
    schema({
      minPostgres: 17,
      tables: [
        table(
          "bookings",
          { roomId: t.integer(), during: t.tstzrange() },
          { primaryKey: { columns: ["roomId", "during"], withoutOverlaps: true } },
        ),
      ],
    }),
  ).toThrow(/OKM1812|exclusion/i);
});

test("a start and end pair without an order check warns OKM2128", () => {
  const built = schema({
    tables: [
      table(
        "holds",
        {
          id: t.identity(),
          startsAt: t.timestamptz(),
          endsAt: t.timestamptz(),
        },
        {
          exclusions: (columns) => ({
            one: { on: [[rangeExpr(columns.startsAt, columns.endsAt), "overlaps"]] },
          }),
        },
      ),
    ],
  });
  const codes = schemaAdvice({ catalog: built.catalog, model: built.model }, [], {}).advice.map(
    (item) => item.code,
  );
  expect(codes).toContain("OKM2128");
  const printed = planMigration({
    before: catalog([]),
    after: built.catalog,
    name: "holds",
  }).steps.map((step) => step.sql);
  expect(printed.join("\n")).toContain("tstzrange(");
  expect(printed.join("\n")).not.toContain("FOR PORTION OF");
});

postgresTest(
  gate,
  "range() lower() upper() isEmpty() and rangeAgg() run on the server",
  async () => {
    let handles:
      | {
          startsAt: { readonly name: string; readonly dataType?: string };
          endsAt: { readonly name: string; readonly dataType?: string };
        }
      | undefined;
    const app = schema({
      casing: "snake",
      tables: [
        table(
          "visits",
          {
            startsAt: t.timestamptz(),
            endsAt: t.timestamptz(),
            during: t.tstzrange(),
          },
          {
            indexes: (columns) => {
              handles = columns;
              return [];
            },
          },
        ),
      ],
    });
    if (handles === undefined) throw new Error("visits indexes did not run");
    const on = { schema: app, table: "visits" } as const;
    const built = rangeExpr(handles.startsAt, handles.endsAt);
    type Span = {
      readonly empty: boolean;
      readonly lower: string | null;
      readonly upper: string | null;
      readonly lowerInclusive: boolean;
      readonly upperInclusive: boolean;
    };
    const during = col<Span>("during");
    const printed = {
      range: await printExpr(built, on),
      lower: await printExpr(lower(during), on),
      upper: await printExpr(upper(during), on),
      empty: await printExpr(emptyExpr(during), on),
      agg: await printExpr(rangeAgg(during), on),
    };
    expect(printed.range).toContain("tstzrange(");
    expect(printed.empty).toContain("isempty(");
    expect(printed.agg).toContain("range_agg(");
    await withPostgresSchema(async (sql) => {
      await sql.unsafe(
        `create table visits (starts_at timestamptz, ends_at timestamptz, during tstzrange)`,
      );
      await sql.unsafe(
        `insert into visits values ('2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', tstzrange('2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', '[)')), ('2024-01-03T00:00:00Z', '2024-01-04T00:00:00Z', tstzrange('2024-01-03T00:00:00Z', '2024-01-04T00:00:00Z', '[)'))`,
      );
      const row = await sql.unsafe(
        `select (${printed.range})::text as during, ${printed.empty} as empty, ${printed.lower}::text as low, ${printed.upper}::text as high from visits limit 1`,
      );
      expect(String(row[0]?.during)).toContain("[");
      expect(row[0]?.empty).toBe(false);
      expect(String(row[0]?.low)).toContain("2024");
      expect(String(row[0]?.high)).toContain("2024");
      const agg = await sql.unsafe(`select (${printed.agg})::text as span from visits`);
      expect(String(agg[0]?.span).startsWith("{")).toBe(true);
    });
    const create = `create table visits (starts_at timestamptz, ends_at timestamptz, during tstzrange)`;
    const immutable = await checkScratch([
      create,
      `alter table visits add column g tstzrange generated always as (${printed.range}) stored`,
    ]);
    expect(immutable).toEqual({ ok: true });
    const aggregate = await checkScratch([
      create,
      `alter table visits add column g tstzmultirange generated always as (${printed.agg}) stored`,
    ]);
    expect(aggregate.ok).toBe(false);
  },
  30_000,
);

postgresTest(
  gate,
  "an exclusion add and a range swap take AccessExclusiveLock",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const app = bookings();
      const plan = planMigration({
        before: catalog([]),
        after: app.catalog,
        schema: schemaName,
        name: "lock",
      });
      const exclusion = plan.steps.find((step) => /exclude using gist/i.test(step.sql));
      expect(exclusion?.weight).toBe("blocking");
      if (exclusion === undefined) throw new Error("no exclusion step");
      for (const step of plan.steps) {
        if (step === exclusion) break;
        const statement = step.sql.startsWith("create extension ")
          ? step.sql.replace("create extension ", "create extension if not exists ")
          : step.sql;
        await sql.unsafe(statement);
      }
      await sql.unsafe("begin");
      await sql.unsafe(exclusion.sql);
      const locks = await sql<{ mode: string }[]>`
      select mode from pg_locks
      where relation = ${`${schemaName}.bookings`}::regclass and pid = pg_backend_pid()
    `;
      expect(locks.some((row) => row.mode === "AccessExclusiveLock")).toBe(true);
      await sql.unsafe("rollback");

      const before = schema({
        tables: [
          table("marks", {
            id: t.integer().primaryKey(),
            during: t.range("span", { subtype: t.integer() }),
          }),
        ],
      });
      await applyPlan(sql, catalog([]), before.catalog, schemaName);
      await sql.unsafe(`insert into marks (id, during) values (1, '[1,5)')`);
      const after = schema({
        tables: [
          table("marks", {
            id: t.integer().primaryKey(),
            during: t.range("span", { subtype: t.bigint() }),
          }),
        ],
      });
      const swapPlan = planMigration({
        before: before.catalog,
        after: after.catalog,
        schema: schemaName,
        name: "swap",
        confirmTypeChanges: true,
      });
      const swap = swapPlan.steps.find((step) => step.sql.includes("::text::"));
      expect(swap?.weight).toBe("rewrite");
      if (swap === undefined) throw new Error("no range swap");
      for (const step of swapPlan.steps) {
        if (step === swap) break;
        await sql.unsafe(step.sql);
      }
      await sql.unsafe("begin");
      const nodeBefore = await sql<{ node: string }[]>`
      select relfilenode::text as node from pg_class where oid = ${`${schemaName}.marks`}::regclass
    `;
      await sql.unsafe(swap.sql);
      const held = await sql<{ mode: string }[]>`
      select mode from pg_locks
      where relation = ${`${schemaName}.marks`}::regclass and pid = pg_backend_pid()
    `;
      const nodeAfter = await sql<{ node: string }[]>`
      select relfilenode::text as node from pg_class where oid = ${`${schemaName}.marks`}::regclass
    `;
      expect(held.some((row) => row.mode === "AccessExclusiveLock")).toBe(true);
      expect(nodeBefore[0]?.node).not.toBe(nodeAfter[0]?.node);
      await sql.unsafe("rollback");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a tstzrange bound decodes a +03 offset",
  async () => {
    await withPostgresSchema(async (sql) => {
      await sql.unsafe(`create table marks (during tstzrange)`);
      await sql.unsafe(`set time zone 'Asia/Riyadh'`);
      await sql.unsafe(
        `insert into marks values (tstzrange('2020-01-01 00:00:00+03', '2020-01-02 00:00:00+03', '[)'))`,
      );
      const rows = await sql<{ during: string }[]>`select during::text as during from marks`;
      const wire = rows[0]?.during ?? "";
      expect(wire).toContain("+03");
      const decoded = readRange(wire, decodeInstant, true);
      if (decoded.empty || decoded.lower === null) throw new Error("range was empty");
      expect(decoded.lower.toString()).toBe("2019-12-31T21:00:00Z");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a renamed range moves the multirange and a partition column is required",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const first = schema({
        tables: [table("marks", { id: t.integer().primaryKey(), during: span })],
      });
      await applyPlan(sql, catalog([]), first.catalog, schemaName);
      const renamed = t.range("measure", { subtype: t.integer(), renamedFrom: "span" });
      const next = schema({
        tables: [table("marks", { id: t.integer().primaryKey(), during: renamed })],
      });
      const plan = planMigration({
        before: first.catalog,
        after: next.catalog,
        schema: schemaName,
        name: "rename",
        renames: schemaDeclarations({
          tables: [table("marks", { id: t.integer().primaryKey(), during: renamed })],
          casing: undefined,
        }).renames,
      });
      expect(plan.steps.map((step) => step.sql).join("\n")).toContain("rename to");
      await sql.unsafe(
        `create table parts (room_id integer, during tstzrange) partition by list (room_id)`,
      );
      const statement = `alter table "${schemaName}"."parts" add constraint "parts_one_excl" exclude using gist ("during" with &&)`;
      const error = await guardExclusion(probing(sql), statement).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(OkmError);
      expect((error as OkmError).message).toContain("room_id");
    });
  },
  60_000,
);

async function applyPlan(
  sql: Sql,
  before: ReturnType<typeof catalog>,
  after: ReturnType<typeof catalog>,
  schemaName: string,
): Promise<void> {
  const plan = planMigration({ before, after, schema: schemaName, name: "apply" });
  await apply(
    sql,
    plan.steps.map((step) => step.sql),
  );
}

async function apply(sql: Sql, statements: readonly string[]): Promise<void> {
  for (const statement of statements) await sql.unsafe(statement);
}

function queryOf(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}
