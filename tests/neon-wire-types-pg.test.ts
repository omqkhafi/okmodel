/**
 * Neon HTTP and WebSocket modes decode every column type the same way.
 *
 * The real `@neondatabase/serverless` driver talks to a local endpoint
 * (`startNeonLocal`): WebSocket bytes go to TCP Postgres, and `/sql` answers
 * with wire text and type OIDs the way Neon's proxy does. The driver's own type
 * parsers run, so a `date` it turns into a JS `Date` shows up here.
 */

import { afterAll, beforeAll, expect } from "bun:test";

import { open } from "../src/adapters/pg/neon.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/neon.js";
import { startNeonLocal, type NeonLocal } from "../packages/harness/src/neon-local.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const gate = await loadPostgresGate();
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const kinds = table(`okm_wire_${suffix}`, {
  id: t.integer().primaryKey(),
  day: t.date(),
  clock: t.time(6),
  clockTz: t.timetz(6),
  local: t.timestamp(6),
  instant: t.timestamptz(6),
  span: t.interval(),
  big: t.bigint({ as: "bigint" }),
  money: t.numeric(),
  flag: t.boolean(),
  doc: t.json(),
  docb: t.jsonb(),
  bytes: t.bytea(),
  key: t.uuid(),
  tags: t.text().array(),
  counts: t.integer().array(),
  span4: t.int4range(),
  mood: t.enum(`okm_mood_${suffix}`, ["calm", "busy"]),
  address: t.inet(),
});
const app = schema({ casing: "snake", tables: [kinds] });
const apps = {
  iso: app,
  date: schema({ casing: "snake", tables: [kinds], defaults: { time: "date" } }),
  temporal: schema({ casing: "snake", tables: [kinds], defaults: { time: "temporal" } }),
} as const;

/** What each time mode reads back for the row above. */
const expected = {
  iso: {
    day: "2026-11-03",
    instant: "2026-11-03T10:14:15.123456Z",
    local: "2026-11-03T13:14:15.123456",
    clock: "13:14:15.123456",
    clockTz: "13:14:15.123456+03",
    span: "1 day 02:03:04.5",
  },
  date: {
    day: "Date 2026-11-03T00:00:00.000Z",
    instant: "Date 2026-11-03T10:14:15.123Z",
    local: "Date 2026-11-03T13:14:15.123Z",
    clock: "13:14:15.123456",
    clockTz: "13:14:15.123456+03",
    span: "1 day 02:03:04.5",
  },
  temporal: {
    day: "Temporal.PlainDate 2026-11-03",
    instant: "Temporal.Instant 2026-11-03T10:14:15.123456Z",
    local: "Temporal.PlainDateTime 2026-11-03T13:14:15.123456",
    clock: "Temporal.PlainTime 13:14:15.123456",
    span: "Temporal.Duration P1DT2H3M4.5S",
  },
} as const;

let local: NeonLocal | undefined;

beforeAll(async () => {
  if (!gate.run) return;
  local = startNeonLocal(primaryUrl());
  const pool = await open({ url: local.url, max: 1 });
  try {
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    await pool.execute(
      `insert into okm_wire_${suffix} (id, day, clock, clock_tz, local, instant, span, big,
       money, flag, doc, docb, bytes, key, tags, counts, span4, mood, address) values (1, '2026-11-03', '13:14:15.123456',
       '13:14:15.123456+03', '2026-11-03 13:14:15.123456', '2026-11-03 10:14:15.123456+00',
       '1 day 02:03:04.5', 9223372036854775807, '12345678901234567890.123456789', true,
       '{"a": [1, 2]}', '{"b": {"c": null}}', '\\xdeadbeef', '6f9619ff-8b86-d011-b42d-00c04fc964ff',
       '{"x","y z"}', '{1,2,3}', '[1,5)', 'busy', '192.168.0.1/24')`,
    );
  } finally {
    await pool.close();
  }
}, 30_000);

afterAll(async () => {
  if (local === undefined) return;
  const pool = await open({ url: local.url, max: 1 });
  try {
    await pool.execute(`drop table if exists okm_wire_${suffix}`);
    await pool.execute(`drop type if exists okm_mood_${suffix}`);
  } finally {
    await pool.close();
    await local.close();
  }
});

for (const time of ["iso", "date", "temporal"] as const) {
  postgresTest(
    gate,
    `http and websocket modes read every column type the same (time: ${time})`,
    async () => {
      const rows: Record<string, unknown>[] = [];
      for (const mode of ["websocket", "http"] as const) {
        const db = await connect(local!.url, { schema: apps[time], mode });
        try {
          const found = await db[kinds.name]!.find({ where: { id: 1 }, limit: 1 });
          rows.push(plain(found[0]) as Record<string, unknown>);
        } finally {
          await db.close();
        }
      }
      const [websocket, http] = rows;
      expect(websocket).toMatchObject({
        ...expected[time],
        big: "bigint 9223372036854775807",
        flag: true,
        bytes: [222, 173, 190, 239],
      });
      for (const [field, value] of Object.entries(websocket ?? {})) {
        expect({ field, value: http?.[field] }).toEqual({ field, value });
      }
    },
    30_000,
  );
}

postgresTest(
  gate,
  "a day bucket key is the same in both modes",
  async () => {
    const keys: unknown[] = [];
    for (const mode of ["websocket", "http"] as const) {
      const pool = await open({ url: local!.url, mode });
      try {
        const result = await pool.execute(
          `select date_trunc('day', day)::date from okm_wire_${suffix}`,
        );
        keys.push(result.rows[0]?.[0]);
      } finally {
        await pool.close();
      }
    }
    expect(keys).toEqual(["2026-11-03", "2026-11-03"]);
  },
  30_000,
);

postgresTest(
  gate,
  "http batch reads wire text like execute",
  async () => {
    const pool = await open({ url: local!.url, mode: "http" });
    try {
      const results = await pool.batch([
        { text: `select day, instant, doc, tags from okm_wire_${suffix}` },
      ]);
      expect(results[0]?.rows).toEqual([
        ["2026-11-03", "2026-11-03 10:14:15.123456+00", '{"a": [1, 2]}', '{x,"y z"}'],
      ]);
    } finally {
      await pool.close();
    }
  },
  30_000,
);

/** Dates, Temporal values, bigints, and bytes as comparable JSON values. */
function plain(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? `bigint ${value.toString()}` : value;
  }
  if (value instanceof Uint8Array) return [...value];
  if (value instanceof Date) return `Date ${value.toISOString()}`;
  const tag: unknown = Reflect.get(value, Symbol.toStringTag);
  if (typeof tag === "string" && tag.startsWith("Temporal."))
    return `${tag} ${(value as { toString(): string }).toString()}`;
  if (Array.isArray(value)) return value.map(plain);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
}
