/**
 * Pull-request comment for `okm migrate plan --json` (D279).
 *
 * The text comes from the plan document. It does not read the human plan.
 */

import { parsePlanJson, type PlanDocument } from "../migrate/plan-json.js";

/**
 * Hidden marker that identifies the sticky comment.
 *
 * A later push updates the comment whose body contains this marker.
 */
export const PLAN_COMMENT_MARKER = "<!-- okmodel-migrate-plan -->";

/** A comment the sticky update may replace. */
export type StickyComment = {
  readonly id: number;
  readonly body: string;
};

/**
 * Renders the plan comment.
 *
 * The first heading is the strictest class. Each step is one table row
 * with its class and lock. The lock is the plan's lock line, including a
 * row estimate when the plan printed one. Lint findings keep their codes.
 *
 * @param plan - Document from `okm migrate plan --json`
 * @returns Markdown, including {@link PLAN_COMMENT_MARKER}
 */
export function renderPlanComment(plan: PlanDocument): string {
  const lines = [PLAN_COMMENT_MARKER, "", `## ${plan.class}`, ""];
  if (plan.steps.length === 0) {
    lines.push("No steps.", "");
  } else {
    lines.push("| Step | Class | Lock |", "| --- | --- | --- |");
    plan.steps.forEach((step, index) => {
      lines.push(`| ${String(index + 1)} | ${step.class} | ${cell(step.lock)} |`);
    });
    lines.push("");
  }
  lines.push("### Lint", "");
  if (plan.findings.length === 0) {
    lines.push("No lint findings.", "");
  } else {
    for (const finding of plan.findings) {
      lines.push(
        `- ${finding.severity} ${finding.code} ${cell(finding.place)}: ${cell(finding.reason)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Comment body for a plan file, or a status line when the file is not a document.
 *
 * The status line records exit codes only. It does not include command text.
 *
 * @param text - Stdout of `okm migrate plan --json`, when the file exists
 * @param checkStatus - Exit code of `okm migrate check`
 * @param planStatus - Exit code of `okm migrate plan --json`
 * @returns The comment body
 */
export function planCommentBody(
  text: string | undefined,
  checkStatus: string,
  planStatus: string,
): string {
  if (text !== undefined && text.trim().length > 0) {
    try {
      return renderPlanComment(parsePlanJson(text));
    } catch {
      // The file is not a plan document. The status line below still posts.
    }
  }
  return `${PLAN_COMMENT_MARKER}\n\nokm migrate check exited ${checkStatus}.\nokm migrate plan --json exited ${planStatus}.\n`;
}

/**
 * The comment to update, when one already carries the marker.
 *
 * The first match wins. A missing match means the caller creates a comment.
 *
 * @param comments - Comments already on the pull request
 * @returns The id to update, or `undefined` to create one
 */
export function stickyCommentTarget(
  comments: readonly StickyComment[],
): { readonly updateId: number } | undefined {
  const found = comments.find((comment) => comment.body.includes(PLAN_COMMENT_MARKER));
  if (found === undefined) return undefined;
  return { updateId: found.id };
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}
