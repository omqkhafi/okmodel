/**
 * Title labels: one `type:`, and `area:` when the scope is an area.
 */

import { expect, test } from "bun:test";

import { labelEdits, labelsForTitle } from "./pr-labels.js";

test("a known scope sets the type and the area", () => {
  expect(labelsForTitle("feat(runtime): route reads")).toEqual({
    typeLabel: "type: feat",
    areaLabel: "area: runtime",
  });
});

test("an unknown scope sets only the type", () => {
  expect(labelsForTitle("chore(deps): bump the npm group")).toEqual({
    typeLabel: "type: chore",
    areaLabel: undefined,
  });
});

test("a bad title sets nothing", () => {
  expect(labelsForTitle("Route reads")).toBeUndefined();
});

test("label edits replace a stale type and keep an existing area", () => {
  expect(
    labelEdits(["type: fix", "area: runtime", "area: ci"], {
      typeLabel: "type: feat",
      areaLabel: "area: runtime",
    }),
  ).toEqual({ add: ["type: feat"], remove: ["type: fix"] });
});

test("label edits add a missing area and leave other areas", () => {
  expect(labelEdits(["area: ci"], { typeLabel: "type: feat", areaLabel: "area: runtime" })).toEqual(
    { add: ["type: feat", "area: runtime"], remove: [] },
  );
});
