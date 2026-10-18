import { expect, test } from "bun:test";

import { openPreparedPglite } from "../packages/harness/src/pglite-template.js";

const DDL = ["create table notes (id text primary key, title text)"];

test("a prepared PGlite copy does not see another copy's rows", async () => {
  const left = await openPreparedPglite(DDL);
  const right = await openPreparedPglite(DDL);
  try {
    await left.execute("insert into notes (id, title) values ('a', 'one')");
    const rows = await right.execute("select id from notes");
    expect(rows.rows).toEqual([]);
    const own = await left.execute("select id from notes");
    expect(own.rows).toEqual([["a"]]);
  } finally {
    await left.close();
    await right.close();
  }
});
