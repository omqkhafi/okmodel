/**
 * OKM1602 and OKM1702 grew a behaviour and the handbook callouts name it.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";

test("the raw SQL page notes the OKM1602 and OKM1702 behaviour", () => {
  const page = readFileSync(join(repoRoot(), "site/content/docs/queries/index.mdx"), "utf8");
  expect(page).toContain(
    "A typed `raw(db, sql, params)` call that passes a different number of parameters than the lock is OKM1602.",
  );
  expect(page).toContain(
    "A typed `raw(db, sql, params)` call on a client of a schema with tenancy is OKM1702.",
  );
  expect(page).toContain('`trusted(client, "reason")` sends that SQL without a tenant predicate.');
});
