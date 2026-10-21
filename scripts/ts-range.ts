/**
 * Compiles the public type surface and the consumer fixtures.
 *
 * TypeScript 7 is the repository compiler (`typescript`, `tsc`). That run is
 * required: `bun run typecheck` calls this script after the repository
 * typecheck. TypeScript 6.0.x is the dev-only `typescript-editor` alias.
 * `bun run ts6:check` runs it and is not part of `bun run check`.
 *
 * The script spawns `tsc.js`. It does not import the compiler. TypeScript 7.0
 * has no stable programmatic API until 7.1.
 *
 *   bun ./scripts/ts-range.ts
 *   bun ./scripts/ts-range.ts --editor
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { API_ENTRIES } from "./api-surface.js";
import { repoRoot } from "./root.js";

/** TypeScript 7 compiler shipped as `typescript`. Required. */
export const REQUIRED_COMPILER = "node_modules/typescript/lib/tsc.js";

/** TypeScript 6.0.x compiler shipped as `typescript-editor`. Informational. */
export const EDITOR_COMPILER = "node_modules/typescript-editor/lib/tsc.js";

/** Directories walked for `*.test-d.ts` consumer fixtures. */
const FIXTURE_ROOTS = ["tests", "packages/spikes"] as const;

/**
 * Public entry files, relative to the repository, forward slashes.
 *
 * @returns One path per {@link API_ENTRIES} subpath
 */
export function publicSurfaceFiles(): readonly string[] {
  return API_ENTRIES.map((entry) => entry.file).sort();
}

/**
 * Consumer fixtures the required typecheck compiles.
 *
 * A `*.test-d.ts` file under `tests/` or `packages/spikes/` is included when
 * `tsconfig.json` includes it. Negative fixtures under `tests/fixtures` are
 * excluded there, so they are not in this list.
 *
 * @param root - Repository root
 * @returns Forward-slash paths, sorted
 */
export function consumerFixtureFiles(root: string): readonly string[] {
  const config = typecheckConfig(root);
  const found: string[] = [];
  for (const start of FIXTURE_ROOTS) walkTestD(join(root, start), root, found);
  return found.filter((file) => coveredByTypecheck(file, config)).sort();
}

/**
 * Public entries plus consumer fixtures.
 *
 * @param root - Repository root
 * @returns Forward-slash paths, sorted, without duplicates
 */
export function surfaceFiles(root: string): readonly string[] {
  return [...new Set([...publicSurfaceFiles(), ...consumerFixtureFiles(root)])].sort();
}

/**
 * Problems when a public entry is outside the required typecheck.
 *
 * @param root - Repository root
 * @returns Problem lines
 */
export function surfaceCoverageProblems(root: string): readonly string[] {
  const config = typecheckConfig(root);
  const problems: string[] = [];
  for (const file of publicSurfaceFiles()) {
    if (!coveredByTypecheck(file, config)) {
      problems.push(`ts-range: ${file} is outside the required typecheck`);
    }
  }
  if (consumerFixtureFiles(root).length === 0) {
    problems.push("ts-range: no consumer fixtures are in the required typecheck");
  }
  return problems;
}

/**
 * The sentence `docs/compatibility.md` prints for this range.
 *
 * Versions come from the installed packages so the page names what this
 * checkout compiles with.
 *
 * @param root - Repository root
 * @returns One paragraph, no trailing newline
 */
export function compilerRangeNote(root: string): string {
  const required = installedVersion(root, "typescript");
  const editor = installedVersion(root, "typescript-editor");
  if (!required.startsWith("7.")) {
    throw new Error(`ts-range: typescript is ${required}, expected 7.x`);
  }
  if (!editor.startsWith("6.0.")) {
    throw new Error(`ts-range: typescript-editor is ${editor}, expected 6.0.x`);
  }
  return `The public type surface (\`scripts/api-surface.ts\`) and the consumer fixtures (\`*.test-d.ts\` files the required typecheck includes) compile with TypeScript ${required} (\`tsc\`, required, \`bun run typecheck\`). The same files compile with TypeScript ${editor} through the dev-only \`typescript-editor\` package (\`bun run ts6:check\`). That run is not part of \`bun run check\`. Nothing in \`src/\` imports the TypeScript compiler API. TypeScript 7.0 has no stable programmatic API until 7.1.`;
}

/**
 * Runs one compiler on the surface.
 *
 * @param root - Repository root
 * @param mode - `required` uses TypeScript 7. `editor` uses TypeScript 6.0.x
 * @returns Exit code, compiler text, and the reported version
 */
export function compileSurface(
  root: string,
  mode: "required" | "editor",
): { readonly code: number; readonly output: string; readonly version: string } {
  const compiler = join(root, mode === "required" ? REQUIRED_COMPILER : EDITOR_COMPILER);
  const version = compilerVersion(compiler, root);
  if (mode === "required" && !version.startsWith("7.")) {
    return {
      code: 1,
      output: `ts-range: required compiler is ${version}, expected 7.x\n`,
      version,
    };
  }
  if (mode === "editor" && !version.startsWith("6.0.")) {
    return {
      code: 1,
      output: `ts-range: editor compiler is ${version}, expected 6.0.x\n`,
      version,
    };
  }
  const info =
    mode === "required" ? ".cache/tsc/check.tsbuildinfo" : ".cache/tsc/editor.tsbuildinfo";
  mkdirSync(join(root, ".cache", "tsc"), { recursive: true });
  const proc = spawnSync(
    "bun",
    [
      compiler,
      "--noEmit",
      "--pretty",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      join(root, info),
      "-p",
      join(root, "tsconfig.json"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  return { code: proc.status ?? 1, output, version };
}

if (import.meta.main) {
  const root = repoRoot();
  const mode = process.argv.includes("--editor") ? "editor" : "required";
  const coverage = surfaceCoverageProblems(root);
  if (coverage.length > 0) {
    console.error(coverage.join("\n"));
    process.exit(1);
  }
  const result = compileSurface(root, mode);
  if (result.output.length > 0) process.stdout.write(result.output);
  if (result.code !== 0) {
    const label = mode === "editor" ? "ts6:check" : "ts-range";
    console.error(`${label}: tsc ${result.version} exited ${String(result.code)}`);
    process.exit(result.code);
  }
  const label = mode === "editor" ? "ts6:check" : "ts-range";
  console.log(
    `${label}: tsc ${result.version} accepted the public surface and the consumer fixtures`,
  );
}

type TypecheckConfig = {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
};

function typecheckConfig(root: string): TypecheckConfig {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("ts-range: tsconfig.json is not an object");
  }
  const record = parsed as { include?: unknown; exclude?: unknown };
  return {
    include: stringList(record.include),
    exclude: stringList(record.exclude),
  };
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function coveredByTypecheck(file: string, config: TypecheckConfig): boolean {
  const included = config.include.some((dir) => file === dir || file.startsWith(`${dir}/`));
  const excluded = config.exclude.some((dir) => file === dir || file.startsWith(`${dir}/`));
  return included && !excluded;
}

function walkTestD(dir: string, root: string, found: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTestD(path, root, found);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test-d.ts")) {
      found.push(relative(root, path).split(sep).join("/"));
    }
  }
}

function installedVersion(root: string, name: string): string {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, "node_modules", name, "package.json"), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error(`ts-range: ${name} has no version`);
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`ts-range: ${name} has no version`);
  }
  return version;
}

function compilerVersion(compiler: string, root: string): string {
  const proc = spawnSync("bun", [compiler, "--version"], { cwd: root, encoding: "utf8" });
  const match = /(\d+\.\d+\.\d+)/.exec(`${proc.stdout ?? ""}${proc.stderr ?? ""}`);
  if (match?.[1] === undefined) {
    throw new Error(`ts-range: ${compiler} did not report a version`);
  }
  return match[1];
}
