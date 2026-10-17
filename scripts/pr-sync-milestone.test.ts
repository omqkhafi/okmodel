/**
 * pr-sync-milestone — Closes #N extraction.
 */

import { expect, test } from "bun:test";

import { closesIssueNumber } from "./pr-sync-milestone.js";

test("closesIssueNumber reads the last Closes line", () => {
  expect(closesIssueNumber("Summary\n\nCloses #344")).toBe(344);
});

test("closesIssueNumber ignores the Cursor agent footer", () => {
  expect(closesIssueNumber("Closes #344\n<!-- CURSOR_AGENT_PR_BODY_END -->\n\n<footer>")).toBe(344);
});

test("closesIssueNumber returns undefined without a closing line", () => {
  expect(closesIssueNumber("Refs #344")).toBeUndefined();
  expect(closesIssueNumber("")).toBeUndefined();
});
