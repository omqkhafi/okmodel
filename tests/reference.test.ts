/**
 * Reference rows are insert-if-missing statements, not a catalog diff.
 */

import { expect, test } from "bun:test";

import { schema, t, table } from "../src/dialects/pg/index.js";
import { readReference, referenceInserts } from "../src/tooling/migrate/reference.js";

test("reference inserts are insert-if-missing and do not update or delete", () => {
  const app = schema({
    tables: [
      table(
        "roles",
        { code: t.text().primaryKey(), label: t.text() },
        { reference: { key: "code", rows: [{ code: "admin", label: "Admin" }] } },
      ),
    ],
  });
  const declared = readReference(app.tables, app.casing, app.catalog);
  const sql = referenceInserts(declared, "public");
  expect(sql).toEqual([
    `insert into "public"."roles" ("code", "label") values ('admin', 'Admin') on conflict ("code") do nothing`,
  ]);
  const text = sql.join("\n").toLowerCase();
  expect(text).not.toContain("update");
  expect(text).not.toContain("delete");
});
