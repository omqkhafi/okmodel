/**
 * `prepared` and `describe` left `DriverCapabilities` without a breaking mark.
 * The drivers page records that removal.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CAPABILITY_NAMES } from "../src/adapters/capabilities.js";
import { repoRoot } from "../scripts/root.js";

test("the drivers page records the breaking removal of prepared and describe", () => {
  const drivers = readFileSync(join(repoRoot(), "site/content/docs/operate/drivers.mdx"), "utf8");
  expect(drivers).toContain("`prepared` and `describe` were removed from `DriverCapabilities`");
  expect(drivers).toContain("That removal is breaking.");
  expect([...CAPABILITY_NAMES]).not.toContain("prepared");
  expect([...CAPABILITY_NAMES]).not.toContain("describe");
});
