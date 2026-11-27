/**
 * Dotted path keys on `where`, `select`, `orderBy`, `groupBy`, and `set`.
 *
 * A featureless call still matches the first overload. A path the resolver
 * refuses is a type error.
 */

import { expectTypeOf } from "expect-type";

import { one, schema, t, table } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const address = t.composite("address", {
  city: t.text(),
  zip: t.text().nullable(),
});

const projects = table("projects", {
  id: t.integer().primaryKey(),
  name: t.text(),
});

const people = table(
  "people",
  {
    id: t.integer().primaryKey(),
    home: address,
    work: address.nullable(),
    projectId: t.integer().nullable().references("projects"),
  },
  { relations: { project: one("projects", "projectId") } },
);

const app = schema({ tables: [projects, people] });
const db = connect("postgres://localhost/okm", { schema: app });

const found = await db.people.find({
  where: { "home.city": "Riyadh", "work.city": "Jeddah" },
  select: ["id", "home.city", "work.city", "project.name"],
  orderBy: { "home.city": "asc" },
  limit: 10,
});
const foundRow = found[0];
if (foundRow !== undefined) {
  expectTypeOf(foundRow).toEqualTypeOf<{
    readonly id: number;
    readonly "home.city": string;
    readonly "work.city": string | null;
    readonly "project.name": string | null;
  }>();
}

const grouped = await db.people.aggregate({
  groupBy: ["home.city"],
  count: true,
  orderBy: { "home.city": "asc" },
  limit: 10,
});
const groupedRow = grouped[0];
if (groupedRow !== undefined) {
  expectTypeOf(groupedRow["home.city"]).toEqualTypeOf<string>();
  expectTypeOf(groupedRow.count).toEqualTypeOf<number>();
}

const written = await db.people.update(
  { where: { "home.city": "Riyadh" }, set: { "home.city": "Dammam" } },
  { returning: true },
);
const writtenRow = written[0];
if (writtenRow !== undefined) {
  expectTypeOf(writtenRow.home.city).toEqualTypeOf<string>();
}

// @ts-expect-error a second relation is not a path
void db.people.find({ where: { "project.missing": "x" }, limit: 1 });

// @ts-expect-error set does not follow a to-one path
void db.people.update({ where: { id: 1 }, set: { "project.name": "x" } });
