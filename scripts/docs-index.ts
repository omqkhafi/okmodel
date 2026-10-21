/**
 * Writes `docs/index.md`, the pointer index shipped in the tarball.
 *
 * The first body line is `OKModel <train> - agent index`. The train is the
 * package version with `-next.N` removed, so `bun run bump next` does not
 * change this file. Pack stamps the full version into the tarball copy.
 * There is no timestamp. The script fails when the page is over 8 KB.
 *
 *   bun ./scripts/docs-index.ts
 *   bun ./scripts/docs-index.ts --check
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { COMMANDS } from "../src/tooling/cli/spec.js";
import { ERROR_DOCS } from "../src/tooling/errors/registry.js";
import { committedDocVersion, docClass, packedDocPaths } from "./docs-pack.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** Hard cap for `docs/index.md`, in bytes. */
export const INDEX_CAP = 8192;

/** Section of the pointer index, in reading order. */
export type IndexGroup = "start" | "define" | "query" | "migrate" | "operate" | "agents";

/** One public page in the index. */
export type IndexEntry = {
  /** Repo path, forward slashes, such as `docs/guide.md`. */
  readonly path: string;
  /** One sentence: what the page is. */
  readonly purpose: string;
  /** One sentence: when to open it. */
  readonly when: string;
  /** Group heading. */
  readonly group: IndexGroup;
};

const GROUP_TITLES: readonly { readonly group: IndexGroup; readonly title: string }[] = [
  { group: "start", title: "Start" },
  { group: "define", title: "Define" },
  { group: "query", title: "Query" },
  { group: "migrate", title: "Migrate" },
  { group: "operate", title: "Operate" },
  { group: "agents", title: "Agents" },
];

/** Pointer lines for every public guide except the error pages. */
export const INDEX_ENTRIES: readonly IndexEntry[] = [
  {
    path: "docs/guide.md",
    purpose: "What OKModel is, and the shape of a schema, a query, and a migration.",
    when: "Read this first.",
    group: "start",
  },
  {
    path: "docs/quickstart.md",
    purpose: "A config, a schema, and one reviewed migration.",
    when: "Read this when starting a project.",
    group: "start",
  },
  {
    path: "docs/api.md",
    purpose: "Which package exports are stable, experimental, or internal.",
    when: "Read this before choosing an import.",
    group: "start",
  },
  {
    path: "docs/compatibility.md",
    purpose: "Postgres majors and drivers that pass conformance.",
    when: "Read this when picking a driver.",
    group: "start",
  },
  {
    path: "docs/known-limits.md",
    purpose: "Behavior this version does not have.",
    when: "Read this before assuming a feature exists.",
    group: "start",
  },
  {
    path: "docs/capabilities.md",
    purpose: "Postgres feature support taken from the registry.",
    when: "Read this before claiming a feature is native.",
    group: "start",
  },
  {
    path: "docs/using-okmodel-safely.md",
    purpose: "Pin the lockfile and read a provenance attestation.",
    when: "Read this before adding the dependency.",
    group: "start",
  },
  {
    path: "docs/index.md",
    purpose: "This pointer index.",
    when: "Read this to choose the next page.",
    group: "start",
  },
  {
    path: "docs/linter.md",
    purpose: "Lint findings on a migration plan.",
    when: "Read this when generate, plan, or check reports a finding.",
    group: "define",
  },
  {
    path: "docs/extension-compatibility.md",
    purpose: "Default versions of the bundled extensions.",
    when: "Read this when declaring an extension.",
    group: "define",
  },
  {
    path: "docs/type-change.md",
    purpose: "Expand and contract for a type change that rewrites a table.",
    when: "Read this when a column type must change.",
    group: "define",
  },
  {
    path: "docs/readme-examples.md",
    purpose: "Short samples of the public API.",
    when: "Read this to match a README snippet.",
    group: "define",
  },
  {
    path: "docs/testing.md",
    purpose: "Factories and a cross-tenant isolation check on a real database.",
    when: "Read this when writing a test.",
    group: "query",
  },
  {
    path: "docs/topology.md",
    purpose: "Primary and replica routing.",
    when: "Read this when a read should use a replica.",
    group: "query",
  },
  {
    path: "docs/warnings.md",
    purpose: "Development warnings and the okm check schema rules for keys and indexes.",
    when: "Read this when a query or a schema should report OKM2xxx advice.",
    group: "query",
  },
  {
    path: "docs/adopt-existing.md",
    purpose: "Pull, generate, then baseline an existing database.",
    when: "Read this when the database already has tables.",
    group: "migrate",
  },
  {
    path: "docs/backfill.md",
    purpose: "Batched row updates inside a migration.",
    when: "Read this when a new column must be filled.",
    group: "migrate",
  },
  {
    path: "docs/migrate-check.md",
    purpose: "Replay of migration history in a scratch schema.",
    when: "Read this before apply in CI.",
    group: "migrate",
  },
  {
    path: "docs/migration-failure.md",
    purpose: "What a failed apply leaves in okm_history and okm_steps.",
    when: "Read this when apply stops mid-step.",
    group: "migrate",
  },
  {
    path: "docs/provisioning.md",
    purpose: "An empty target installs the head snapshot.",
    when: "Read this when apply meets an empty database.",
    group: "migrate",
  },
  {
    path: "docs/github-action.md",
    purpose: "The composite action that posts a plan comment.",
    when: "Read this when wiring GitHub CI.",
    group: "migrate",
  },
  {
    path: "docs/environments.md",
    purpose: "Named targets and a preview database.",
    when: "Read this when more than one database is configured.",
    group: "migrate",
  },
  {
    path: "docs/production.md",
    purpose: "Protected targets, requireMeta, and pooler refusal.",
    when: "Read this before pointing a command at production.",
    group: "operate",
  },
  {
    path: "docs/protection.md",
    purpose: "How a protected target is recorded and refused.",
    when: "Read this before using a protection bypass flag.",
    group: "operate",
  },
  {
    path: "docs/example-app.md",
    purpose: "What the reference app proves end to end.",
    when: "Read this for a full project shape.",
    group: "operate",
  },
  {
    path: "docs/observer-events.md",
    purpose: "Event shape for connect onWrite.",
    when: "Read this when attaching a write observer.",
    group: "operate",
  },
  {
    path: "docs/untrusted.md",
    purpose: "How text from the database or an error is bounded.",
    when: "Read this when handling an error or plan JSON.",
    group: "operate",
  },
  {
    path: "docs/roles.md",
    purpose: "Least-privilege roles for an agent login.",
    when: "Read this before giving an agent a database role.",
    group: "agents",
  },
  {
    path: "docs/threat-model.md",
    purpose: "What agent use is defended against, and what is not.",
    when: "Read this before trusting an agent with apply.",
    group: "agents",
  },
];

/**
 * Renders `docs/index.md`.
 *
 * @param version - Full package version. The title uses the train form
 * @returns The page, ending in a newline
 */
export function renderDocsIndex(version: string): string {
  const train = committedDocVersion(version);
  const lines: string[] = [
    "---",
    `okmVersion: "${train}"`,
    'since: "0.10"',
    "dialects: [postgres]",
    "codes: []",
    "---",
    `OKModel ${train} - agent index`,
    "",
    "Pointer index for the docs in this package. Open one page. Do not fetch the website.",
    "",
  ];
  for (const section of GROUP_TITLES) {
    const entries = INDEX_ENTRIES.filter((entry) => entry.group === section.group);
    if (entries.length === 0) continue;
    lines.push(`## ${section.title}`, "");
    for (const entry of entries) {
      lines.push(`- \`${entry.path}\` - ${entry.purpose} - ${entry.when}`);
    }
    lines.push("");
  }
  lines.push("## Errors", "", errorRangeLine(), "");
  lines.push("## Commands", "");
  for (const command of COMMANDS) {
    lines.push(`- \`okm ${command.id}\` - ${firstSentence(command.summary)}`);
  }
  lines.push("");
  const text = `${lines.join("\n")}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > INDEX_CAP) {
    throw new Error(`docs-index: ${String(bytes)} bytes exceeds ${String(INDEX_CAP)}`);
  }
  return text;
}

/**
 * Public guides that the index does not describe.
 *
 * Error pages are the range line, not one entry each.
 *
 * @param root - Repository root
 * @returns Problem lines
 */
export function indexCoverageProblems(root: string): readonly string[] {
  const described = new Set(INDEX_ENTRIES.map((entry) => entry.path));
  const problems: string[] = [];
  for (const path of packedDocPaths(root)) {
    if (path.startsWith("docs/errors/")) continue;
    if (!described.has(path)) problems.push(`docs-index: ${path} has no index line`);
    if (docClass(path.slice("docs/".length)) !== "public") {
      problems.push(`docs-index: ${path} is not a public doc`);
    }
  }
  for (const entry of INDEX_ENTRIES) {
    if (entry.path === "docs/index.md") continue;
    if (!packedDocPaths(root).includes(entry.path)) {
      problems.push(`docs-index: ${entry.path} is not a packed public doc`);
    }
  }
  return problems;
}

/**
 * Whether `docs/index.md` matches {@link renderDocsIndex}.
 *
 * @param root - Repository root
 * @param version - Full package version
 * @returns Problem lines
 */
export function indexStaleProblems(root: string, version: string): readonly string[] {
  const path = join(root, "docs/index.md");
  let actual: string;
  try {
    actual = readFileSync(path, "utf8");
  } catch {
    return ["docs-index: docs/index.md is missing. Run bun ./scripts/docs-index.ts"];
  }
  const expected = renderDocsIndex(version);
  if (actual !== expected) {
    return ["docs-index: docs/index.md is stale. Run bun ./scripts/docs-index.ts"];
  }
  return [];
}

function errorRangeLine(): string {
  const numbers = ERROR_DOCS.map((doc) => Number(doc.code.slice(3))).filter((value) =>
    Number.isFinite(value),
  );
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  const first = `OKM${String(low)}`;
  const last = `OKM${String(high)}`;
  return `- \`docs/errors/${first}.md\` through \`docs/errors/${last}.md\` - one page per code - Read \`docs/errors/<code>.md\` when a command or a client throws that code.`;
}

function firstSentence(summary: string): string {
  const cut = summary.indexOf(". ");
  return cut === -1 ? summary : summary.slice(0, cut + 1);
}

function packageVersion(root: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error("docs-index: package.json has no version");
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string")
    throw new Error("docs-index: package.json version is not a string");
  return version;
}

if (import.meta.main) {
  const root = repoRoot();
  const check = process.argv.includes("--check");
  const problems = indexCoverageProblems(root);
  if (problems.length > 0) exitOnProblems(problems);
  const version = packageVersion(root);
  const next = renderDocsIndex(version);
  if (check) exitOnProblems(indexStaleProblems(root, version));
  else {
    writeFileSync(join(root, "docs/index.md"), next);
    console.log(
      `docs-index: wrote docs/index.md (${String(Buffer.byteLength(next, "utf8"))} bytes)`,
    );
  }
}
