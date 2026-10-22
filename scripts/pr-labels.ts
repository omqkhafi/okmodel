/**
 * Sets `type:` and, when the scope is an area, `area:` from the pull request title.
 *
 * Path labels still come from `.github/labeler.yml`. This file does not remove
 * them. A scope that is not an area leaves area labels to the path labeler.
 *
 * Usage:
 *   bun ./scripts/pr-labels.ts --pr <number>
 */

import { parseArgs } from "node:util";

import { parseConventionalTitle } from "./pr-lint.js";

/** Area label suffixes. The scope is used only when it is one of these. */
export const PR_AREAS = [
  "contracts",
  "dialects",
  "adapters",
  "runtime",
  "tooling",
  "ci",
  "docs",
  "tenancy",
  "grants",
] as const;

/** Labels derived from a title. */
export type DerivedLabels = {
  /** `type: feat` and the rest of {@link import("./pr-lint.js").TITLE_TYPES}. */
  readonly typeLabel: string;
  /** `area: <scope>` when the scope is an area. Otherwise undefined. */
  readonly areaLabel: string | undefined;
};

/** Labels to add and `type:` labels to replace. */
export type LabelEdit = {
  readonly add: readonly string[];
  readonly remove: readonly string[];
};

/**
 * The labels a title asks for.
 *
 * @param title - Pull request title
 * @returns The type label and the area label, or undefined when the title does not match
 */
export function labelsForTitle(title: string): DerivedLabels | undefined {
  const parsed = parseConventionalTitle(title);
  if (parsed === undefined) return undefined;
  const area = (PR_AREAS as readonly string[]).includes(parsed.scope)
    ? `area: ${parsed.scope}`
    : undefined;
  return { typeLabel: `type: ${parsed.type}`, areaLabel: area };
}

/**
 * Adds the derived labels and drops any other `type:` label.
 *
 * @param current - Label names already on the pull request
 * @param desired - Labels from {@link labelsForTitle}
 * @returns The add and remove sets. Empty when nothing should change
 */
export function labelEdits(current: readonly string[], desired: DerivedLabels): LabelEdit {
  const remove = current.filter(
    (label) => label.startsWith("type: ") && label !== desired.typeLabel,
  );
  const add: string[] = [];
  if (!current.includes(desired.typeLabel)) add.push(desired.typeLabel);
  if (desired.areaLabel !== undefined && !current.includes(desired.areaLabel)) {
    add.push(desired.areaLabel);
  }
  return { add, remove };
}

async function github(
  repo: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} returned ${String(response.status)}`);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

function labelNames(payload: unknown): readonly string[] {
  if (!isRecord(payload) || !Array.isArray(payload.labels)) {
    throw new Error("GitHub pull payload has no labels");
  }
  const names: string[] = [];
  for (const label of payload.labels) {
    if (!isRecord(label) || typeof label.name !== "string") {
      throw new Error("GitHub pull payload label has no name");
    }
    names.push(label.name);
  }
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: { pr: { type: "string" } },
      args: process.argv.slice(2),
    });
    const number = values.pr === undefined ? Number.NaN : Number(values.pr);
    if (!Number.isInteger(number) || number < 1) {
      console.error("[pr-labels] Usage: bun ./scripts/pr-labels.ts --pr <number>");
      process.exit(2);
    }
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (token === undefined || token.length === 0) {
      console.error("[pr-labels] GH_TOKEN or GITHUB_TOKEN is required");
      process.exit(2);
    }
    const repo = process.env.GITHUB_REPOSITORY ?? "omqkhafi/okmodel";
    const title = process.env.OKM_PR_TITLE;
    const payload = await github(repo, token, "GET", `/pulls/${String(number)}`);
    const resolved =
      title !== undefined && title.length > 0
        ? title
        : isRecord(payload) && typeof payload.title === "string"
          ? payload.title
          : "";
    const desired = labelsForTitle(resolved);
    if (desired === undefined) {
      console.log("[pr-labels] title does not match; lint reports that");
      process.exit(0);
    }
    const edit = labelEdits(labelNames(payload), desired);
    for (const name of edit.remove) {
      await github(
        repo,
        token,
        "DELETE",
        `/issues/${String(number)}/labels/${encodeURIComponent(name)}`,
      );
    }
    if (edit.add.length > 0) {
      await github(repo, token, "POST", `/issues/${String(number)}/labels`, { labels: edit.add });
    }
    console.log(
      `[pr-labels] type ${desired.typeLabel}${desired.areaLabel === undefined ? "" : `, ${desired.areaLabel}`}`,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pr-labels] ${message}`);
    process.exit(1);
  }
}
