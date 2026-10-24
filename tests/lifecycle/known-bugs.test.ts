/**
 * Known-bug matching for the lifecycle property.
 */

import { expect, test } from "bun:test";

import { matchKnownBug } from "./known-bugs.js";

test("N-11 needs both namespace and view tags", () => {
  expect(matchKnownBug(["namespace"], "drift")).toBeUndefined();
  expect(matchKnownBug(["view"], "drift")).toBeUndefined();
  expect(matchKnownBug(["namespace", "view"], "drift")?.id).toBe("N-11");
});

test("N-123 matches fk-no-action alone", () => {
  expect(matchKnownBug(["fk-no-action"], "foreign key")?.id).toBe("N-123");
});

test("message needles are optional unless listed", () => {
  expect(matchKnownBug(["generated"], "anything")?.id).toBe("N-126");
});
