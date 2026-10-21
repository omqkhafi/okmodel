/**
 * OID resolution against a fake catalog. Nothing is cached across calls.
 */

import { expect, test } from "bun:test";

import { resolvePgTypes, type CatalogQuery } from "../src/tooling/describe/types.js";

const rows = new Map<number, readonly (string | null)[]>([
  [23, ["23", "int4", "b", "N", "0", "0", "pg_catalog"]],
  [25, ["25", "text", "b", "S", "0", "0", "pg_catalog"]],
  [1009, ["1009", "_text", "b", "A", "25", "0", "pg_catalog"]],
  [3904, ["3904", "int4range", "r", "R", "23", "0", "pg_catalog"]],
  [17000, ["17000", "mood", "e", "E", "0", "0", "public"]],
  [17001, ["17001", "_mood", "b", "A", "17000", "0", "public"]],
  [17002, ["17002", "pos", "d", "N", "0", "23", "public"]],
  [17003, ["17003", "address", "c", "C", "0", "0", "app"]],
]);

const labels = new Map<number, readonly string[]>([[17000, ["open", "closed"]]]);

function queryFor(calls: { n: number }): CatalogQuery {
  return (sql) => {
    calls.n += 1;
    if (sql.includes("pg_enum")) {
      const out: (string | null)[][] = [];
      for (const [oid, names] of labels) {
        if (!sql.includes(String(oid))) continue;
        for (const label of names) out.push([String(oid), label]);
      }
      return Promise.resolve(out);
    }
    const out: (string | null)[][] = [];
    for (const [oid, row] of rows) {
      if (sql.includes(String(oid))) out.push([...row]);
    }
    return Promise.resolve(out);
  };
}

test("built-ins, arrays, ranges, domains, enums, and composites resolve once per call", async () => {
  const calls = { n: 0 };
  const query = queryFor(calls);
  const first = await resolvePgTypes(query, [23, 1009, 3904, 17000, 17001, 17002, 17003]);
  expect(first.get(23)).toEqual({ pgType: "integer" });
  expect(first.get(1009)).toEqual({ pgType: "text[]" });
  expect(first.get(3904)).toEqual({ pgType: "int4range" });
  expect(first.get(17000)).toEqual({ pgType: "mood", enumLabels: ["open", "closed"] });
  expect(first.get(17001)).toEqual({ pgType: "mood[]", enumLabels: ["open", "closed"] });
  expect(first.get(17002)).toEqual({ pgType: "integer" });
  expect(first.get(17003)).toEqual({ pgType: "app.address" });
  const afterFirst = calls.n;
  expect(afterFirst).toBeGreaterThan(0);
  await resolvePgTypes(query, [23]);
  expect(calls.n).toBeGreaterThan(afterFirst);
});

test("an unknown oid stays unknown and does not throw", async () => {
  const resolved = await resolvePgTypes(() => Promise.resolve([]), [999999]);
  expect(resolved.get(999999)).toEqual({ pgType: "unknown" });
});
