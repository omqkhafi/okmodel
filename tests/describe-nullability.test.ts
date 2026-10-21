/**
 * Lexical screen and the nullability rule. No database.
 */

import { expect, test } from "bun:test";

import { columnNullability, type AttributeFacts } from "../src/tooling/describe/nullability.js";
import { statementBlocksNotNull } from "../src/tooling/describe/screen.js";

const base: AttributeFacts = {
  attnotnull: true,
  attidentity: "",
  attgenerated: "",
  relkind: "r",
};

const column = { name: "name", tableOid: 1, attnum: 2 };

test("a word inside a string, comment, or quoted identifier does not block", () => {
  expect(statementBlocksNotNull("select name from item where note = 'join'")).toBe(false);
  expect(statementBlocksNotNull("select name from item where note = 'it''s a join'")).toBe(false);
  expect(statementBlocksNotNull("select name from item where note = E'join'")).toBe(false);
  expect(statementBlocksNotNull("select name from item where note = $q$ join $q$")).toBe(false);
  expect(statementBlocksNotNull("select name from item -- join\n")).toBe(false);
  expect(statementBlocksNotNull("select name from item /* left join */")).toBe(false);
  expect(statementBlocksNotNull("select name from item /* outer /* join */ still */")).toBe(false);
  expect(statementBlocksNotNull('select "join" from item')).toBe(false);
  expect(statementBlocksNotNull('select name from "join"')).toBe(false);
  expect(statementBlocksNotNull("select joining from item")).toBe(false);
});

test("a real join, union, or with blocks", () => {
  expect(statementBlocksNotNull("select i.name from item i left join other o on true")).toBe(true);
  expect(statementBlocksNotNull("SELECT name FROM item UNION ALL SELECT name FROM item")).toBe(
    true,
  );
  expect(statementBlocksNotNull("with j as (select name from item) select name from j")).toBe(true);
  expect(statementBlocksNotNull("select * from item, lateral (select 1) x")).toBe(true);
  expect(statementBlocksNotNull("select name from item intersect select name from item")).toBe(
    true,
  );
  expect(statementBlocksNotNull("select name from item except select name from item")).toBe(true);
  expect(statementBlocksNotNull("values (1)")).toBe(true);
  expect(statementBlocksNotNull("select rollup (name) from item")).toBe(true);
  expect(statementBlocksNotNull("select cube (name) from item")).toBe(true);
  expect(statementBlocksNotNull("select grouping (name) from item")).toBe(true);
});

test("the spike shapes stay nullable", () => {
  const nullable = (sql: string, facts: AttributeFacts | undefined, tableOid = 1, attnum = 1) =>
    columnNullability(sql, { name: "id", tableOid, attnum }, facts).nullable;
  expect(nullable("select o.id from item i left join other o on true", base)).toBe(true);
  expect(nullable("select i.name from item i right join other o on true", base)).toBe(true);
  expect(
    nullable(
      "with j as (select o.id from item i left join other o on true) select id from j",
      base,
    ),
  ).toBe(true);
  expect(nullable("select name from item union all select name from item", base, 0, 0)).toBe(true);
  expect(nullable("select name from item_view", { ...base, relkind: "v", attnotnull: false })).toBe(
    true,
  );
  expect(
    nullable("select doubled from item", { ...base, attgenerated: "s", attnotnull: false }),
  ).toBe(true);
  expect(nullable("select doubled from item", { ...base, attgenerated: "s" })).toBe(true);
  expect(nullable("select checked from item", { ...base, attnotnull: false })).toBe(true);
});

test("a plain base column is not null, and the suffix overrides either way", () => {
  expect(columnNullability("select name from item", column, base)).toEqual({
    name: "name",
    nullable: false,
  });
  expect(
    columnNullability(
      "select id from item",
      { name: "id", tableOid: 1, attnum: 1 },
      {
        ...base,
        attidentity: "a",
      },
    ),
  ).toEqual({ name: "id", nullable: false });
  expect(
    columnNullability(
      'select note as "note!" from item i left join other o on true',
      {
        name: "note!",
        tableOid: 1,
        attnum: 4,
      },
      { ...base, attnotnull: false },
    ),
  ).toEqual({ name: "note", nullable: false });
  expect(
    columnNullability('select name as "name?" from item', { ...column, name: "name?" }, base),
  ).toEqual({
    name: "name",
    nullable: true,
  });
  expect(
    columnNullability("select name from item", column, { ...base, relkind: "p" }).nullable,
  ).toBe(false);
});
