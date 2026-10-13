/**
 * Let's start is the page that declares database support.
 */

import { expect, test } from "bun:test";

import { databaseSupportFor } from "../components/database-support";

test("Let's start is the only page that declares Postgres support", () => {
  expect(databaseSupportFor("/docs/start")).toEqual(["postgres"]);
  expect(databaseSupportFor("/docs")).toBeUndefined();
});
