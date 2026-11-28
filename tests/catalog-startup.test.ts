/**
 * The catalog compiler runs on the first `.catalog` read, including after a query.
 *
 * `schema()` keeps descriptors. A featureless import does not load the compiler.
 * The startup-graph check for that lives in `scripts/size.ts`.
 */

import { expect, test } from "bun:test";

import { open } from "../src/adapters/pg/pglite.js";
import { serializeCatalog } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { index, schema, sql, t, table } from "../src/dialects/pg/index.js";
import "../src/dialects/pg/policy.js";
import { sequence } from "../src/dialects/pg/seq/index.js";
import { connect } from "../src/runtime/pg/pglite.js";

function everyOption() {
  return schema({
    tables: [
      table(
        "rooms",
        {
          id: t.integer().primaryKey(),
          code: t.text(),
        },
        { comment: "rooms", unique: { codeKey: ["id", "code"] } },
      ),
      table(
        "bookings",
        {
          id: t.integer().primaryKey(),
          roomId: t.integer().references("rooms", { onDelete: "cascade" }),
          code: t.text(),
          during: t.tstzrange(),
          active: t.boolean().default(true),
          total: t.integer().generated((columns) => sql`${columns.roomId!} + 1`),
          home: t.composite("stay_address", { street: t.text().comment("road") }),
          number: sequence({ start: 10 }).column(),
        },
        {
          comment: "bookings",
          indexes: (columns) => [
            index(columns.roomId).with({ fillfactor: 70 }).comment("room lookup"),
          ],
          checks: { activeRoom: (columns) => sql`${columns.active!} = true` },
          foreignKeys: () => ({
            room: {
              columns: ["roomId", "code"],
              references: { table: "rooms", columns: ["id", "code"] },
              deferrable: "deferred",
              comment: "room link",
            },
          }),
          exclusions: (columns) => ({
            noDouble: {
              on: [
                [columns.roomId, "eq"],
                [columns.during, "overlaps"],
              ],
              where: { active: true },
              deferrable: "immediate",
            },
          }),
          policies: () => ({ own: { using: true } }),
        },
      ),
    ],
  });
}

test("the first catalog read after the query model matches an immediate read", () => {
  const late = everyOption();
  expect((late.model.bookings?.columns.length ?? 0) > 0).toBe(true);
  const early = everyOption();
  const earlyText = serializeCatalog(early.catalog);
  const lateText = serializeCatalog(late.catalog);
  expect(lateText).toBe(earlyText);
  expect(lateText).toContain("foreignKey");
  expect(lateText).toContain("exclusion");
  expect(lateText).toContain("fillfactor");
  expect(lateText).toContain("stay_address");
  expect(lateText).toContain("generated");
  expect(late.catalog.objects.some((object) => object.kind === "policy")).toBe(true);
  expect(late.catalog.objects.some((object) => object.kind === "sequence")).toBe(true);
});

test("an exclusion with no element is refused while schema() runs", () => {
  expect(() =>
    schema({
      tables: [
        table(
          "slots",
          { id: t.integer().primaryKey() },
          { exclusions: () => ({ empty: { on: [] } }) },
        ),
      ],
    }),
  ).toThrow(OkmError);
});

test("a query can run before the first catalog read", async () => {
  const early = schema({
    tables: [table("notes", { id: t.integer().primaryKey(), body: t.text() })],
  });
  const late = schema({
    tables: [table("notes", { id: t.integer().primaryKey(), body: t.text() })],
  });
  const pool = await open();
  try {
    for (const statement of renderCatalog(early.catalog, "public")) {
      await pool.execute(statement);
    }
    await pool.execute("insert into notes (id, body) values (1, 'hi')");
    const db = await connect(pool, { schema: late });
    try {
      const rows = await db.notes.find({ where: { id: 1 }, limit: 10 });
      expect(rows).toEqual([{ id: 1, body: "hi" }]);
      expect(serializeCatalog(late.catalog)).toBe(serializeCatalog(early.catalog));
    } finally {
      await db.close();
    }
  } finally {
    await pool.close();
  }
});
