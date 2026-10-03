import { readFileSync } from "node:fs";
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
 * it to send a CancelRequest.
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
  for (const file of files) {
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
 * The core imports of Node that a driver socket needs.
 *
 * @param root - Repository or fixture root
 * @param file - Source file
 * @param specifier - Import specifier
 * @returns Whether this import is an allowed driver socket
 */
function nodeImportAllowed(root: string, file: string, specifier: string): boolean {
  return specifier === "node:net" && NODE_NET.has(relative(root, file));
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
