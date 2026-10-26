/**
 * Unknown keys that are not already sealed in `hidden-filterable-keys.test-d.ts`.
 *
 * A top-level `find` or `one` option, a `count` option beside `where`, and an
 * unknown `set` key are type errors. Include `orderBy` rejects a plain hidden
 * column mixed with `id`.
 */

import { many, schema, table, t } from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";

const notes = table(
  "notes",
  {
    id: t.text().primaryKey(),
    title: t.text(),
    score: t.integer().hidden({ filterable: true }),
    secret: t.text().hidden(),
    parentId: t.text().nullable(),
  },
  {
    relations: {
      children: many("notes", "parentId"),
    },
  },
);

const app = schema({ tables: [notes] });

declare const db: Connected<typeof app>;

void db.notes.find({ where: { id: "a", score: 1 }, limit: 1 });
void db.notes.one({ where: { id: "a" } });
void db.notes.count({ where: { id: "a" } });
void db.notes.update({ where: { id: "a" }, set: { title: "b" } });
void db.notes.find({
  limit: 1,
  include: { children: { orderBy: { id: "asc", score: "asc" }, limit: 1 } },
});

// @ts-expect-error an unknown top-level option beside a valid one
void db.notes.find({ nope: 1, limit: 1 });
// @ts-expect-error an unknown top-level option beside a valid one
void db.notes.one({ nope: 1, where: { id: "a" } });
// @ts-expect-error an unknown top-level option beside a valid one
void db.notes.count({ nope: 1, where: { id: "a" } });
// @ts-expect-error an unknown set key
void db.notes.update({ where: { id: "a" }, set: { title: "b", nope: 1 } });
void db.notes.find({
  limit: 1,
  include: {
    children: {
      // @ts-expect-error include orderBy cannot mix a plain hidden column with id
      orderBy: { id: "asc", secret: "desc" },
      limit: 1,
    },
  },
});
