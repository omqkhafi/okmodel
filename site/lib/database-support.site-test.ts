/**
 * Installation and the first schema are the pages that declare database support.
 */

import { expect, test } from "bun:test";

import { databaseSupportFor } from "../components/database-support";

test("installation and the first schema declare Postgres support", () => {
  expect(databaseSupportFor("/docs/start/installation")).toEqual(["postgres"]);
  expect(databaseSupportFor("/docs/start/first-schema")).toEqual(["postgres"]);
  expect(databaseSupportFor("/docs/start")).toBeUndefined();
  expect(databaseSupportFor("/docs")).toBeUndefined();
});
