/**
 * pr-sync-milestone — Closes #N extraction.
 */

import { expect, test } from "bun:test";

import { closesIssueNumber, trainMilestoneTitle } from "./pr-sync-milestone.js";

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

test("trainMilestoneTitle uses the train for a .0 release and a next build", () => {
  expect(trainMilestoneTitle("0.10.0")).toBe("0.10");
  expect(trainMilestoneTitle("0.10.0-next.24")).toBe("0.10");
  expect(trainMilestoneTitle("0.2.1")).toBe("0.2.1");
  expect(trainMilestoneTitle("0.2.1-next.3")).toBe("0.2.1");
  expect(trainMilestoneTitle("0.10.10")).toBe("0.10.10");
});
