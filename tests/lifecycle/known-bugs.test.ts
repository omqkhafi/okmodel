/**
 * Known-bug matching, rename names, destructive allows, and the skip budget.
 */

import fc from "fast-check";
import { expect, test } from "bun:test";

import { allowLifecycleMigration } from "../../packages/harness/src/lifecycle-project.js";
import { applyEvolution } from "./evolve.js";
import { distinctTableName, lifecycleCaseArb } from "./grammar.js";
import { matchKnownBug } from "./known-bugs.js";
import { sqlName, type SchemaModel } from "./model.js";
import { formatLifecycleReport, knownSkipExceedsBudget } from "./report.js";

test("a known bug needs the failure message and the feature", () => {
  expect(matchKnownBug(["generated"], "drift")).toBeUndefined();
  expect(
    matchKnownBug(["index-partial"], "history differs from the stored catalog"),
  ).toBeUndefined();
  expect(
    matchKnownBug(["generated", "identity"], "0001_init: history differs from the stored catalog"),
  ).toBeUndefined();
});

test("bugs fixed by #537 and bugs this grammar cannot reach do not match", () => {
  for (const id of [
    "N-10",
    "N-11",
    "N-35",
    "N-36",
    "N-37",
    "N-102",
    "N-118",
    "N-119",
    "N-123",
    "N-126",
    "N-135",
    "NEW-1",
    "NEW-2",
  ]) {
    expect(matchKnownBug([id], id)?.id).not.toBe(id);
  }
  expect(matchKnownBug(["trigger-when"], "anything")).toBeUndefined();
  expect(matchKnownBug(["namespace", "view"], "drift")).toBeUndefined();
  expect(matchKnownBug(["fk-no-action"], "foreign key")).toBeUndefined();
  expect(matchKnownBug(["domain"], "domain")).toBeUndefined();
});

test("the report names ran, passed, known, and unknown", () => {
  expect(formatLifecycleReport({ ran: 40, passed: 30, known: 8, unknown: 2 })).toBe(
    "[lifecycle] ran=40 passed=30 known=8 unknown=2",
  );
  expect(knownSkipExceedsBudget({ ran: 40, passed: 30, known: 10, unknown: 0 })).toBe(false);
  expect(knownSkipExceedsBudget({ ran: 40, passed: 20, known: 11, unknown: 9 })).toBe(true);
});

test("a rename records the SQL name the snapshot stored", () => {
  const model: SchemaModel = {
    casing: "snake",
    tenancy: false,
    trgm: false,
    tables: [
      {
        key: "tasks",
        name: "Note6",
        columns: [],
        indexes: [],
        checks: [],
        archive: false,
        versioned: false,
      },
    ],
    triggers: [],
    views: [],
  };
  const next = applyEvolution(model, {
    kind: "renameTable",
    tableKey: "tasks",
    nextName: "Note6_v2",
  });
  expect(next.tables[0]?.renamedFrom).toBe(sqlName("snake", "Note6"));
  expect(next.tables[0]?.renamedFrom).toBe("note6");
});

test("a drop leaves a generated expression's source column", () => {
  fc.assert(
    fc.property(lifecycleCaseArb, (item) => {
      let model = item.initial;
      for (const step of item.evolutions) {
        if (step.kind === "dropColumn") {
          const table = model.tables.find((candidate) => candidate.key === step.tableKey);
          const column = table?.columns.find((candidate) => candidate.key === step.columnKey);
          if (table !== undefined && column !== undefined) {
            const quoted = `"${column.name}"`;
            for (const other of table.columns) {
              if (other.generated === undefined) continue;
              expect(other.generated.includes(quoted)).toBe(false);
            }
          }
        }
        model = applyEvolution(model, step);
      }
    }),
    { numRuns: 400, seed: 20261024 },
  );
});

test("an evolution does not add a second index on the same columns", () => {
  fc.assert(
    fc.property(lifecycleCaseArb, (item) => {
      let model = item.initial;
      const seen = (indexes: readonly { readonly columns: readonly string[] }[]): void => {
        const names = indexes.map((index) => index.columns.join("\0"));
        expect(new Set(names).size).toBe(names.length);
      };
      for (const table of model.tables) seen(table.indexes);
      for (const step of item.evolutions) {
        model = applyEvolution(model, step);
        for (const table of model.tables) seen(table.indexes);
      }
    }),
    { numRuns: 200, seed: 20261024 },
  );
});

test("a child table does not reuse the parent name", () => {
  expect(distinctTableName("authors", ["authors"], "omit")).toBe("authors_b");
  expect(distinctTableName("Authors", ["authors"], "snake")).toBe("Authors_b");
  expect(sqlName("snake", distinctTableName("Authors", ["authors"], "snake"))).not.toBe("authors");
});

test("destructive allows use the code the statement triggers", () => {
  const text = [
    "-- class: contract",
    "-- kind: drop-domain",
    "-- action: ddl",
    "-- lock: ACCESS EXCLUSIVE",
    'drop type "public"."pos";',
    "",
    "-- class: contract",
    "-- kind: drop-enum",
    "-- action: ddl",
    "-- lock: ACCESS EXCLUSIVE",
    'drop type "public"."color";',
    "",
    "-- class: expand",
    "-- kind: validate-constraint",
    "-- action: ddl",
    "-- lock: SHARE UPDATE EXCLUSIVE",
    'alter table "public"."tasks" validate constraint "tasks_author_id_fkey";',
    "",
    "-- class: contract",
    "-- kind: drop-column",
    "-- action: ddl",
    "-- lock: ACCESS EXCLUSIVE",
    'alter table "public"."tasks" drop column "weight";',
    "",
  ].join("\n");
  const allowed = allowLifecycleMigration(text);
  expect(allowed).toContain("-- okm-allow OKM1514: the object is unused");
  expect(allowed).toContain("-- okm-allow OKM1513: the object is unused");
  expect(allowed).toContain("-- okm-allow OKM1532: the table is empty");
  expect(allowed).toContain("-- okm-allow OKM1512: the column is unused");
  expect(allowed).not.toContain("OKM1511");
});
