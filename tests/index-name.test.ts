/**
 * `.name()` stores an index SQL name. Omitting it keeps `{table}_{columns}_idx`.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { index, schema, t, table } from "../src/dialects/pg/index.js";
import type { IndexObject } from "../src/contracts/catalog/types.js";

test("index().name() stores that SQL name and the default stays generated", () => {
  const app = schema({
    tables: [
      table(
        "tasks",
        { id: t.integer().primaryKey(), title: t.text() },
        {
          indexes: (columns) => [
            index(columns.id),
            index(columns.title).name("lookup_title"),
            {
              columns: [columns.title.name],
              isUnique: false,
              predicate: "(title <> ''::text)",
              sqlName: "open_title",
              unique() {
                return this;
              },
            },
          ],
        },
      ),
    ],
  });
  const names = app.catalog.objects
    .filter((object): object is IndexObject => object.kind === "index")
    .map((object) => object.identity.name)
    .sort();
  expect(names).toEqual(["lookup_title", "open_title", "tasks_id_idx"]);
});

test("index().name() rejects an empty SQL name", () => {
  expect(() => index({ name: "title" }).name("")).toThrow(OkmError);
});
