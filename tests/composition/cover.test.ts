/**
 * The composition cover hits every value pair and stays near sixty cases.
 */

import { expect, test } from "bun:test";

import { allPairs, compositionCover, pairsOf } from "./cover.js";

test("every factor pair appears at least once", () => {
  const cases = compositionCover();
  const again = compositionCover();
  expect(cases).toEqual(again);
  const seen = new Set<string>();
  for (const item of cases) {
    for (const id of pairsOf(item)) seen.add(id);
  }
  const missing = allPairs().filter((id) => !seen.has(id));
  expect(missing).toEqual([]);
  expect(cases.length).toBe(33);
});
