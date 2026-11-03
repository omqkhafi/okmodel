/**
 * Date and time columns in `iso`, `date`, and `temporal` mode on real Postgres (D321).
 *
 * One table holds every date and time type. Each mode inserts, reads, updates,
 * filters, orders, buckets, and aggregates it. `iso` and `temporal` keep
 * microseconds. `date` keeps milliseconds. `now()` defaults and update
 * stamping are SQL, so they work the same in every mode.
 */

import { expect, test } from "bun:test";

import { catalogHash } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import {
  between,
  bucket,
  date,
  eq,
  gt,
  id,
  inList,
  interval,
  lt,
  schema,
  table,
  text,
  time,
  timestamp,
  timestamptz,
  timetz,
} from "../src/dialects/pg/index.js";
import { timestamps, trait } from "../src/runtime/traits/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const gate = await loadPostgresGate();
const T = globalThis.Temporal;

const events = table("events", {
  id: id({ default: "uuidv4" }),
  at: timestamptz(),
  at3: timestamptz(3).nullable(),
  local: timestamp().nullable(),
  day: date().nullable(),
  clock: time().nullable(),
  clockTz: timetz().nullable(),
  span: interval().nullable(),
  made: timestamptz().defaultNow(),
  tagged: timestamptz({ mode: "iso" }).defaultSql("now()"),
});

const labeled = trait("labeled", {
  fields: { label: text().nullable(), labeledAt: timestamptz().defaultNow() },
  touch: ["labeledAt"],
});
const notes = table(
  "notes",
  { id: id({ default: "uuidv4" }), body: text() },
  {
    traits: [timestamps(), labeled],
  },
);
const pinned = table(
  "pinned",
  { id: id({ default: "uuidv4" }), body: text() },
  { traits: [timestamps({ enforce: "trigger" })] },
);

const modes = ["iso", "date", "temporal"] as const;
type Mode = (typeof modes)[number];
const apps = {
  iso: schema({ casing: "snake", tables: [events, notes, pinned] }),
  date: schema({ casing: "snake", tables: [events, notes, pinned], defaults: { time: "date" } }),
  temporal: schema({
    casing: "snake",
    tables: [events, notes, pinned],
    defaults: { time: "temporal" },
  }),
} as const;

/** Two rows per mode. The second is the later one in every column. */
function rows(mode: Mode): readonly Record<string, unknown>[] {
  if (mode === "iso") {
    return [
      {
        at: "2026-11-03T09:00:53.582634Z",
        at3: "2026-11-03 14:30:53.5+05:30",
        local: "2026-11-03T09:00:53.582634",
        day: "2026-11-03",
        clock: "09:00:53.582634",
        clockTz: "09:00:53.5+05:30",
        span: "1 day 02:00:00",
      },
      {
        at: "2026-11-04T10:00:00Z",
        at3: "2026-11-04T10:00:00.25Z",
        local: "2026-11-04T10:00:00",
        day: "2026-11-04",
        clock: "10:00",
        clockTz: "10:00:00-08",
        span: "3 days",
      },
    ];
  }
  if (mode === "date") {
    return [
      {
        at: new Date("2026-11-03T09:00:53.582Z"),
        at3: new Date("2026-11-03T09:00:53.5Z"),
        local: new Date("2026-11-03T09:00:53.582Z"),
        day: new Date("2026-11-03"),
        clock: "09:00:53.582634",
        clockTz: "09:00:53.5+05:30",
        span: "1 day 02:00:00",
      },
      {
        at: new Date("2026-11-04T10:00:00Z"),
        at3: new Date("2026-11-04T10:00:00.25Z"),
        local: new Date("2026-11-04T10:00:00Z"),
        day: new Date("2026-11-04"),
        clock: "10:00",
        clockTz: "10:00:00-08",
        span: "3 days",
      },
    ];
  }
  return [
    {
      at: T.Instant.from("2026-11-03T09:00:53.582634Z"),
      at3: T.Instant.from("2026-11-03T09:00:53.5Z"),
      local: T.PlainDateTime.from("2026-11-03T09:00:53.582634"),
      day: T.PlainDate.from("2026-11-03"),
      clock: T.PlainTime.from("09:00:53.582634"),
      clockTz: { time: T.PlainTime.from("09:00:53.5"), offset: "+05:30" },
      span: T.Duration.from("P1DT2H"),
    },
    {
      at: T.Instant.from("2026-11-04T10:00:00Z"),
      at3: T.Instant.from("2026-11-04T10:00:00.25Z"),
      local: T.PlainDateTime.from("2026-11-04T10:00:00"),
      day: T.PlainDate.from("2026-11-04"),
      clock: T.PlainTime.from("10:00"),
      clockTz: { time: T.PlainTime.from("10:00"), offset: "-08:00" },
      span: T.Duration.from("P3D"),
    },
  ];
}

/** What the first row reads back as, one comparable string per field. */
const firstRead: Readonly<Record<Mode, Readonly<Record<string, string>>>> = {
  iso: {
    at: "2026-11-03T09:00:53.582634Z",
    at3: "2026-11-03T09:00:53.500000Z",
    local: "2026-11-03T09:00:53.582634",
    day: "2026-11-03",
    clock: "09:00:53.582634",
    clockTz: "09:00:53.5+05:30",
    span: "1 day 02:00:00",
  },
  date: {
    at: "Date 2026-11-03T09:00:53.582Z",
    at3: "Date 2026-11-03T09:00:53.500Z",
    local: "Date 2026-11-03T09:00:53.582Z",
    day: "Date 2026-11-03T00:00:00.000Z",
    clock: "09:00:53.582634",
    clockTz: "09:00:53.5+05:30",
    span: "1 day 02:00:00",
  },
  temporal: {
    at: "Temporal.Instant 2026-11-03T09:00:53.582634Z",
    at3: "Temporal.Instant 2026-11-03T09:00:53.5Z",
    local: "Temporal.PlainDateTime 2026-11-03T09:00:53.582634",
    day: "Temporal.PlainDate 2026-11-03",
    clock: "Temporal.PlainTime 09:00:53.582634",
    clockTz: "09:00:53.5+05:30",
    span: "Temporal.Duration P1DT2H",
  },
};

function shown(value: unknown): string {
  if (value instanceof Date) return `Date ${value.toISOString()}`;
  if (typeof value === "object" && value !== null) {
    const tag: unknown = Reflect.get(value, Symbol.toStringTag);
    const text = (value as { toString(): string }).toString();
    if (typeof tag === "string" && tag.startsWith("Temporal.")) return `${tag} ${text}`;
    const zoned = value as { time?: { toString(): string }; offset?: string };
    if (zoned.time !== undefined) return `${zoned.time.toString()}${zoned.offset ?? ""}`;
  }
  return String(value);
}

test("the mode is client only: catalog, hash, and SQL do not change", () => {
  const hashes = modes.map((mode) => catalogHash(apps[mode].catalog));
  expect(new Set(hashes).size).toBe(1);
  const ddl = modes.map((mode) => renderCatalog(apps[mode].catalog, "public").join("\n"));
  expect(new Set(ddl).size).toBe(1);
  expect(apps.temporal.codecs.timestamps).toBe("temporal");
  expect(apps.iso.codecs.timestamps).toBe("iso");
});

test("defaultNow() is defaultSql('now()'): same catalog and hash", () => {
  const a = schema({ tables: [table("a", { id: id(), at: timestamptz().defaultNow() })] });
  const b = schema({ tables: [table("a", { id: id(), at: timestamptz().defaultSql("now()") })] });
  expect(catalogHash(a.catalog)).toBe(catalogHash(b.catalog));
  expect(timestamp().defaultNow().state.defaultSql).toBe("now()");
  expect(date().defaultNow().state.defaultSql).toBe("now()");
  for (const wrong of [() => time().defaultNow(), () => text().defaultNow()]) {
    expect(codeOf(wrong)).toBe("OKM1060");
  }
});

test("a Date or Temporal literal default is refused with the defaultNow() hint", () => {
  for (const frozen of [
    () => timestamptz({ mode: "date" }).default(new Date()),
    () => timestamptz({ mode: "temporal" }).default(T.Instant.from(new Date().toISOString())),
    () => date({ mode: "temporal" }).default(T.PlainDate.from("2020-01-01")),
  ]) {
    let error: unknown;
    try {
      frozen();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OkmError);
    expect((error as OkmError).code).toBe("OKM1060");
    expect((error as OkmError).message).toContain(
      "use .defaultNow() for the database time or .default(() => ...) for a client value".replace(
        "use",
        "Use",
      ),
    );
  }
  expect(timestamptz().default("2020-01-01T00:00:00Z").state.defaultSql).toBe(
    "'2020-01-01T00:00:00Z'",
  );
});

test("a malformed iso value is OKM1210 before the database sees it", () => {
  for (const [column, value] of [
    [timestamptz(), "2026-11-03 09:00"],
    [timestamptz(), "yesterday"],
    [timestamp(), "2026-11-03T09:00:00Z"],
    [date(), "03/11/2026"],
    [time(), "9am"],
    [timetz(), "09:00:00"],
  ] as const) {
    expect(codeOf(() => column.encode(value as never))).toBe("OKM1210");
  }
  expect(codeOf(() => timestamptz({ mode: "date" }).encode(new Date("nope") as never))).toBe(
    "OKM1210",
  );
});

for (const mode of modes) {
  postgresTest(gate, `every date and time type round-trips in ${mode} mode`, async () => {
    const app = apps[mode];
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const db = loose(
        connect(open({ url: primaryUrl(), searchPath: schemaName }), { schema: app }),
      );
      try {
        const [first, second] = rows(mode) as [Record<string, unknown>, Record<string, unknown>];
        const inserted = await db.events.insert(first as never);
        await db.events.insert(second as never);
        for (const [field, expected] of Object.entries(firstRead[mode])) {
          expect({ field, value: shown(inserted[field]) }).toEqual({ field, value: expected });
        }
        // `{ mode }` on the column wins over the schema default.
        expect(typeof inserted.tagged).toBe("string");
        expect(shown(inserted.made)).toMatch(
          mode === "iso"
            ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/
            : mode === "date"
              ? /^Date /
              : /^Temporal\.Instant /,
        );

        const read = await db.events.find({
          where: { at: eq(first.at) } as never,
          limit: 1,
        });
        expect(read.length).toBe(1);
        for (const [field, expected] of Object.entries(firstRead[mode])) {
          expect({ field, value: shown(read[0]?.[field]) }).toEqual({ field, value: expected });
        }

        const ordered = await db.events.find({
          orderBy: { at: "desc" },
          limit: 2,
        } as never);
        expect(shown(ordered[0]?.day)).toBe(shown((await readDay(db, second.at))[0]?.day));

        for (const where of [
          { at: lt(second.at) },
          { at: gt(first.at), local: gt(first.local) },
          { day: between(first.day, first.day) },
          { at: inList([first.at]) },
          { day: eq(first.day) },
        ]) {
          const found = await db.events.find({ where: where as never, limit: 5 });
          expect({ where: Object.keys(where), count: found.length }).toEqual({
            where: Object.keys(where),
            count: 1,
          });
        }

        await db.events.update({
          where: { at: eq(first.at) } as never,
          set: { day: second.day, local: second.local } as never,
        });
        const moved = await db.events.find({
          where: { day: eq(second.day) } as never,
          limit: 5,
        });
        expect(moved.length).toBe(2);

        const groups = await db.events.aggregate({
          groupBy: [bucket("at", "day", { tz: "UTC", as: "period" })],
          count: true,
          min: ["at"],
          max: ["local"],
          limit: 5,
        } as never);
        const periods = groups.map((group) => shown(group.period)).toSorted();
        expect(periods).toEqual(
          mode === "iso"
            ? ["2026-11-03", "2026-11-04"]
            : mode === "date"
              ? ["Date 2026-11-03T00:00:00.000Z", "Date 2026-11-04T00:00:00.000Z"]
              : ["Temporal.PlainDate 2026-11-03", "Temporal.PlainDate 2026-11-04"],
        );
        const early = groups.find((group) => shown(group.period).includes("11-03"));
        expect(shown((early?.min as Record<string, unknown> | undefined)?.at)).toBe(
          firstRead[mode].at ?? "",
        );
        const clock = await db.events.aggregate({
          groupBy: [bucket("at", "hour", { tz: "UTC", as: "hour" })],
          count: true,
          limit: 5,
        } as never);
        expect(clock.map((group) => shown(group.hour)).toSorted()[0]).toBe(
          mode === "iso"
            ? "2026-11-03T09:00:00.000000Z"
            : mode === "date"
              ? "Date 2026-11-03T09:00:00.000Z"
              : "Temporal.Instant 2026-11-03T09:00:00Z",
        );
      } finally {
        await db.close();
      }
    });
  });

  postgresTest(gate, `now() defaults and update stamps work in ${mode} mode`, async () => {
    const app = apps[mode];
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const db = loose(
        connect(open({ url: primaryUrl(), searchPath: schemaName }), { schema: app }),
      );
      try {
        const kind = mode === "iso" ? "string" : "object";
        for (const name of ["notes", "pinned"] as const) {
          const made = await db[name].insert({ body: "a" } as never);
          expect(typeof made.createdAt).toBe(kind);
          expect(shown(made.createdAt)).toBe(shown(made.updatedAt));
          await sql.unsafe(`select pg_sleep(0.01)`);
          await db[name].update({ where: { id: made.id } as never, set: { body: "b" } as never });
          const [after] = await db[name].find({
            where: { id: made.id } as never,
            limit: 1,
          });
          expect(shown(after?.createdAt)).toBe(shown(made.createdAt));
          expect(shown(after?.updatedAt)).not.toBe(shown(made.updatedAt));
          if (name === "notes") {
            expect(typeof after?.labeledAt).toBe(kind);
            expect(shown(after?.labeledAt)).not.toBe(shown(made.labeledAt));
          }
        }
        // A writer that bypasses the client still moves updatedAt under the trigger.
        await sql.unsafe(`update ${schemaName}.pinned set body = 'c'`);
      } finally {
        await db.close();
      }
    });
  });

  postgresTest(gate, `a client default returns the ${mode} type`, async () => {
    const value =
      mode === "iso"
        ? () => "2020-01-01T00:00:00Z"
        : mode === "date"
          ? () => new Date("2020-01-01T00:00:00Z")
          : () => T.Instant.from("2020-01-01T00:00:00Z");
    const wrong = mode === "iso" ? () => new Date() : () => "2020-01-01T00:00:00Z";
    const stamped = table("stamped", {
      id: id({ default: "uuidv4" }),
      at: timestamptz({ mode }).default(value as never),
      bad: timestamptz({ mode }).nullable(),
    });
    const broken = table("stamped", {
      id: id({ default: "uuidv4" }),
      at: timestamptz({ mode }).default(wrong as never),
      bad: timestamptz({ mode }).nullable(),
    });
    const app = schema({ tables: [stamped] });
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const db = loose(
        connect(open({ url: primaryUrl(), searchPath: schemaName }), { schema: app }),
      );
      const bad = loose(
        connect(open({ url: primaryUrl(), searchPath: schemaName }), {
          schema: schema({ tables: [broken] }),
        }),
      );
      try {
        const made = await db.stamped.insert({} as never);
        expect(shown(made.at)).toBe(
          mode === "iso"
            ? "2020-01-01T00:00:00.000000Z"
            : mode === "date"
              ? "Date 2020-01-01T00:00:00.000Z"
              : "Temporal.Instant 2020-01-01T00:00:00Z",
        );
        let error: unknown;
        try {
          await bad.stamped.insert({} as never);
        } catch (caught) {
          error = caught;
        }
        // An object for a text column is the planner's object refusal; a string for a
        // Date or Temporal column is the codec's. Neither is converted.
        expect((error as OkmError).code).toBe(mode === "iso" ? "OKM1121" : "OKM1210");
      } finally {
        await db.close();
        await bad.close();
      }
    });
  });
}

postgresTest(gate, "date mode keeps milliseconds and drops the rest", async () => {
  const app = schema({ tables: [events], defaults: { time: "date" } });
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    await sql.unsafe(
      `insert into ${schemaName}.events (at) values ('2026-11-03 09:00:53.582634+00')`,
    );
    const db = loose(connect(open({ url: primaryUrl(), searchPath: schemaName }), { schema: app }));
    try {
      const [row] = await db.events.find({ limit: 1 });
      expect((row?.at as Date | undefined)?.toISOString()).toBe("2026-11-03T09:00:53.582Z");
    } finally {
      await db.close();
    }
  });
});

test("connect() refuses a temporal column at once when Temporal is missing", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Temporal");
  Reflect.deleteProperty(globalThis, "Temporal");
  const pool = {
    execute: () => new Promise(() => undefined),
    capabilities: {},
    close: async () => {},
  };
  try {
    let error: unknown;
    try {
      void connect(pool as never, { schema: apps.temporal });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OkmError);
    const message = (error as OkmError).message;
    expect((error as OkmError).code).toBe("OKM1210");
    expect(message).toContain("Bun ");
    expect(message).toContain("Node 26+ and Bun 1.4+");
    expect(message).toContain("polyfill to globalThis.Temporal");
    expect(message).toContain('defaults: { time: "iso" }');
    expect(message).toContain('{ mode: "iso" }');
    // The same tables with string time columns connect without Temporal.
    const iso = loose(connect(pool as never, { schema: apps.iso }));
    expect(typeof iso.events.find).toBe("function");
  } finally {
    if (descriptor !== undefined) Object.defineProperty(globalThis, "Temporal", descriptor);
  }
});

postgresTest(gate, "iso mode works with no Temporal global", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Temporal");
  const app = apps.iso;
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    Reflect.deleteProperty(globalThis, "Temporal");
    try {
      const db = loose(
        connect(open({ url: primaryUrl(), searchPath: schemaName }), { schema: app }),
      );
      try {
        const [first] = rows("iso");
        await db.events.insert(first as never);
        const [row] = await db.events.find({ limit: 1 });
        expect(row?.at).toBe("2026-11-03T09:00:53.582634Z");
      } finally {
        await db.close();
      }
    } finally {
      if (descriptor !== undefined) Object.defineProperty(globalThis, "Temporal", descriptor);
    }
  });
});

type LooseTable = {
  insert(input: unknown): Promise<Record<string, unknown>>;
  find(call: unknown): Promise<readonly Record<string, unknown>[]>;
  update(call: unknown): Promise<unknown>;
  aggregate(call: unknown): Promise<readonly Record<string, unknown>[]>;
};

type Loose = {
  readonly events: LooseTable;
  readonly notes: LooseTable;
  readonly pinned: LooseTable;
  readonly stamped: LooseTable;
  close(): Promise<void>;
};

/** Each mode has its own row types; this file compares them as text. */
function loose(db: unknown): Loose {
  return db as Loose;
}

async function readDay(db: Loose, at: unknown): Promise<readonly Record<string, unknown>[]> {
  return await db.events.find({ where: { at: eq(at) }, limit: 1 });
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error.code;
    throw error;
  }
  throw new Error("expected OkmError");
}
