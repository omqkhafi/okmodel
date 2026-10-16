/**
 * `view(name, (q) => q.from(...))` stores a select.
 *
 * Postgres execution is `builder-fn-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { schema, sql, table, t } from "../src/dialects/pg/index.js";
import { view, type ViewBuilt, type ViewFrom } from "../src/dialects/pg/view/index.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
  ownerId: t.uuid(),
});

test("from selects the named columns and where appends the predicate", () => {
  const app = schema({
    casing: "snake",
    tables: [notes],
    views: [
      view("active_notes", (q) => q.from(notes, ["id", "title"]).where(sql`title is not null`)),
    ],
  });
  const object = app.catalog.objects.find((item) => item.kind === "view");
  expect(object?.kind).toBe("view");
  if (object?.kind !== "view") return;
  expect(object.definition.query).toBe('select "id", "title" from "notes" where title is not null');
  expect(object.definition.columns.map((column) => column.name)).toEqual(["id", "title"]);
});

test("snake casing quotes the SQL names", () => {
  const app = schema({
    casing: "snake",
    tables: [notes],
    views: [view("owned_notes", (q) => q.from(notes, ["id", "ownerId"]))],
  });
  const object = app.catalog.objects.find((item) => item.kind === "view");
  if (object?.kind !== "view") throw new Error("view missing");
  expect(object.definition.query).toBe('select "id", "owner_id" from "notes"');
  expect(object.definition.columns.map((column) => column.name)).toEqual(["id", "owner_id"]);
});
test("an omitted column list uses every field, in declaration order", () => {
  const app = schema({
    tables: [notes],
    views: [view("all_notes", (q) => q.from(notes))],
  });
  const object = app.catalog.objects.find((item) => item.kind === "view");
  if (object?.kind !== "view") throw new Error("view missing");
  expect(object.definition.query).toBe('select "id", "title", "ownerId" from "notes"');
});

test("a callback that does not return from() is OKM1121", () => {
  const build = (() => "nope") as unknown as (q: ViewFrom) => ViewBuilt;
  expect(() => view("broken", build)).toThrow(OkmError);
  try {
    view("broken", build);
  } catch (error) {
    expect((error as OkmError).code).toBe("OKM1121");
  }
});
