/**
 * `interval` and `timetz` round trips on real Postgres (D179).
 *
 * Postgres sends `01:30:00` for an interval and `01:02:03+03` for a timetz.
 * Both are written by a table handle, stored by Postgres, and read back by one.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { id, interval, schema, table, timetz } from "../src/dialects/pg/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const spans = table("spans", {
  id: id({ default: "uuidv4" }),
  every: interval().nullable(),
  tz: timetz().nullable(),
});

const app = schema({ casing: "snake", tables: [spans] });
const T = globalThis.Temporal;
const gate = await loadPostgresGate();

postgresTest(gate, "interval and timetz are written and read back", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    const raw = open({ url: primaryUrl(), searchPath: schemaName });
    const db = connect(raw, { schema: app });
    try {
      const written = [
        { every: "PT1H30M", tz: { time: "01:02:03", offset: "+03:00" } },
        { every: "P1Y2M3DT4H5M6.789S", tz: { time: "23:59:58.5", offset: "-05:30" } },
        { every: "-PT1H30M", tz: { time: "00:00:00", offset: "+00:00" } },
        { every: "PT100H", tz: { time: "12:00:00.123456", offset: "+14:00" } },
        { every: "PT0S", tz: { time: "12:00:00", offset: "-12:00" } },
      ] as const;
      for (const row of written) {
        await db.spans.insert({
          every: T.Duration.from(row.every),
          tz: { time: T.PlainTime.from(row.tz.time), offset: row.tz.offset },
        });
      }
      const rows = await db.spans.find({ limit: 10, select: ["every", "tz"] });
      const seen = rows.map(
        (r) => `${r.every?.toString()} ${r.tz?.time.toString()}${r.tz?.offset}`,
      );
      expect(seen.toSorted()).toEqual(
        written
          .map((r) => `${T.Duration.from(r.every).toString()} ${r.tz.time}${r.tz.offset}`)
          .toSorted(),
      );

      // what Postgres itself sends: whole days, months, a mix, and a short offset
      await sql`truncate spans`;
      await sql`
        insert into spans (every, tz) values
          ('90 minutes', '01:02:03+03'),
          ('1 year 2 mons 3 days 04:05:06.789', '04:05:06.5-05:30'),
          ('-2 days', '00:00:00+00'),
          ('3 mons', '10:00:00-12')
      `;
      const sent = await sql<{ every: string; tz: string }[]>`
        select every::text as every, tz::text as tz from spans order by tz
      `;
      expect(sent.map((r) => r.every)).toEqual([
        "-2 days",
        "01:30:00",
        "1 year 2 mons 3 days 04:05:06.789",
        "3 mons",
      ]);
      const back = await db.spans.find({ limit: 10, select: ["every", "tz"] });
      expect(
        back
          .map((r) => `${r.every?.toString()} ${r.tz?.time.toString()}${r.tz?.offset}`)
          .toSorted(),
      ).toEqual(
        [
          "-P2D 00:00:00+00:00",
          "P1Y2M3DT4H5M6.789S 04:05:06.5-05:30",
          "PT1H30M 01:02:03+03:00",
          "P3M 10:00:00-12:00",
        ].toSorted(),
      );

      // parts of different signs are not one Temporal.Duration
      await sql`truncate spans`;
      await sql`insert into spans (every) values ('1 day -1 hour')`;
      const mixed = await db.spans.find({ limit: 1, select: ["every"] }).then(
        () => undefined,
        (error: unknown) => (error instanceof OkmError ? error.code : String(error)),
      );
      expect(mixed).toBe("OKM1210");
    } finally {
      await db.close();
      await raw.close();
    }
  });
});
