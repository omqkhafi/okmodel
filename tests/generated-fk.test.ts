/**
 * Generated expressions and composite foreign keys, without a server.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, sql, t, table } from "../src/dialects/pg/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { schemaAdvice } from "../src/tooling/migrate/schema-rules.js";

const empty = schema({ tables: [] }).catalog;

test("a generated callback prints STORED and a virtual option prints VIRTUAL", () => {
  const stored = schema({
    tables: [
      table("stats", { qty: t.integer(), total: t.integer().generated((c) => sql`${c.qty!} + 1`) }),
    ],
  });
  const virtual = schema({
    tables: [
      table("stats", {
        qty: t.integer(),
        total: t.integer().generated((c) => sql`${c.qty!} + 1`, { stored: false }),
      }),
    ],
  });
  const storedSql = renderCatalog(stored.catalog, "public").join("\n");
  const virtualSql = renderCatalog(virtual.catalog, "public").join("\n");
  expect(storedSql).toContain("generated always as");
  expect(storedSql).toContain("stored");
  expect(virtualSql).toContain("virtual");
  expect(virtualSql).not.toContain(" stored");
});

test("a virtual primary key is OKM1920", () => {
  const built = schema({
    tables: [
      table("stats", {
        total: t
          .integer()
          .generated(() => sql`1`, { stored: false })
          .primaryKey(),
      }),
    ],
  });
  expect(() => planMigration({ before: empty, after: built.catalog, name: "virtual" })).toThrow(
    OkmError,
  );
});

test("a foreign key to a non-key column is OKM1921", () => {
  const built = schema({
    tables: [
      table("users", { id: t.integer().primaryKey(), email: t.text() }),
      table("posts", {
        id: t.integer().primaryKey(),
        email: t.text().references("users", { columns: ["email"] }),
      }),
    ],
  });
  let code = "";
  try {
    planMigration({ before: empty, after: built.catalog, name: "target" });
  } catch (error) {
    code = error instanceof OkmError ? error.code : "";
  }
  expect(code).toBe("OKM1921");
});

test("a nullable composite key with MATCH SIMPLE is OKM2108", () => {
  const built = schema({
    tables: [
      table("users", { org: t.integer(), id: t.integer() }, { primaryKey: ["org", "id"] }),
      table(
        "posts",
        { org: t.integer().nullable(), id: t.integer() },
        {
          foreignKeys: () => ({
            posts_user: {
              columns: ["org", "id"],
              references: { table: "users", columns: ["org", "id"] },
            },
          }),
        },
      ),
    ],
  });
  const codes = schemaAdvice(built, [], {}).advice.map((item) => item.code);
  expect(codes).toContain("OKM2108");
});

test("match full and a deferrable key compile", () => {
  const built = schema({
    tables: [
      table("users", { id: t.integer().primaryKey() }),
      table(
        "posts",
        { authorId: t.integer() },
        {
          foreignKeys: () => ({
            posts_author: {
              columns: ["authorId"],
              references: { table: "users", columns: ["id"] },
              deferrable: "deferred",
              match: "full",
              onDelete: { setNull: ["authorId"] },
            },
          }),
        },
      ),
    ],
  });
  const sqlText = renderCatalog(built.catalog, "public").join("\n");
  expect(sqlText).toContain("match full");
  expect(sqlText).toContain("deferrable initially deferred");
  expect(sqlText).toContain("on delete set null");
});
