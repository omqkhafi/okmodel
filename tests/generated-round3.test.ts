/**
 * Planner gaps for generated columns and foreign keys, without a server.
 *
 * The catalog is sealed by `planMigration`. A held placeholder is not a hash
 * input. PostgreSQL proofs are in `generated-round3-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { catalogHash } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { fn, trigger, triggerType } from "../src/dialects/pg/fn/index.js";
import { index, schema, sql, table, t } from "../src/dialects/pg/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";

function code(run: () => unknown): string {
  try {
    run();
    return "";
  } catch (error) {
    return error instanceof OkmError ? error.code : "other";
  }
}

test("nullable virtual varchar, numeric, and smallint are OKM1060", () => {
  const cases = [
    t
      .varchar(8)
      .nullable()
      .generated(() => sql`'ab'`, { stored: false }),
    t
      .numeric(8, 2)
      .nullable()
      .generated(() => sql`1.5`, { stored: false }),
    t
      .smallint()
      .nullable()
      .generated(() => sql`1`, { stored: false }),
  ];
  for (const column of cases) {
    const plan = () =>
      planMigration({
        before: schema({ tables: [] }).catalog,
        after: schema({ tables: [table("stats", { value: column })] }).catalog,
        name: "limited",
      });
    const message = () => {
      try {
        plan();
      } catch (error) {
        return error instanceof OkmError ? error.message : "";
      }
      return "";
    };
    expect(code(plan)).toBe("OKM1060");
    expect(message()).toContain("STORED");
  }
  expect(
    code(() =>
      planMigration({
        before: schema({ tables: [] }).catalog,
        after: schema({
          tables: [
            table("stats", {
              value: t
                .text()
                .nullable()
                .generated(() => sql`'ab'`, { stored: false }),
            }),
          ],
        }).catalog,
        name: "text",
      }),
    ),
  ).toBe("");
});

test("an author expression that is exactly #0 is not a held slot", () => {
  const built = schema({
    tables: [
      table("stats", {
        n: t.integer(),
        literal: t.text().generated(() => sql`#0`),
        total: t.integer().generated(() => ({ n: 1 })),
      }),
    ],
  });
  const literal = built.catalog.objects.find(
    (object) => object.kind === "column" && object.identity.name === "literal",
  );
  expect(literal?.kind).toBe("column");
  if (literal?.kind === "column") expect(literal.definition.generated?.expression).toBe("#0");
  expect(code(() => catalogHash(built.catalog))).toBe("OKM1020");
  const planned = planMigration({
    before: schema({ tables: [] }).catalog,
    after: built.catalog,
    name: "held",
  });
  const create = planned.steps.map((step) => step.sql).join("\n");
  expect(create).toContain("#0");
  expect(create).toContain('"n"');
  expect(create).not.toContain("\uE000");
});

test("a stored to virtual swap with an index is OKM1927 and a bare swap needs confirmation", () => {
  const before = schema({
    tables: [
      table(
        "stats",
        { n: t.integer(), total: t.integer().generated(() => sql`n + 1`) },
        { indexes: (columns) => [index(columns.total)] },
      ),
    ],
  });
  const after = schema({
    tables: [
      table(
        "stats",
        { n: t.integer(), total: t.integer().generated(() => sql`n + 1`, { stored: false }) },
        { indexes: (columns) => [index(columns.total)] },
      ),
    ],
  });
  expect(
    code(() =>
      planMigration({ before: before.catalog, after: after.catalog, name: "swap", postgres: 18 }),
    ),
  ).toBe("OKM1927");
  const plainBefore = schema({
    tables: [table("stats", { n: t.integer(), total: t.integer().generated(() => sql`n + 1`) })],
  });
  const plainAfter = schema({
    tables: [
      table("stats", {
        n: t.integer(),
        total: t.integer().generated(() => sql`n + 1`, { stored: false }),
      }),
    ],
  });
  expect(
    code(() =>
      planMigration({
        before: plainBefore.catalog,
        after: plainAfter.catalog,
        name: "swap",
        postgres: 18,
      }),
    ),
  ).toBe("OKM1915");
  const confirmed = planMigration({
    before: plainBefore.catalog,
    after: plainAfter.catalog,
    name: "swap",
    postgres: 18,
    confirmTypeChanges: true,
  });
  expect(confirmed.steps.some((step) => step.sql.includes("drop column"))).toBe(true);
  expect(confirmed.steps.some((step) => step.sql.includes("add column"))).toBe(true);
});

test("virtual to plain needs a fill and then drops the expression", () => {
  const before = schema({
    tables: [
      table("stats", {
        n: t.integer(),
        total: t.integer().generated(() => sql`n + 1`, { stored: false }),
      }),
    ],
  });
  const after = schema({
    tables: [table("stats", { n: t.integer(), total: t.integer() })],
  });
  expect(
    code(() =>
      planMigration({ before: before.catalog, after: after.catalog, name: "plain", postgres: 18 }),
    ),
  ).toBe("OKM1928");
  const planned = planMigration({
    before: before.catalog,
    after: after.catalog,
    name: "plain",
    postgres: 18,
    columnFills: [{ table: "stats", column: "total", expression: "n + 1" }],
  });
  const sqlText = planned.steps.map((step) => step.sql);
  expect(sqlText.some((statement) => statement.includes("drop expression"))).toBe(true);
  expect(sqlText.some((statement) => statement.startsWith("update "))).toBe(true);
  expect(sqlText.some((statement) => statement.includes("drop column"))).toBe(false);
});

test("only deferrability uses alter constraint", () => {
  const users = table("users", { id: t.integer().primaryKey() });
  const before = schema({
    tables: [
      users,
      table(
        "posts",
        { authorId: t.integer() },
        {
          foreignKeys: () => ({
            posts_author: {
              columns: ["authorId"],
              references: { table: "users", columns: ["id"] },
            },
          }),
        },
      ),
    ],
  });
  const after = schema({
    tables: [
      users,
      table(
        "posts",
        { authorId: t.integer() },
        {
          foreignKeys: () => ({
            posts_author: {
              columns: ["authorId"],
              references: { table: "users", columns: ["id"] },
              deferrable: "deferred",
            },
          }),
        },
      ),
    ],
  });
  const planned = planMigration({ before: before.catalog, after: after.catalog, name: "defer" });
  expect(planned.steps.map((step) => step.kind)).toEqual(["alter-constraint"]);
  expect(planned.steps[0]?.sql).toContain("alter constraint");
  expect(planned.steps[0]?.sql).toContain("deferrable initially deferred");
  expect(planned.steps.some((step) => step.sql.includes("drop constraint"))).toBe(false);
});

test("a tenant set null list may clear a column that is not the tenant column", () => {
  const tenancy = columnTenancy({ key: "tenantId", type: "uuid" });
  expect(
    code(() =>
      schema({
        tenancy,
        tables: [
          table("orgs", { id: t.uuid().primaryKey() }),
          table("notes", {
            id: t.uuid().primaryKey(),
            orgId: t
              .uuid()
              .nullable()
              .references("orgs", { onDelete: { setNull: ["orgId"] } }),
          }),
        ],
      }),
    ),
  ).toBe("");
  expect(
    code(() =>
      schema({
        tenancy,
        tables: [
          table("orgs", { id: t.uuid().primaryKey() }),
          table("notes", {
            id: t.uuid().primaryKey(),
            orgId: t
              .uuid()
              .nullable()
              .references("orgs", { onDelete: { setNull: ["tenantId"] } }),
          }),
        ],
      }),
    ),
  ).toBe("OKM1060");
  expect(
    code(() =>
      schema({
        tenancy,
        tables: [
          table("orgs", { id: t.uuid().primaryKey() }),
          table("notes", {
            id: t.uuid().primaryKey(),
            orgId: t.uuid().nullable().references("orgs", { onDelete: "set null" }),
          }),
        ],
      }),
    ),
  ).toBe("OKM1060");
});

test("a before trigger when on a generated column is OKM1920", () => {
  const notes = table("notes", {
    id: t.integer().primaryKey(),
    total: t.integer().generated(() => sql`1`),
  });
  const touch = fn("touch_notes", {
    returns: triggerType,
    language: "plpgsql",
    body: sql`begin return new; end`,
    dependsOn: [notes],
  });
  expect(
    code(
      () =>
        schema({
          tables: [notes],
          functions: [touch],
          triggers: [
            trigger("notes_when", {
              on: notes,
              timing: "before",
              events: ["update"],
              level: "row",
              calls: touch,
              when: sql`new.total > 0`,
            }),
          ],
        }).catalog,
    ),
  ).toBe("OKM1920");
  expect(
    code(
      () =>
        schema({
          tables: [notes],
          functions: [touch],
          triggers: [
            trigger("notes_when", {
              on: notes,
              timing: "after",
              events: ["update"],
              level: "row",
              calls: touch,
              when: sql`new.total > 0`,
            }),
          ],
        }).catalog,
    ),
  ).toBe("");
});

test("a virtual column of a catalog type or calling a user function is OKM1920", () => {
  const tone = t.enum("tone", ["low", "high"]);
  expect(
    code(() =>
      planMigration({
        before: schema({ tables: [] }).catalog,
        after: schema({
          tables: [table("stats", { tone: tone.generated(() => sql`'low'`, { stored: false }) })],
        }).catalog,
        name: "type",
      }),
    ),
  ).toBe("OKM1920");
  const stats = table("stats", {
    n: t.integer(),
    total: t.integer().generated(() => sql`double_n(n)`, { stored: false }),
  });
  const doubleN = fn("double_n", {
    arguments: [{ name: "n", type: t.integer() }],
    returns: t.integer(),
    language: "sql",
    volatility: "immutable",
    body: sql`select n * 2`,
  });
  expect(
    code(() =>
      planMigration({
        before: schema({ tables: [] }).catalog,
        after: schema({ tables: [stats], functions: [doubleN] }).catalog,
        name: "fn",
      }),
    ),
  ).toBe("OKM1920");
});
