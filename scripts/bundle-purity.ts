/**
 * Fails when a runtime bundle contains an npm package, when `src/` imports
 * the harness barrel, or when one module is copied into more than one output.
 *
 * `okmodel` and `okmodel/pg` are built together with code splitting so a shared
 * module, including the catalog identity, is emitted once (D112).
 *
 * The barrel re-exports drivers. A router that imports `@okmodel/harness`
 * pulls those packages into the runtime bundle. Deep imports of one harness
 * file are not the barrel.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { listTypeScriptFiles } from "./files.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";
import { moduleSpecifiers } from "./specifiers.js";

/** Adapter entries. They may import a driver package only as an external. */
export const ADAPTER_ENTRIES = [
  { entry: "src/runtime/pg/postgresjs.ts", external: "postgres" },
  { entry: "src/runtime/pg/pglite.ts", external: "@electric-sql/pglite" },
] as const;

/** Published library entries that must not contain an npm package. */
export const RUNTIME_ENTRIES = ["src/contracts/index.ts", "src/dialects/pg/index.ts"] as const;

const BARREL_SPECIFIERS = new Set([
  "@okmodel/harness",
  "@okmodel/harness/index.js",
  "@okmodel/harness/index.ts",
]);

/**
 * Reports `src/` files that import the harness barrel.
 *
 * @param root - Repository root
 * @returns Problem lines
 */
export function harnessBarrelProblems(root: string): readonly string[] {
  return scanHarnessBarrel(join(root, "src"), root);
}

/**
 * Reports files under `source` that import the harness barrel.
 *
 * @param source - Directory to scan
 * @param root - Path prefix stripped from problem lines
 * @returns Problem lines
 */
export function scanHarnessBarrel(source: string, root: string): readonly string[] {
  let files: readonly string[];
  try {
    files = listTypeScriptFiles(source);
  } catch (error) {
    return [`bundle-purity: cannot read ${source}: ${messageOf(error)}`];
  }
  const problems: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const specifier of moduleSpecifiers(text)) {
      if (isHarnessBarrel(file, specifier)) {
        problems.push(
          `${relative(root, file)} imports the harness barrel (${specifier}). Import one harness file, not @okmodel/harness.`,
        );
      }
    }
  }
  return problems;
}

/**
 * Reports npm packages named in a `bun build --metafile` document.
 *
 * @param metafile - Parsed metafile JSON
 * @param label - Entry the bundle was built from
 * @returns Problem lines
 */
export function npmPackageProblems(metafile: unknown, label: string): readonly string[] {
  const paths = inputPaths(metafile);
  const packages = new Set<string>();
  for (const path of paths) {
    const name = npmPackageName(path);
    if (name !== undefined) packages.add(name);
  }
  if (packages.size === 0) return [];
  return [`bundle-purity: ${label} contains npm packages: ${[...packages].sort().join(", ")}`];
}

/**
 * Bundles the runtime entries and a harness-barrel probe.
 *
 * The probe imports `compareLsn` from `@okmodel/harness`. That import is the
 * mistake the router made. The barrel must still bundle with no npm package,
 * and `src/` must not contain the import.
 *
 * @param root - Repository root
 * @returns Problem lines
 */
export function checkBundlePurity(root: string): readonly string[] {
  const problems: string[] = [...harnessBarrelProblems(root)];
  problems.push(...bundleRuntimeEntries(root));
  problems.push(...bundleAdapterEntries(root));
  problems.push(...bundleHarnessProbe(root));
  return problems;
}

/**
 * Reports a source module that appears in more than one bundle output.
 *
 * @param metafile - Parsed `bun build --metafile` for one splitting build
 * @returns Problem lines. Empty when each module is emitted once
 */
export function duplicatedModuleProblems(metafile: unknown): readonly string[] {
  if (!isRecord(metafile) || !isRecord(metafile.outputs)) return [];
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const [output, value] of Object.entries(metafile.outputs)) {
    if (!isRecord(value) || !isRecord(value.inputs)) continue;
    for (const input of Object.keys(value.inputs)) {
      const previous = seen.get(input);
      if (previous === undefined) {
        seen.set(input, output);
        continue;
      }
      problems.push(
        `bundle-purity: ${input} is duplicated in ${previous} and ${output}. Shared modules must be emitted once.`,
      );
    }
  }
  return problems;
}

/**
 * Reports an adapter entry that does not leave its driver package external.
 *
 * Bun's metafile omits external imports, so this reads the emitted files.
 * A bundled package is also reported by {@link npmPackageProblems}.
 *
 * @param metafile - Parsed `bun build --metafile` for the adapter entries
 * @param dir - Build output directory
 * @returns Problem lines
 */
export function adapterExternalProblems(metafile: unknown, dir: string): readonly string[] {
  if (!isRecord(metafile) || !isRecord(metafile.outputs)) {
    return ["bundle-purity: adapter metafile has no outputs"];
  }
  const problems: string[] = [];
  const outputs = Object.keys(metafile.outputs);
  for (const spec of ADAPTER_ENTRIES) {
    const built = Object.values(metafile.outputs).some(
      (value) => isRecord(value) && value.entryPoint === spec.entry,
    );
    if (!built) {
      problems.push(`bundle-purity: ${spec.entry} is missing from the adapter build`);
      continue;
    }
    const needle = `from "${spec.external}"`;
    const external = outputs.some((output) =>
      readFileSync(join(dir, output), "utf8").includes(needle),
    );
    if (!external) {
      problems.push(
        `bundle-purity: ${spec.entry} must import ${spec.external} as an external, not a bundled package`,
      );
    }
  }
  return problems;
}

function bundleRuntimeEntries(root: string): readonly string[] {
  const dir = mkdtempSync(join(tmpdir(), "okm-bundle-"));
  const metafile = join(dir, "meta.json");
  try {
    const proc = Bun.spawnSync(
      [
        "bun",
        "build",
        ...RUNTIME_ENTRIES.map((entry) => join(root, entry)),
        "--target",
        "node",
        "--format",
        "esm",
        "--splitting",
        "--chunk-naming=shared/[hash].js",
        "--outdir",
        dir,
        "--root",
        join(root, "src"),
        `--metafile=${metafile}`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      return [
        `bundle-purity: bun build runtime entries exited ${String(proc.exitCode)}\n${proc.stderr.toString()}`,
      ];
    }
    const parsed: unknown = JSON.parse(readFileSync(metafile, "utf8"));
    return [...npmPackageProblems(parsed, "runtime entries"), ...duplicatedModuleProblems(parsed)];
  } catch (error) {
    return [`bundle-purity: runtime entries: ${messageOf(error)}`];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function bundleAdapterEntries(root: string): readonly string[] {
  const dir = mkdtempSync(join(tmpdir(), "okm-bundle-"));
  const metafile = join(dir, "meta.json");
  try {
    const proc = Bun.spawnSync(
      [
        "bun",
        "build",
        ...ADAPTER_ENTRIES.map((spec) => join(root, spec.entry)),
        "--target",
        "node",
        "--format",
        "esm",
        "--splitting",
        "--chunk-naming=shared/[hash].js",
        "--outdir",
        dir,
        "--root",
        join(root, "src"),
        `--metafile=${metafile}`,
        "--external",
        "postgres",
        "--external",
        "@electric-sql/pglite",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      return [
        `bundle-purity: bun build adapter entries exited ${String(proc.exitCode)}\n${proc.stderr.toString()}`,
      ];
    }
    const parsed: unknown = JSON.parse(readFileSync(metafile, "utf8"));
    return [
      ...npmPackageProblems(parsed, "adapter entries"),
      ...adapterExternalProblems(parsed, dir),
    ];
  } catch (error) {
    return [`bundle-purity: adapter entries: ${messageOf(error)}`];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function bundleHarnessProbe(root: string): readonly string[] {
  const entry = join(root, "tests", "fixtures", "bundle-purity", "src", "router.ts");
  return bundleFile(root, entry, "harness barrel probe");
}

function bundleFile(root: string, entry: string, label: string): readonly string[] {
  const dir = mkdtempSync(join(tmpdir(), "okm-bundle-"));
  const metafile = join(dir, "meta.json");
  const outfile = join(dir, "out.js");
  try {
    const proc = Bun.spawnSync(
      [
        "bun",
        "build",
        entry,
        "--target",
        "node",
        "--minify",
        "--outfile",
        outfile,
        `--metafile=${metafile}`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      return [
        `bundle-purity: bun build ${label} exited ${String(proc.exitCode)}\n${proc.stderr.toString()}`,
      ];
    }
    const parsed: unknown = JSON.parse(readFileSync(metafile, "utf8"));
    return npmPackageProblems(parsed, label);
  } catch (error) {
    return [`bundle-purity: ${label}: ${messageOf(error)}`];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isHarnessBarrel(file: string, specifier: string): boolean {
  if (BARREL_SPECIFIERS.has(specifier)) return true;
  if (!specifier.startsWith(".")) return false;
  const target = resolve(join(file, ".."), specifier);
  const normalized = target.split(sep).join("/");
  return (
    normalized.endsWith("/packages/harness/src/index.ts") ||
    normalized.endsWith("/packages/harness/src/index.js")
  );
}

function inputPaths(metafile: unknown): readonly string[] {
  if (!isRecord(metafile)) return [];
  const paths: string[] = [];
  collectPaths(metafile.inputs, paths);
  const outputs = metafile.outputs;
  if (isRecord(outputs)) {
    for (const output of Object.values(outputs)) {
      if (isRecord(output)) collectPaths(output.inputs, paths);
    }
  }
  return paths;
}

function collectPaths(value: unknown, paths: string[]): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    paths.push(key);
  }
}

function npmPackageName(path: string): string | undefined {
  const marker = "node_modules/";
  const at = path.lastIndexOf(marker);
  if (at === -1) return undefined;
  const rest = path.slice(at + marker.length);
  const parts = rest.split("/");
  const scope = parts[0];
  const name = parts[1];
  if (scope === undefined) return undefined;
  if (scope.startsWith("@") && name !== undefined) return `${scope}/${name}`;
  return scope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  exitOnProblems(checkBundlePurity(repoRoot()));
}
