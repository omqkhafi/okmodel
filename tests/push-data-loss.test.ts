/**
 * Data-loss labels follow the live catalog.
 *
 * A check is not a label. The row probe is one statement per table.
 */

import { expect, test } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import { staticNamespace } from "../src/contracts/catalog/identity.js";
import { column, constraint, table } from "../src/contracts/catalog/object.js";
import type { CatalogObject, Provenance } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { dropObjectSql } from "../src/dialects/pg/ddl.js";
import {
  assertNoDataLoss,
  dataLossObjects,
  lossesIn,
  refuseDataLoss,
  rowProbeSql,
} from "../src/tooling/migrate/data-loss.js";

const provenance: Provenance = { origin: "file", name: "loss" };
const namespace = staticNamespace("public");

test("labels are columns, primary keys, unique constraints, and tables", () => {
  const live = lossCatalog();
  expect(dataLossObjects(dropSteps(live), live, "public").map((item) => item.label)).toEqual([
    "notes.extra",
    "notes.notes_email_key",
    "notes.notes_pkey",
    "shop",
  ]);
});

test("the row probe is one select per table and names only populated tables", async () => {
  const live = lossCatalog();
  const losses = dataLossObjects(dropSteps(live), live, "public");
  expect(rowProbeSql("public", "notes")).toBe('select 1 from "public"."notes" limit 1');
  const seen: string[] = [];
  let caught: unknown;
  try {
    await assertNoDataLoss(
      {
        execute: (sql) => {
          seen.push(sql);
          return Promise.resolve({ rows: sql.includes('"notes"') ? [[1]] : [] });
        },
      },
      "public",
      losses,
    );
  } catch (error) {
    caught = error;
  }
  expect(seen).toEqual([
    'select 1 from "public"."notes" limit 1',
    'select 1 from "public"."shop" limit 1',
  ]);
  expect(caught).toBeInstanceOf(OkmError);
  const error = caught as OkmError;
  expect(error.code).toBe("OKM1898");
  expect(error.message).toBe(
    "okm push would drop notes.extra, notes.notes_email_key, notes.notes_pkey. Pass --allow-data-loss to apply that plan.",
  );
  expect(error.fix?.summary).toBe(
    "Keep the column, key, or table, or pass --allow-data-loss when those rows can go.",
  );
  expect(lossesIn([{ sql: "absent" }], losses)).toEqual([]);
  expect(() => {
    refuseDataLoss([]);
  }).not.toThrow();
});

function dropSteps(live: { readonly objects: readonly CatalogObject[] }) {
  return live.objects.flatMap((object) => {
    if (object.kind === "column" && object.identity.name !== "extra") return [];
    if (object.kind === "table" && object.identity.name !== "shop") return [];
    if (object.kind === "constraint" && object.definition.constraintKind === "check") {
      const sql = dropObjectSql(object, "public");
      return sql === undefined ? [] : [{ sql, kind: "drop-constraint" }];
    }
    const sql = dropObjectSql(object, "public");
    if (sql === undefined) return [];
    const kind =
      object.kind === "table"
        ? "drop-table"
        : object.kind === "column"
          ? "drop-column"
          : object.kind === "constraint"
            ? "drop-constraint"
            : "other";
    if (kind === "other") return [];
    return [{ sql, kind }];
  });
}

function lossCatalog() {
  const notes = { namespace, name: "notes" };
  return catalog([
    table({ namespace, name: "shop", provenance }),
    table({ namespace, name: "notes", provenance }),
    column({ parent: notes, name: "id", dataType: "integer", nullable: false, provenance }),
    column({ parent: notes, name: "email", dataType: "text", nullable: true, provenance }),
    column({ parent: notes, name: "extra", dataType: "text", nullable: true, provenance }),
    constraint({
      parent: notes,
      constraintKind: "check",
      columns: ["extra"],
      expression: "extra <> ''",
      name: "notes_extra_check",
      provenance,
    }),
    constraint({
      parent: notes,
      constraintKind: "primaryKey",
      columns: ["id"],
      name: "notes_pkey",
      provenance,
    }),
    constraint({
      parent: notes,
      constraintKind: "unique",
      columns: ["email"],
      name: "notes_email_key",
      provenance,
    }),
  ]);
}
