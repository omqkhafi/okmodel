/**
 * Thirty fixed queries. Each expected page is in the top three.
 */

import { expect, test } from "bun:test";

import { searchHandbook } from "./search-docs";

const QUERIES: readonly (readonly [string, string])[] = [
  ["OKM1101", "/docs/reference/errors"],
  ["OKM1102", "/docs/reference/errors"],
  ["OKM1706", "/docs/reference/errors"],
  ["rls", "/docs/schema/policies"],
  ["multi tenant", "/docs/guides/multi-tenant"],
  ["queue", "/docs/guides/queues-leases"],
  ["install okmodel and open a client", "/docs/start/installation"],
  ["first query", "/docs/start/first-query"],
  ["first migration", "/docs/start/first-migration"],
  ["declare a table", "/docs/schema/tables"],
  ["primary key", "/docs/schema/keys-and-identity"],
  ["reference another table", "/docs/schema/references"],
  ["row policy", "/docs/schema/policies"],
  ["tenant", "/docs/schema/tenancy"],
  ["trigger", "/docs/schema/triggers"],
  ["extension", "/docs/schema/extensions"],
  ["partition a table", "/docs/schema/partitions"],
  ["transaction", "/docs/queries/transactions"],
  ["watch", "/docs/queries/watch"],
  ["typed raw", "/docs/queries/typed-raw-sql"],
  ["where operators", "/docs/queries/where-operators"],
  ["prisma", "/docs/guides/from-prisma"],
  ["drizzle", "/docs/migrations/from-drizzle"],
  ["github action", "/docs/reference/github-action"],
  ["query limits", "/docs/operate/query-limits"],
  ["production check", "/docs/start/production"],
  ["vector", "/docs/schema/extensions"],
  ["enum", "/docs/schema/enums-arrays-picklists"],
  ["view", "/docs/schema/views"],
  ["cheat sheet", "/docs/start/cheat-sheet"],
];

test("thirty queries hit the expected page in the top 3", () => {
  expect(QUERIES).toHaveLength(30);
  for (const [query, expected] of QUERIES) {
    const hits = searchHandbook(query, 3).map((hit) => hit.url.split("#")[0]);
    expect(hits, `${query} -> ${hits.join(", ")}`).toContain(expected);
  }
});
