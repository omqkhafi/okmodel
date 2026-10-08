/**
 * The migration SQL lexer: comments, quotes, dollar quotes, and statement splits.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";
import { parsePlan } from "../src/tooling/migrate/plan.js";
import { sqlQuoteOpen, sqlStatements } from "../src/tooling/migrate/sql-lex.js";

test("line and block comments are removed, including a nested block", () => {
  expect(sqlStatements("/* note */ truncate logs")).toEqual(["truncate logs"]);
  expect(sqlStatements("-- note\ntruncate logs")).toEqual(["truncate logs"]);
  expect(sqlStatements("select/* a /* b */ c */1")).toEqual(["select 1"]);
  expect(sqlStatements("select 1 -- trailing\n")).toEqual(["select 1"]);
});

test("a top-level semicolon splits, and one inside a comment, string, or dollar quote does not", () => {
  expect(sqlStatements('select 1; drop table "public"."logs"')).toEqual([
    "select 1",
    'drop table "public"."logs"',
  ]);
  expect(sqlStatements("select 1 /* ; */; delete from logs")).toEqual([
    "select 1",
    "delete from logs",
  ]);
  expect(sqlStatements("select 'drop table logs;';")).toEqual(["select 'drop table logs;'"]);
  expect(sqlStatements("select 'it''s; fine'")).toEqual(["select 'it''s; fine'"]);
  expect(sqlStatements("select $$ delete from logs; $$")).toEqual([
    "select $$ delete from logs; $$",
  ]);
  expect(sqlStatements("select $body$ delete from logs; $body$")).toEqual([
    "select $body$ delete from logs; $body$",
  ]);
  expect(sqlStatements("select $outer$ $inner$; $inner$ $outer$; select 1")).toEqual([
    "select $outer$ $inner$; $inner$ $outer$",
    "select 1",
  ]);
});

test("quotes, escape strings, and identifiers keep their bodies", () => {
  expect(sqlStatements("select 'a'")).toEqual(["select 'a'"]);
  expect(sqlStatements("select E'a\\'; drop table t'")).toEqual(["select E'a\\'; drop table t'"]);
  expect(sqlStatements("select e'a''b'")).toEqual(["select e'a''b'"]);
  expect(sqlStatements("select nameE'not escaped'; drop table t")).toEqual([
    "select nameE'not escaped'",
    "drop table t",
  ]);
  expect(sqlStatements('select "public"."a;b"')).toEqual(['select "public"."a;b"']);
  expect(sqlStatements('select "a""b"')).toEqual(['select "a""b"']);
  expect(sqlStatements("select $1")).toEqual(["select $1"]);
});

test("a plain string does not treat a backslash as an escape", () => {
  expect(sqlStatements("select 'foo\\'; drop table t")).toEqual(["select 'foo\\'", "drop table t"]);
});

test("an unterminated string, comment, identifier, or dollar quote is one tail", () => {
  expect(sqlStatements("select 1; select 'unterminated")).toEqual([
    "select 1",
    "select 'unterminated",
  ]);
  expect(sqlQuoteOpen("select 'unterminated")).toBe(true);
  expect(sqlQuoteOpen("select 'done'")).toBe(false);
  expect(sqlStatements("select 1 /* never ends")).toEqual(["select 1"]);
  expect(sqlQuoteOpen("select 1 /* never ends")).toBe(true);
  expect(sqlStatements('select "unterminated')).toEqual(['select "unterminated']);
  expect(sqlStatements("select $tag$ unterminated")).toEqual(["select $tag$ unterminated"]);
  expect(sqlQuoteOpen("select $tag$ unterminated")).toBe(true);
  expect(sqlQuoteOpen("-- still a comment")).toBe(false);
  expect(sqlStatements("")).toEqual([]);
});

test("random input never throws", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 400 }), (sql) => {
      const statements = sqlStatements(sql);
      const open = sqlQuoteOpen(sql);
      return Array.isArray(statements) && typeof open === "boolean";
    }),
    { numRuns: 200 },
  );
});

test("a blank line inside a quote stays in the step, and one outside still splits", () => {
  const dollar = parsePlan(
    [
      "-- name: hand",
      "",
      "do $$",
      "begin",
      "  delete from logs;",
      "",
      "  insert into logs values (1);",
      "end",
      "$$;",
      "",
    ].join("\n"),
  );
  expect(dollar.steps).toHaveLength(1);
  expect(dollar.steps[0]?.sql).toContain("delete from logs;");
  expect(dollar.steps[0]?.sql).toContain("insert into logs values (1);");

  const quoted = parsePlan(
    ["-- name: hand", "", "select 'hello", "", "-- not a header", "world';", ""].join("\n"),
  );
  expect(quoted.steps).toHaveLength(1);
  expect(quoted.steps[0]?.sql).toContain("hello");
  expect(quoted.steps[0]?.sql).toContain("-- not a header");
  expect(quoted.steps[0]?.sql).toContain("world'");

  const split = parsePlan("-- name: hand\n\nselect 1;\n\ntruncate logs;\n");
  expect(split.steps).toHaveLength(2);
  expect(split.steps[0]?.sql).toBe("select 1");
  expect(split.steps[1]?.sql).toBe("truncate logs");
});

test("reference-app migrations keep their step counts", () => {
  const directory = join(repoRoot(), "packages/reference-app/migrations");
  const counts: Record<string, number> = {};
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".sql")) continue;
    counts[file] = parsePlan(readFileSync(join(directory, file), "utf8")).steps.length;
  }
  expect(counts).toEqual({
    "0001_init.sql": 58,
    "0002_public_id.sql": 7,
    "0003_drop_share_token.sql": 1,
  });
});
