/**
 * Fails when the vendored OKID copy leaves the recorded hashes.
 *
 * When okengine is checked out beside this repo, or `OKENGINE_SRC` points at
 * its `src` directory, the script also compares that source. Otherwise it
 * compares the vendored files with the hash recorded at vendor time.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

const FILES = ["okid.ts", "okid-shared.ts", "okid-extended.ts"] as const;

type Recorded = {
  readonly okengine: Readonly<Record<string, string>>;
  readonly copy: Readonly<Record<string, string>>;
};

if (import.meta.main) {
  const root = repoRoot();
  const problems = driftProblems(root);
  for (const line of problems) console.error(line);
  const note = driftNote(root);
  if (note !== undefined) console.log(note);
  exitOnProblems(problems);
}

/**
 * Reports drift between the vendored OKID files, the recorded hashes, and
 * okengine when that tree is present.
 *
 * @param root - Repository root
 * @returns Problem lines. Empty when the copy matches
 */
export function driftProblems(root: string): readonly string[] {
  const recorded = readRecord(root);
  if (typeof recorded === "string") return [recorded];
  const problems: string[] = [];
  const dir = join(root, "src/runtime/ids");
  for (const name of FILES) {
    const hash = sha256(readFileSync(join(dir, name)));
    const expected = recorded.copy[name];
    if (hash !== expected) {
      problems.push(
        `okid-drift: ${name} is ${hash}, recorded ${expected ?? "missing"}. Update the vendor record in the same commit as the copy.`,
      );
    }
  }
  const engine = engineDir(root);
  if (engine === undefined) return problems;
  for (const name of FILES) {
    const path = join(engine, name);
    if (!existsSync(path)) {
      problems.push(`okid-drift: ${path} is missing.`);
      continue;
    }
    const hash = sha256(readFileSync(path));
    const expected = recorded.okengine[name];
    if (hash !== expected) {
      problems.push(
        `okid-drift: okengine ${name} is ${hash}, recorded ${expected ?? "missing"}. Re-vendor OKID.`,
      );
    }
    const ours = readFileSync(join(dir, name), "utf8");
    const theirs = readFileSync(path, "utf8");
    const left = normalise(name, ours);
    const right = normalise(name, theirs);
    if (left !== right) {
      problems.push(`okid-drift: ${name} does not match okengine after the allowed import change.`);
    }
  }
  return problems;
}

function driftNote(root: string): string | undefined {
  if (engineDir(root) !== undefined) {
    return "okid-drift: compared the vendored files with okengine.";
  }
  return "okid-drift: okengine source was not beside the repo, so the check used the recorded hash.";
}

function readRecord(root: string): Recorded | string {
  const path = join(root, "src/runtime/ids/okid.vendor.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `okid-drift: cannot read ${path}: ${message}`;
  }
  if (!isRecord(parsed) || !isHashMap(parsed.okengine) || !isHashMap(parsed.copy)) {
    return "okid-drift: okid.vendor.json needs okengine and copy hash maps.";
  }
  return { okengine: parsed.okengine, copy: parsed.copy };
}

function engineDir(root: string): string | undefined {
  const fromEnv = process.env.OKENGINE_SRC;
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(join(fromEnv, "okid.ts"))) {
    return fromEnv;
  }
  const sibling = join(root, "../okengine/src");
  if (existsSync(join(sibling, "okid.ts"))) return sibling;
  return undefined;
}

function normalise(name: (typeof FILES)[number], source: string): string {
  const stripped = source.replace(/^\/\*\*[\s\S]*?Vendored from okengine[\s\S]*?\*\/\n\n/, "");
  if (name === "okid-extended.ts") {
    return stripped.replaceAll('from "./okid-shared.js"', 'from "./okid-shared.ts"');
  }
  if (name === "okid.ts") {
    const marker = "export function okid";
    const index = stripped.indexOf(marker);
    const body = index < 0 ? stripped : stripped.slice(index);
    return body.replace(
      "return loadOkidExtended().okidWithOptions(options);",
      "return okidWithOptions(options);",
    );
  }
  return stripped;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isHashMap(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false;
  return FILES.every((name) => typeof value[name] === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
