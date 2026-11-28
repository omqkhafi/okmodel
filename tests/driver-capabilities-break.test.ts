/**
 * `prepared` and `describe` left `DriverCapabilities` and stay out.
 *
 * The drivers page may say this in its own words. `capabilities.test.ts`
 * checks each driver against this list.
 */

import { expect, test } from "bun:test";

import { CAPABILITY_NAMES } from "../src/adapters/capabilities.js";

test("prepared and describe stay out of DriverCapabilities", () => {
  expect([...CAPABILITY_NAMES]).not.toContain("prepared");
  expect([...CAPABILITY_NAMES]).not.toContain("describe");
});
