import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { listTypeScriptFiles } from "./files.js";
import { isCoreFolder } from "./layers.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";
import { moduleSpecifiers } from "./specifiers.js";

/**
 * Reports `node:*` imports below `tooling`, and runtime `dependencies` in package.json.
 *
 * Bare Node built-in specifiers (`fs`, `path`, …) count as the same dependency.
 * The tooling layer may import Node. The postgres.js adapter may import
 * `node:net` to unref an idle socket. The node-postgres adapter may import
 * it to send a CancelRequest. `catalog-require.js` may import `node:module`
 * so `schema()` can load the catalog compiler without putting it on the
 * featureless startup graph. The loader is JavaScript so a consumer typecheck
 * with `types: []` does not need Node types. `watch.ts` may dynamically import
 * `node:async_hooks` when a watch opens, so `stop()` can tell its own handler
 * from a caller. The import is not at module scope.
 */
export function checkCorePurity(options: {
  readonly root: string;
  readonly packageJsonPath?: string;
}): readonly string[] {
  const problems: string[] = [];
  problems.push(...nodeImportProblems(options.root));
  if (options.packageJsonPath !== undefined) {
    problems.push(...dependencyProblems(options.packageJsonPath));
  }
  return problems;
}

function nodeImportProblems(root: string): readonly string[] {
  const problems: string[] = [];
  let files: readonly string[];
  try {
    files = listTypeScriptFiles(root);
  } catch (error) {
    return [`core-purity: cannot read ${root}: ${messageOf(error)}`];
  }
  for (const file of [...files, ...javascriptFiles(root)]) {
    if (!isCoreFile(root, file)) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const specifier of moduleSpecifiers(text)) {
      if (nodeImportAllowed(root, file, specifier)) continue;
      if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) {
        problems.push(`${relative(root, file)} imports ${specifier}`);
      }
    }
  }
  return problems;
}

function javascriptFiles(dir: string): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...javascriptFiles(path));
      continue;
    }
    if (entry.name.endsWith(".js")) found.push(path);
  }
  return found;
}

function dependencyProblems(packageJsonPath: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    return [`core-purity: cannot read ${packageJsonPath}: ${messageOf(error)}`];
  }
  if (!isRecord(parsed)) {
    return [`core-purity: ${packageJsonPath} is not an object`];
  }
  if (!("dependencies" in parsed)) {
    return [];
  }
  const dependencies = parsed.dependencies;
  if (!isRecord(dependencies)) {
    return [`${packageJsonPath} has a dependencies field that is not an object`];
  }
  const names = Object.keys(dependencies);
  if (names.length === 0) {
    return [`${packageJsonPath} must not declare runtime dependencies`];
  }
  return [`${packageJsonPath} has runtime dependencies: ${names.join(", ")}`];
}

function isCoreFile(root: string, file: string): boolean {
  const top = relative(root, file).split(sep)[0];
  return isCoreFolder(top);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The two core imports of `node:net`.
 *
 * postgres.js does not hand back its socket, so that adapter opens one and
 * unrefs it. node-postgres cancel opens a side socket and unrefs it. The
 * check root is `src/`, so the path has no `src` prefix.
 */
const NODE_NET = new Set([
  join("adapters", "pg", "postgresjs.ts"),
  join("adapters", "pg", "nodepostgres.ts"),
]);

/**
 * `createRequire` for the catalog compiler.
 *
 * A literal `require()` is inlined into the app bundle. This is the one
 * dialects file allowed to import `node:module`. It is JavaScript so the
 * type graph of `schema()` does not mention Node.
 */
const NODE_MODULE = new Set([join("dialects", "pg", "catalog-require.js")]);

/**
 * Dynamic `node:async_hooks` for `stop()` inside a watch handler.
 *
 * The startup graph does not load `watch.ts`. A missing built-in is caught
 * at the call, and `stop()` keeps waiting on that runtime.
 */
const NODE_ASYNC_HOOKS = new Set([join("runtime", "watch.ts")]);

/**
 * The core imports of Node that a driver socket or the catalog loader needs.
 *
 * @param root - Repository or fixture root
 * @param file - Source file
 * @param specifier - Import specifier
 * @returns Whether this import is an allowed driver socket or the catalog loader
 */
function nodeImportAllowed(root: string, file: string, specifier: string): boolean {
  const path = relative(root, file);
  if (specifier === "node:net" && NODE_NET.has(path)) return true;
  if (specifier === "node:async_hooks" && NODE_ASYNC_HOOKS.has(path)) return true;
  return specifier === "node:module" && NODE_MODULE.has(path);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const NODE_BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

if (import.meta.main) {
  const root = repoRoot();
  exitOnProblems(
    checkCorePurity({
      root: join(root, "src"),
      packageJsonPath: join(root, "package.json"),
    }),
  );
}
