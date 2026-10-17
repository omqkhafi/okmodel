/**
 * Plan comment rendered from the JSON document (D279).
 *
 * Each class is a header. A lock line keeps its estimate. Findings keep
 * their codes. An empty plan has no step rows.
 */

import { expect, test } from "bun:test";

import {
  PLAN_COMMENT_BOT,
  PLAN_COMMENT_MARKER,
  planCommentBody,
  renderPlanComment,
  stickyCommentTarget,
} from "../src/tooling/github/comment.js";
import type { PlanDocument } from "../src/tooling/migrate/plan-json.js";

test("expand, contract, and unclassified are the comment header", () => {
  for (const classification of ["expand", "contract", "unclassified"] as const) {
    const text = renderPlanComment(plan({ class: classification }));
    expect(text.startsWith(PLAN_COMMENT_MARKER)).toBe(true);
    expect(text).toContain(`## ${classification}\n`);
  }
});

test("a step prints its class, lock, and row estimate", () => {
  const text = renderPlanComment(
    plan({
      class: "contract",
      steps: [
        {
          class: "contract",
          lock: "ACCESS EXCLUSIVE on tasks, about 4.2M rows",
          sql: 'alter table "public"."tasks" drop column "title"',
        },
      ],
    }),
  );
  expect(text).toContain("| 1 | contract | ACCESS EXCLUSIVE on tasks, about 4.2M rows |");
});

test("lint findings keep their codes", () => {
  const text = renderPlanComment(
    plan({
      findings: [
        {
          severity: "error",
          code: "OKM1512",
          place: "step 1",
          reason: "drops a column",
          fix: "Allow it with a reason.",
        },
      ],
    }),
  );
  expect(text).toContain("- error OKM1512 step 1: drops a column");
});

test("an empty plan has no steps and no findings", () => {
  const text = renderPlanComment(plan({}));
  expect(text).toContain("## expand\n");
  expect(text).toContain("No steps.");
  expect(text).toContain("No lint findings.");
  expect(text).not.toContain("| Step |");
});

test("a missing plan file records exit codes and keeps the marker", () => {
  const text = planCommentBody(undefined, "1", "0");
  expect(text).toContain(PLAN_COMMENT_MARKER);
  expect(text).toContain("okm migrate check exited 1.");
  expect(text).toContain("okm migrate plan --json exited 0.");
});

test("the first marked comment is the one a later push updates", () => {
  expect(
    stickyCommentTarget([
      { id: 4, body: "other", author: PLAN_COMMENT_BOT },
      { id: 9, body: `${PLAN_COMMENT_MARKER}\n## expand\n`, author: PLAN_COMMENT_BOT },
      { id: 10, body: PLAN_COMMENT_MARKER, author: PLAN_COMMENT_BOT },
    ]),
  ).toEqual({ updateId: 9 });
  expect(stickyCommentTarget([{ id: 1, body: "none", author: PLAN_COMMENT_BOT }])).toBeUndefined();
});

test("a marked comment by another author is not updated", () => {
  expect(
    stickyCommentTarget([
      { id: 4, body: `${PLAN_COMMENT_MARKER}\n## expand\n`, author: "someone-else" },
      { id: 9, body: `${PLAN_COMMENT_MARKER}\n## contract\n`, author: PLAN_COMMENT_BOT },
    ]),
  ).toEqual({ updateId: 9 });
  expect(
    stickyCommentTarget([
      { id: 4, body: `${PLAN_COMMENT_MARKER}\n## expand\n`, author: "someone-else" },
    ]),
  ).toBeUndefined();
});

function plan(overrides: Partial<PlanDocument>): PlanDocument {
  return {
    name: "github",
    class: "expand",
    steps: [],
    findings: [],
    ...overrides,
  };
}
