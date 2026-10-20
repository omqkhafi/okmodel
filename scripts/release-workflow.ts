/**
 * Checks `.github/workflows/release.yml` for the release v2 rules.
 *
 * Every third-party `uses:` is a 40-hex commit. The workflow grants
 * `contents: read` at the top. `id-token: write` and `contents: write` appear
 * only on the publish job. `pull_request_target` is absent. No npm token is
 * named.
 *
 *   bun ./scripts/release-workflow.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";

/** Permissions that may appear only on the publish job. */
const PUBLISH_ONLY = ["id-token", "contents"] as const;

/**
 * `uses:` values that are not a local path and not a 40-hex pin.
 *
 * @param yaml - Workflow text
 * @returns Unpinned action refs
 */
export function unpinnedActionUses(yaml: string): readonly string[] {
  const problems: string[] = [];
  for (const match of yaml.matchAll(/^\s*uses:\s*(\S+)/gm)) {
    const uses = match[1];
    if (uses === undefined || uses.startsWith("./")) continue;
    if (/@[0-9a-f]{40}$/.test(uses)) continue;
    problems.push(uses);
  }
  return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function permissionValue(block: Record<string, unknown>, key: string): string | undefined {
  const value = block[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Problems in the release workflow text.
 *
 * @param yaml - `.github/workflows/release.yml`
 * @returns Refusal lines. Empty when the workflow matches the v2 rules
 */
export function releaseWorkflowProblems(yaml: string): readonly string[] {
  const problems: string[] = [];
  if (yaml.includes("pull_request_target")) problems.push("pull_request_target is set");
  if (/\bNPM_TOKEN\b/.test(yaml) || /\bNODE_AUTH_TOKEN\b/.test(yaml)) {
    problems.push("an npm token is named");
  }
  if (yaml.includes("secrets.")) problems.push("a secret is referenced");
  const commands = yaml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  if (/\bbun publish\b/.test(commands)) problems.push("bun publish is used");
  if (/npm publish/.test(yaml) && !yaml.includes("npm stage publish")) {
    problems.push("npm publish is used without npm stage publish");
  }
  for (const uses of unpinnedActionUses(yaml)) problems.push(`unpinned action ${uses}`);
  if (!yaml.includes("git merge-base --is-ancestor")) {
    problems.push("the ancestor check does not run git merge-base --is-ancestor");
  }
  if (!yaml.includes("npm stage publish")) problems.push("publish does not run npm stage publish");
  if (!/tags:\n(?:.*\n)*?\s+- ["']v\*["']/.test(yaml) && !yaml.includes('- "v*"')) {
    problems.push("the workflow does not trigger on tag v*");
  }
  if (!yaml.includes("workflow_dispatch:")) problems.push("workflow_dispatch is missing");

  const parsed: unknown = Bun.YAML.parse(yaml);
  if (!isRecord(parsed)) return [...problems, "workflow YAML did not parse"];
  const top = parsed.permissions;
  if (
    !isRecord(top) ||
    permissionValue(top, "contents") !== "read" ||
    Object.keys(top).length !== 1
  ) {
    problems.push("top-level permissions must be contents: read only");
  }
  const jobs = isRecord(parsed.jobs) ? parsed.jobs : {};
  const publish = jobs.publish;
  if (!isRecord(publish)) {
    problems.push("publish job is missing");
    return problems;
  }
  if (publish.environment !== "release") problems.push("publish job environment is not release");
  const publishPerms = isRecord(publish.permissions) ? publish.permissions : {};
  if (permissionValue(publishPerms, "id-token") !== "write") {
    problems.push("publish job is missing id-token: write");
  }
  if (permissionValue(publishPerms, "contents") !== "write") {
    problems.push("publish job is missing contents: write");
  }
  const steps = Array.isArray(publish.steps) ? publish.steps : [];
  const publishStep = steps.find(
    (step) => isRecord(step) && typeof step.run === "string" && step.run.includes("stage-publish"),
  );
  if (!isRecord(publishStep)) problems.push("publish job has no stage-publish step");
  else {
    const gate = publishStep.if;
    if (typeof gate !== "string" || !gate.includes("inputs.publish")) {
      problems.push("the publish step is not skipped when inputs.publish is false");
    }
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (!isRecord(job) || !isRecord(job.permissions)) continue;
    for (const key of PUBLISH_ONLY) {
      const value = permissionValue(job.permissions, key);
      if (value === "write" && name !== "publish") {
        problems.push(`${name} has ${key}: write`);
      }
    }
    if (name !== "publish" && permissionValue(job.permissions, "id-token") !== undefined) {
      problems.push(`${name} sets id-token`);
    }
  }
  const verify = jobs.verify;
  if (!isRecord(verify)) problems.push("verify job is missing");
  else {
    const needs = verify.needs;
    const needsPublish = needs === "publish" || (Array.isArray(needs) && needs.includes("publish"));
    if (!needsPublish) problems.push("verify job does not need publish");
    const verifySteps = Array.isArray(verify.steps) ? verify.steps : [];
    const runsVerify = verifySteps.some(
      (step) =>
        isRecord(step) && typeof step.run === "string" && step.run.includes("verify-release.ts"),
    );
    if (!runsVerify) problems.push("verify job does not run verify-release.ts");
    const verifyRun = verifySteps.find(
      (step) =>
        isRecord(step) && typeof step.run === "string" && step.run.includes("verify-release.ts"),
    );
    if (
      isRecord(verifyRun) &&
      typeof verifyRun.run === "string" &&
      !verifyRun.run.includes("--recorded")
    ) {
      problems.push("verify job does not pass --recorded");
    }
  }
  if (!yaml.includes("name: release-record")) problems.push("release record artifact is missing");
  if (!yaml.includes("GITHUB_STEP_SUMMARY")) {
    problems.push("the pack job does not write the job summary");
  }
  const packCount = commands.match(/\bbun pm pack\b/g)?.length ?? 0;
  if (packCount !== 1) problems.push("the release workflow must pack once");
  const tag = jobs.tag;
  if (!isRecord(tag) || !Array.isArray(tag.steps)) problems.push("tag job is missing");
  else if (tag.steps.some((step) => isRecord(step) && step.run === "bun run build")) {
    problems.push("the tag job builds before the checks");
  }
  return problems;
}

if (import.meta.main) {
  const yaml = readFileSync(join(repoRoot(), ".github/workflows/release.yml"), "utf8");
  const problems = releaseWorkflowProblems(yaml);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log("release workflow matches the v2 rules");
}
