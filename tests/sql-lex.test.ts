/**
 * The migration SQL lexer: comments, quotes, dollar quotes, and statement splits.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { gateRuns } from "./gate-property.js";
import { repoRoot } from "../scripts/root.js";
import { parsePlan } from "../src/tooling/migrate/plan.js";
import {
  replaceSchemaName,
  sqlIdentifiers,
  sqlQuoteOpen,
  sqlStatements,
  transactionControl,
} from "../src/tooling/migrate/sql-lex.js";

test("identifiers skip comments, strings, and dollar quotes", () => {
  expect(sqlIdentifiers(`select name from notes where id = n`)).toEqual([
    { text: "select", quoted: false },
    { text: "name", quoted: false },
    { text: "from", quoted: false },
    { text: "notes", quoted: false },
    { text: "where", quoted: false },
    { text: "id", quoted: false },
    { text: "n", quoted: false },
  ]);
  expect(sqlIdentifiers(`select 'notes'::regclass`)).toEqual([
    { text: "select", quoted: false },
    { text: "regclass", quoted: false },
  ]);
  expect(sqlIdentifiers(`select "Notes" -- notes\n from items`)).toEqual([
    { text: "select", quoted: false },
    { text: "Notes", quoted: true },
    { text: "from", quoted: false },
    { text: "items", quoted: false },
  ]);
  expect(sqlIdentifiers(`select $body$ notes $body$`)).toEqual([{ text: "select", quoted: false }]);
});

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
    { numRuns: gateRuns(200) },
  );
});

test("a BEGIN ATOMIC routine body is one statement, and a bare one still splits", () => {
  const body = "create function f() returns int language sql begin atomic select 1; select 2; end";
  expect(sqlStatements(body)).toEqual([body]);
  expect(
    sqlStatements(
      "create function f() returns int language sql begin atomic select case when true then 1 else case when false then 2 else 3 end end; end",
    ),
  ).toHaveLength(1);
  expect(
    sqlStatements("create procedure p() language sql begin atomic select 1; end; commit"),
  ).toEqual(["create procedure p() language sql begin atomic select 1; end", "commit"]);
  expect(sqlStatements("begin atomic select 1; end")).toEqual(["begin atomic select 1", "end"]);
  expect(sqlStatements("begin; commit")).toEqual(["begin", "commit"]);
  expect(
    sqlStatements(
      "create function f() returns int language sql begin atomic select 'end'; select 1; -- end\n end",
    ),
  ).toHaveLength(1);

  const kept = parsePlan(
    [
      "-- name: hand",
      "",
      "create function f() returns int language sql",
      "begin atomic",
      "  select 1;",
      "",
      "  select 2;",
      "end;",
      "",
    ].join("\n"),
  );
  expect(kept.steps).toHaveLength(1);
  expect(kept.steps[0]?.sql).toContain("select 1;");
  expect(kept.steps[0]?.sql).toContain("select 2;");
});

test("BEGIN ATOMIC closes on END in any case, and a quoted or commented END does not", () => {
  const upper =
    "create function f() returns int language sql BEGIN ATOMIC select CASE WHEN true THEN 1 ELSE 2 END; END";
  expect(sqlStatements(upper)).toEqual([upper]);
  expect(sqlStatements(`${upper}; commit`)).toEqual([upper, "commit"]);
  const mixed = "create function f() returns int language sql begin atomic select 1; EnD";
  expect(sqlStatements(mixed)).toEqual([mixed]);
  const hidden = sqlStatements(
    "create function f() returns int language sql BEGIN ATOMIC select 'END'; -- END\n/* END */ select 1; EnD; rollback",
  );
  expect(hidden).toHaveLength(2);
  expect(hidden[0]).toContain("'END'");
  expect(hidden[0]?.endsWith("EnD")).toBe(true);
  expect(hidden[1]).toBe("rollback");
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

const ENDINGS = [
  ["commit", "commit"],
  ["end", "end"],
  ["rollback", "rollback"],
  ["abort", "abort"],
] as const;
const TAILS = [
  "",
  " work",
  " transaction",
  " and chain",
  " and no chain",
  " work and chain",
  " work and no chain",
  " transaction and chain",
  " transaction and no chain",
] as const;

test("transactionControl names every COMMIT, END, ROLLBACK, and ABORT form (N-94)", () => {
  for (const [keyword, word] of ENDINGS) {
    for (const tail of TAILS) {
      for (const text of [
        `${keyword}${tail}`,
        `${keyword.toUpperCase()}${tail.toUpperCase()}`,
        `select 1;\n${keyword}${tail}`,
        `${keyword}\n${tail.trim()}`,
        `${keyword} /* c */${tail}`,
        `${keyword}${tail};`,
      ]) {
        expect({ text, word: transactionControl(text) }).toEqual({ text, word });
      }
    }
  }
  expect(transactionControl("commit prepared 'x'")).toBe("commit");
  expect(transactionControl("rollback prepared 'x'")).toBe("rollback");
  expect(transactionControl("do $$ begin commit and chain; end $$")).toBe("commit");
  expect(transactionControl("do $$ begin rollback and no chain; end $$")).toBe("rollback");
});

test("transactionControl leaves statements that stay in the transaction alone", () => {
  for (const text of [
    "rollback to savepoint s",
    "rollback to s",
    "rollback and chain to s",
    "release savepoint s",
    "savepoint s",
    "end if",
    "commit_log",
    "select 'commit and chain'",
    "select 1 -- commit and chain",
    "/* rollback and chain */ select 1",
    "do $$ begin end $$",
    "create function f() returns void language plpgsql as $$ begin commit and chain; end $$",
  ]) {
    expect({ text, word: transactionControl(text) }).toEqual({ text, word: undefined });
  }
});

test("replaceSchemaName renames identifiers and never a string or a comment (N-99)", () => {
  const to = "okm_check_x";
  const rename = (text: string): string => replaceSchemaName(text, "public", to);
  expect(rename('create table "public"."t" (id int)')).toBe(
    'create table "okm_check_x"."t" (id int)',
  );
  expect(rename('grant usage on schema "public" to "app"')).toBe(
    'grant usage on schema "okm_check_x" to "app"',
  );
  expect(
    rename('alter default privileges IN SCHEMA  "public"\n grant select on tables to "app"'),
  ).toBe('alter default privileges IN SCHEMA  "okm_check_x"\n grant select on tables to "app"');
  expect(rename('create extension "citext" schema "public"')).toBe(
    'create extension "citext" schema "okm_check_x"',
  );
  expect(rename('select "public" . "t"')).toBe('select "okm_check_x" . "t"');
  for (const keep of [
    `alter table "t" alter column "n" set default 'see schema "public"'`,
    `alter table "t" alter column "n" set default 'x "public"."y"'`,
    `alter table "t" alter column "n" set default E'it''s "public"."y" \\' "public".z'`,
    `comment on table "t" is 'schema "public"'`,
    'select 1 -- schema "public"\n',
    'select 1 /* "public"."t" schema "public" */',
    'comment on table "t" is $$schema "public" "public"."t"$$',
    'comment on table "t" is $tag$ "public"."t" $tag$',
    'select "public"',
    'select "other"."t", "t"."public"',
  ]) {
    expect({ keep, out: rename(keep) }).toEqual({ keep, out: keep });
  }
  expect(rename(`select 'a "public".b'; select * from "public"."t"`)).toBe(
    `select 'a "public".b'; select * from "okm_check_x"."t"`,
  );
  expect(
    rename('create view "public"."v" as select \'"public".x\' as s, * from "public"."t"'),
  ).toBe('create view "okm_check_x"."v" as select \'"public".x\' as s, * from "okm_check_x"."t"');
});

test("replaceSchemaName rewrites a routine or DO body but not a string dollar quote", () => {
  const to = "okm_check_x";
  expect(
    replaceSchemaName(
      `create function "public"."f"() returns int language sql as $$ select count(*)::int from "public"."t" where s = 'schema "public"' $$`,
      "public",
      to,
    ),
  ).toBe(
    `create function "okm_check_x"."f"() returns int language sql as $$ select count(*)::int from "okm_check_x"."t" where s = 'schema "public"' $$`,
  );
  expect(replaceSchemaName('do $do$ begin delete from "public"."t"; end $do$', "public", to)).toBe(
    'do $do$ begin delete from "okm_check_x"."t"; end $do$',
  );
  expect(
    replaceSchemaName(
      `select 1; alter table "t" alter column "n" set default $$schema "public"$$`,
      "public",
      to,
    ),
  ).toBe(`select 1; alter table "t" alter column "n" set default $$schema "public"$$`);
});

test("replaceSchemaName never throws and leaves text with no match unchanged", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 300 }),
      (sql) => typeof replaceSchemaName(sql, "public", "scratch") === "string",
    ),
    { numRuns: gateRuns(200) },
  );
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (sql) => replaceSchemaName(sql, "zz", "yy") === sql),
    { numRuns: gateRuns(200) },
  );
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
    "0004_sql_names.sql": 8,
  });
});
