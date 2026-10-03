/**
 * OKID vectors, on Bun. Node and Deno run the same function from the portable entry.
 */

import { expect, test } from "bun:test";

import { runIdChecks } from "./portable/ids.js";

test("okid and uuid vectors", () => {
  expect(() => {
    runIdChecks();
  }).not.toThrow();
});
