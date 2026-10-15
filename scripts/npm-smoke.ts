/**
 * Installs the published package from npm and runs the guide quickstart.
 *
 * The version comes from `package.json`. Registry propagation is retried at
 * most {@link ATTEMPTS} times, {@link WAIT_MS} apart. The run fails when that
 * version is missing, its provenance attestation is missing, or the attestation's
 * git commit is not `RELEASE_COMMIT` (the QA'd SHA). `npm view` only carries the
 * predicate type. The commit is in the signed statement at the attestations URL.
 *
 *   bun ./scripts/npm-smoke.ts
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import {
  command,
  fenceFileName,
  markdownFences,
  removeProject,
  shellCommands,
  tempProject,
} from "../tests/doc-run.js";
import { releaseCommitProblem, releaseCommitSha } from "./release-ref.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** SLSA provenance predicate on an npm publish attestation. */
const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";

/**
 * A refusal that will not change on retry.
 *
 * A missing version is propagation. A recorded commit that is not the QA'd
 * SHA is the published package, and waiting does not fix it.
 */
class SmokeStop extends Error {}

/** How many times the registry is asked before the smoke fails. */
const ATTEMPTS = 6;

/** Pause between registry attempts. */
const WAIT_MS = 10_000;

/**
 * Why a published version cannot be smoked, or undefined when it can.
 *
 * Accepts `npm view <name>@<version> version dist.attestations --json`.
 *
 * @param view - Parsed npm view JSON
 * @param version - Version the workflow just published
 * @returns The problem, or undefined when the version and its provenance are present
 */
export function publishedPackageProblem(view: unknown, version: string): string | undefined {
  if (!isRecord(view)) return "npm view did not return an object";
  if (view.version !== version) {
    return `npm has version ${shown(view.version)}, expected ${version}`;
  }
  const attestations = attestationsOf(view);
  if (attestations === undefined) return `okmodel@${version} has no provenance attestation`;
  const provenance = attestations.provenance;
  if (!isRecord(provenance)) return `okmodel@${version} provenance is missing`;
  return undefined;
}

/**
 * Why the published provenance does not record `commit`.
 *
 * `document` is the JSON from `dist.attestations.url`. The git SHA is
 * `predicate.buildDefinition.resolvedDependencies[].digest.gitCommit` inside
 * the SLSA statement, base64-encoded in the DSSE envelope.
 *
 * @param document - Parsed attestations document
 * @param commit - QA'd commit, a full 40-hex SHA
 * @returns The problem, or undefined when every recorded git commit is that SHA
 */
export function provenanceCommitProblem(document: unknown, commit: string): string | undefined {
  const qa = releaseCommitSha(commit);
  if (qa === undefined) return releaseCommitProblem(commit);
  const recorded = recordedCommits(document);
  if (!recorded.ok) return recorded.problem;
  if (recorded.commits.length === 0) return "provenance does not record a git commit";
  const unique = [...new Set(recorded.commits)];
  if (unique.length === 1 && unique[0] === qa) return undefined;
  return `provenance records commit ${unique.join(", ")}, not the QA'd commit ${qa}`;
}

/** Git commits named by a provenance document, or why the document cannot be read. */
type RecordedCommits =
  | { readonly ok: true; readonly commits: readonly string[] }
  | { readonly ok: false; readonly problem: string };

/**
 * Every `gitCommit` digest in the SLSA provenance statement.
 *
 * @param document - Parsed attestations document
 * @returns Those SHAs, or why no statement could be read
 */
function recordedCommits(document: unknown): RecordedCommits {
  if (!isRecord(document) || !Array.isArray(document.attestations)) {
    return { ok: false, problem: "npm attestations response is not an attestations document" };
  }
  const commits: string[] = [];
  let sawProvenance = false;
  for (const item of document.attestations) {
    if (!isRecord(item) || item.predicateType !== SLSA_PROVENANCE) continue;
    sawProvenance = true;
    const statement = statementOf(item);
    if (!statement.ok) return statement;
    commits.push(...statement.commits);
  }
  if (!sawProvenance) return { ok: false, problem: "provenance attestation is missing" };
  return { ok: true, commits };
}

/** Decoded `gitCommit` values from one attestation, or why the payload failed. */
type StatementCommits =
  | { readonly ok: true; readonly commits: readonly string[] }
  | { readonly ok: false; readonly problem: string };

/**
 * Reads `gitCommit` digests out of one SLSA attestation envelope.
 *
 * @param item - One entry of `attestations`
 * @returns The digests, or why the envelope could not be read
 */
function statementOf(item: Record<string, unknown>): StatementCommits {
  const bundle = item.bundle;
  const envelope = isRecord(bundle) ? bundle.dsseEnvelope : undefined;
  const payload = isRecord(envelope) ? envelope.payload : undefined;
  if (typeof payload !== "string" || payload.length === 0) {
    return { ok: false, problem: "provenance attestation could not be read" };
  }
  let statement: unknown;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    statement = JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as unknown;
  } catch {
    return { ok: false, problem: "provenance attestation could not be read" };
  }
  if (!isRecord(statement) || !isRecord(statement.predicate)) {
    return { ok: false, problem: "provenance attestation could not be read" };
  }
  const build = statement.predicate.buildDefinition;
  if (!isRecord(build) || !Array.isArray(build.resolvedDependencies)) {
    return { ok: false, problem: "provenance attestation could not be read" };
  }
  const commits: string[] = [];
  for (const dependency of build.resolvedDependencies) {
    if (!isRecord(dependency) || !isRecord(dependency.digest)) continue;
    const sha = dependency.digest.gitCommit;
    if (typeof sha === "string" && sha.length > 0) commits.push(sha.toLowerCase());
  }
  return { ok: true, commits };
}

function attestationsOf(view: Record<string, unknown>): Record<string, unknown> | undefined {
  const dotted = view["dist.attestations"];
  if (isRecord(dotted)) return dotted;
  const dist = view.dist;
  if (isRecord(dist) && isRecord(dist.attestations)) return dist.attestations;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shown(value: unknown): string {
  return typeof value === "string" ? value : "(missing)";
}

async function untilReady(label: string, fn: () => Promise<boolean>): Promise<void> {
  let last = `${label} did not succeed`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      if (await fn()) return;
      last = `${label} is not ready`;
    } catch (error) {
      if (error instanceof SmokeStop) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < ATTEMPTS) await Bun.sleep(WAIT_MS);
  }
  throw new Error(`${last} after ${String(ATTEMPTS)} attempts, ${String(WAIT_MS)} ms apart`);
}

function readVersion(root: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!isRecord(parsed) || typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json version is not a string");
  }
  return parsed.version;
}

async function viewPackage(version: string): Promise<unknown> {
  const proc = Bun.spawn(
    ["npm", "view", `okmodel@${version}`, "version", "dist.attestations", "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`npm view exited ${String(code)}\n${stderr}`);
  return JSON.parse(stdout);
}

/**
 * Registry URL of the signed attestations for the viewed version.
 *
 * @param view - Parsed `npm view` JSON
 * @returns An `https://registry.npmjs.org/` URL, or undefined when it is absent
 */
function attestationsUrl(view: unknown): string | undefined {
  if (!isRecord(view)) return undefined;
  const attestations = attestationsOf(view);
  const url = attestations?.url;
  if (typeof url !== "string" || !url.startsWith("https://registry.npmjs.org/")) return undefined;
  return url;
}

/**
 * Fetches the attestations document.
 *
 * @param url - `dist.attestations.url` from the registry
 * @returns Parsed JSON
 */
async function fetchAttestations(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GET ${url} returned ${String(response.status)}`);
  return (await response.json()) as unknown;
}

/**
 * A recorded commit that is not the QA'd SHA, which a retry will not change.
 *
 * @param problem - Result of {@link provenanceCommitProblem}
 * @returns Whether the smoke should stop instead of waiting on the registry
 */
function commitRefusal(problem: string): boolean {
  return (
    problem.startsWith("provenance records commit") ||
    problem === "provenance does not record a git commit"
  );
}

/**
 * Installs `okmodel@version` and runs the guide quickstart on two databases.
 *
 * @param root - Repository root, for `docs/guide.md`
 * @param version - Published version
 */
async function runQuickstart(root: string, version: string): Promise<void> {
  const markdown = readFileSync(join(root, "docs/guide.md"), "utf8");
  const fences = markdownFences(markdown);
  const files = new Map<string, string>();
  const usage: string[] = [];
  for (const fence of fences) {
    if (fence.lang !== "ts") continue;
    const name = fenceFileName(fence.label);
    if (name === undefined) usage.push(fence.code);
    else files.set(name, fence.code);
  }
  if (usage.length === 0) throw new Error("docs/guide.md has no usage blocks");
  files.set("run.ts", usage.join("\n"));
  const commands = fences
    .filter((fence) => fence.lang === "sh")
    .flatMap((fence) => shellCommands(fence.code));
  const dir = tempProject("okm-npm-smoke-");
  const manifest = `${JSON.stringify({ name: "okm-npm-smoke", private: true, type: "module" })}\n`;
  try {
    await untilReady(`okmodel@${version}`, async () => {
      writeFileSync(join(dir, "package.json"), manifest);
      rmSync(join(dir, "node_modules"), { recursive: true, force: true });
      rmSync(join(dir, "bun.lock"), { force: true });
      await command(dir, ["bun", "add", `okmodel@${version}`, "postgres"]);
      return true;
    });
    for (const [name, source] of files) writeFileSync(join(dir, name), source);
    const pushCommands = commands.filter((line) => line.startsWith("bunx okm push"));
    const migrateCommands = commands.filter(
      (line) => line.startsWith("bunx okm generate") || line.startsWith("bunx okm migrate apply"),
    );
    if (pushCommands.length !== 1) throw new Error("docs/guide.md must run okm push once");
    if (!migrateCommands.some((line) => line.startsWith("bunx okm generate"))) {
      throw new Error("docs/guide.md does not run okm generate");
    }
    if (!migrateCommands.some((line) => line.startsWith("bunx okm migrate apply"))) {
      throw new Error("docs/guide.md does not run okm migrate apply");
    }
    const push = await createIsolatedDatabase();
    try {
      const apply = await createIsolatedDatabase();
      try {
        for (const line of pushCommands) {
          await command(dir, line.split(/\s+/), { DATABASE_URL: push.url });
        }
        await command(dir, ["bun", "run.ts"], { DATABASE_URL: push.url });
        for (const line of migrateCommands) {
          await command(dir, line.split(/\s+/), { DATABASE_URL: apply.url });
        }
        await command(dir, ["bun", "run.ts"], { DATABASE_URL: apply.url });
      } finally {
        await apply.close();
      }
    } finally {
      await push.close();
    }
  } finally {
    removeProject(dir);
  }
}

/**
 * Installs the published version and refuses a provenance commit that is not `qa`.
 *
 * @param qa - QA'd commit
 */
async function smokePublished(qa: string): Promise<void> {
  const root = repoRoot();
  const version = readVersion(root);
  await runQuickstart(root, version);
  await untilReady(`provenance for okmodel@${version}`, async () => {
    const view = await viewPackage(version);
    const problem = publishedPackageProblem(view, version);
    if (problem !== undefined) throw new Error(problem);
    const url = attestationsUrl(view);
    if (url === undefined) throw new Error(`okmodel@${version} provenance URL is missing`);
    const document = await fetchAttestations(url);
    const commitProblem = provenanceCommitProblem(document, qa);
    if (commitProblem === undefined) return true;
    if (commitRefusal(commitProblem)) throw new SmokeStop(commitProblem);
    throw new Error(commitProblem);
  });
  console.error(
    `[npm-smoke] okmodel@${version} installed from npm and provenance commit ${qa} matches`,
  );
}

if (import.meta.main) {
  const qa = releaseCommitSha(process.env.RELEASE_COMMIT);
  if (qa === undefined) {
    exitOnProblems([
      releaseCommitProblem(process.env.RELEASE_COMMIT) ?? "Refusing to smoke without a commit.",
    ]);
  } else {
    await smokePublished(qa);
  }
}
