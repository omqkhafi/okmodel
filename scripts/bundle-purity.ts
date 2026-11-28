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
 *
 * A `node:` specifier, static or dynamic, in the graph reached from the
 * published runtime entries fails. The exceptions are listed on
 * {@link NODE_SPECIFIER_EXCEPTIONS}.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { isNodeSpecifier } from "./core-purity.js";
import { listTypeScriptFiles } from "./files.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";
import { moduleSpecifiers } from "./specifiers.js";

/** Adapter entries. They may import a driver package only as an external. */
export const ADAPTER_ENTRIES = [
  { entry: "src/runtime/pg/postgresjs.ts", external: "postgres" },
  { entry: "src/runtime/pg/pglite.ts", external: "@electric-sql/pglite" },
  { entry: "src/runtime/pg/pg.ts", external: "pg" },
  { entry: "src/runtime/pg/bun.ts", external: "bun" },
  { entry: "src/runtime/pg/neon.ts", external: "@neondatabase/serverless" },
] as const;

/** Published library entries that must not contain an npm package. */
export const RUNTIME_ENTRIES = [
  "src/contracts/index.ts",
  "src/contracts/internal.ts",
  "src/dialects/pg/index.ts",
] as const;

const BARREL_SPECIFIERS = new Set([
  "@okmodel/harness",
  "@okmodel/harness/index.js",
  "@okmodel/harness/index.ts",
]);

/**
 * Reached modules that may name a Node built-in, and the specifiers they may name.
 *
 * Anything else in the runtime graph fails. `runtime/watch.ts` is not here:
 * it calls `process.getBuiltinModule` and does not import `node:async_hooks`.
 *
 * - `adapters/pg/postgresjs.ts` `node:net` — unref an idle socket. postgres.js
 *   does not hand the socket back.
 * - `adapters/pg/nodepostgres.ts` `node:net` — CancelRequest on a side socket,
 *   then unref it.
 * - `dialects/pg/catalog-require.js` `node:module` — `createRequire`, so
 *   `schema()` can load the catalog compiler. A literal `require()` is inlined
 *   into the app bundle. The call stays inside `requireSibling`, and the
 *   Workers entry never calls it. The file is JavaScript so the type graph of
 *   `schema()` does not mention Node.
 */
export const NODE_SPECIFIER_EXCEPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["adapters/pg/postgresjs.ts", new Set(["node:net"])],
  ["adapters/pg/nodepostgres.ts", new Set(["node:net"])],
  ["dialects/pg/catalog-require.js", new Set(["node:module"])],
]);

/** Published exports that are not part of the runtime graph. */
const TOOLING_EXPORTS = new Set(["./migrate", "./testing"]);

/**
 * Reports `node:` and bare Node built-in specifiers in the runtime graph.
 *
 * The graph is the published runtime entries, including dynamic `import()`
 * of relative modules. Tooling exports are not entries. A reached file under
 * `src/runtime`, `src/contracts`, `src/adapters`, or anywhere else the walk
 * goes, fails unless {@link NODE_SPECIFIER_EXCEPTIONS} names that specifier.
 *
 * @param root - Repository root
 * @returns Problem lines
 */
export function nodeSpecifierProblems(root: string): readonly string[] {
  const listed = runtimeSourceEntries(root);
  return [...listed.problems, ...nodeSpecifiersInGraph(root, listed.entries)];
}

/**
 * Reports Node specifiers reached from `entries`.
 *
 * @param root - Directory that contains the entry paths
 * @param entries - Paths relative to `root`, such as `src/runtime/pg/pglite.ts`
 * @returns Problem lines
 */
export function nodeSpecifiersInGraph(root: string, entries: readonly string[]): readonly string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const queue = [...entries];
  for (const entry of entries) {
    if (!existsSync(join(root, entry))) {
      problems.push(`bundle-purity: runtime entry is missing: ${entry}`);
    }
  }
  while (queue.length > 0) {
    const rel = queue.pop();
    if (rel === undefined || seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    let specifiers: readonly string[];
    try {
      specifiers = moduleSpecifiers(readFileSync(abs, "utf8"), abs);
    } catch (error) {
      problems.push(`bundle-purity: cannot parse ${rel}: ${messageOf(error)}`);
      continue;
    }
    for (const specifier of specifiers) {
      if (isNodeSpecifier(specifier) && !nodeSpecifierAllowed(rel, specifier)) {
        problems.push(`bundle-purity: ${rel} imports ${specifier}`);
      }
      if (!specifier.startsWith(".")) continue;
      const next = resolveRelative(abs, specifier);
      if (next === undefined) continue;
      const nextRel = relative(root, next).split(sep).join("/");
      if (!nextRel.startsWith("src/")) continue;
      queue.push(nextRel);
    }
  }
  return problems;
}

/**
 * Source files for published runtime exports, including the `workerd` condition.
 *
 * @param root - Repository root
 */
function runtimeSourceEntries(root: string): {
  readonly entries: readonly string[];
  readonly problems: readonly string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (error) {
    return {
      entries: [],
      problems: [`bundle-purity: cannot read package.json: ${messageOf(error)}`],
    };
  }
  if (!isRecord(parsed) || !isRecord(parsed.exports)) {
    return { entries: [], problems: ["bundle-purity: package.json has no exports object"] };
  }
  const found = new Set<string>();
  for (const [key, value] of Object.entries(parsed.exports)) {
    if (TOOLING_EXPORTS.has(key) || !isRecord(value)) continue;
    for (const target of Object.values(value)) {
      if (typeof target !== "string" || !target.startsWith("./dist/") || !target.endsWith(".js")) {
        continue;
      }
      const source = `src/${target.slice("./dist/".length, -".js".length)}`;
      if (existsSync(join(root, `${source}.ts`))) found.add(`${source}.ts`);
      else if (existsSync(join(root, `${source}.js`))) found.add(`${source}.js`);
      else found.add(`${source}.ts`);
    }
  }
  return { entries: [...found], problems: [] };
}

/**
 * Whether this reached file may import this Node specifier.
 *
 * @param rel - Path relative to the repository root
 * @param specifier - Import specifier
 */
function nodeSpecifierAllowed(rel: string, specifier: string): boolean {
  const key = rel.startsWith("src/") ? rel.slice("src/".length) : rel;
  return NODE_SPECIFIER_EXCEPTIONS.get(key)?.has(specifier) === true;
}

/**
 * Resolves a relative specifier to a source file.
 *
 * `.js` specifiers try the TypeScript sibling first. This matches the
 * published layout, where `import "./watch.js"` is `watch.ts`.
 *
 * @param fromFile - File that contains the import
 * @param specifier - Relative specifier
 */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base];
  if (base.endsWith(".js")) {
    const withoutJs = base.slice(0, -3);
    candidates.push(`${withoutJs}.ts`, `${withoutJs}.tsx`, join(withoutJs, "index.ts"));
  }
  candidates.push(`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

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
  const problems: string[] = [...harnessBarrelProblems(root), ...nodeSpecifierProblems(root)];
  problems.push(...bundleRuntimeEntries(root));
  problems.push(...bundleAdapterEntries(root));
  problems.push(...bundleHarnessProbe(root));
  problems.push(...operatorShakeProblems(root));
  return problems;
}

/**
 * One namespace member must not pull the other atomic write operators.
 *
 * `set` is `json.set`. `arr.append` and `arr.remove` are separate modules.
 */
const OPERATOR_SHAKES = [
  {
    name: "json",
    use: "json.set",
    keep: "src/dialects/pg/ops/json-set.ts",
    drop: ["src/dialects/pg/ops/arr-append.ts", "src/dialects/pg/ops/arr-remove.ts"],
  },
  {
    name: "arr",
    use: "arr.append",
    keep: "src/dialects/pg/ops/arr-append.ts",
    drop: ["src/dialects/pg/ops/arr-remove.ts", "src/dialects/pg/ops/json-set.ts"],
  },
  {
    name: "arr",
    use: "arr.remove",
    keep: "src/dialects/pg/ops/arr-remove.ts",
    drop: ["src/dialects/pg/ops/arr-append.ts", "src/dialects/pg/ops/json-set.ts"],
  },
] as const;

/**
 * Reports a write operator that pulls another write operator into the bundle.
 *
 * @param root - Repository root
 * @returns Problem lines. Empty when each operator shakes
 */
export function operatorShakeProblems(root: string): readonly string[] {
  const problems: string[] = [];
  const from = join(root, "src/dialects/pg/index.ts");
  for (const item of OPERATOR_SHAKES) {
    const dir = mkdtempSync(join(tmpdir(), "okm-operator-"));
    const entry = join(dir, "entry.ts");
    try {
      writeFileSync(
        entry,
        `import { ${item.name} } from ${JSON.stringify(from)};\nexport const keep = ${item.use};\n`,
      );
      const proc = Bun.spawnSync(["bun", "build", entry, "--target", "node", "--outdir", dir], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) {
        problems.push(`bundle-purity: operator shake exited ${String(proc.exitCode)}`);
        continue;
      }
      let text = "";
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".js")) continue;
        text += readFileSync(join(dir, name), "utf8");
      }
      if (!text.includes(item.keep)) {
        problems.push(`bundle-purity: operator shake dropped ${item.keep}`);
      }
      for (const banned of item.drop) {
        if (text.includes(banned)) problems.push(`bundle-purity: operator shake kept ${banned}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
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
        "--external",
        "pg",
        "--external",
        "bun",
        "--external",
        "@neondatabase/serverless",
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
