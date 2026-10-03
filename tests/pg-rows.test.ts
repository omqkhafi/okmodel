/**
 * The emitted declaration file matches `emitRowTypes` for the row fixture.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { emitRowTypes } from "../src/dialects/pg/emit.js";
import { repoRoot } from "../scripts/root.js";
import { appSchema } from "./row-types-schema.js";

test("emitted row types match the checked declaration file", () => {
  const file = readFileSync(join(repoRoot(), "tests", "row-types-emitted.d.ts"), "utf8");
  expect(emitRowTypes(appSchema)).toBe(file);
});
