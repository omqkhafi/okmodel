/**
 * `view(name, { tables }, (q) => q.notes.find(...))` stores a select.
 *
 * Postgres execution is `builder-fn-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { not, schema, table, t } from "../src/dialects/pg/index.js";
import { view } from "../src/dialects/pg/view/index.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
  ownerId: t.uuid(),
});

test("find selects the named columns and where appends the predicate", () => {
  const app = schema({
    casing: "snake",
    tables: [notes],
    views: [
      view("active_notes", { tables: [notes] }, (q) =>
        q.notes.find({ select: ["id", "title"], where: { title: not(null) } }),
      ),
    ],
  });
  const object = app.catalog.objects.find((item) => item.kind === "view");
  expect(object?.kind).toBe("view");
  if (object?.kind !== "view") return;
  expect(object.definition.query).toBe(
    'select t."id" as "id", t."title" as "title" from "notes" t where t."title" is not null',
  );
  expect(object.definition.columns.map((column) => column.name)).toEqual(["id", "title"]);
});

test("snake casing quotes the SQL names", () => {
  const app = schema({
    casing: "snake",
    tables: [notes],
    views: [
      view("owned_notes", { tables: [notes] }, (q) => q.notes.find({ select: ["id", "ownerId"] })),
    ],
  });
  const object = app.catalog.objects.find((item) => item.kind === "view");
  if (object?.kind !== "view") throw new Error("view missing");
  expect(object.definition.query).toBe(
    'select t."id" as "id", t."owner_id" as "owner_id" from "notes" t',
  );
  expect(object.definition.columns.map((column) => column.name)).toEqual(["id", "owner_id"]);
});

test("an omitted column list uses every field, in declaration order", () => {
  const app = schema({
    tables: [notes],
    views: [view("all_notes", { tables: [notes] }, (q) => q.notes.find())],
  });
  const object = app.catalog.objects.find((item) => item.kind === "view");
  if (object?.kind !== "view") throw new Error("view missing");
  expect(object.definition.query).toBe(
    'select t."id" as "id", t."title" as "title", t."ownerId" as "ownerId" from "notes" t',
  );
});

test("a callback that does not return find() is OKM1121", () => {
  const build = (() => "nope") as never;
  let code = "";
  expect(() => {
    try {
      return schema({ tables: [notes], views: [view("broken", { tables: [notes] }, build)] })
        .catalog;
    } catch (error) {
      code = error instanceof OkmError ? error.code : "";
      throw error;
    }
  }).toThrow(OkmError);
  expect(code).toBe("OKM1121");
});
