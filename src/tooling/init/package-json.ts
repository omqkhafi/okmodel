/**
 * Minimal `package.json` edit for `okm init`.
 *
 * Only `dependencies` and `scripts` change. Key order and indentation are
 * kept. A file that already has the keys is returned byte for byte.
 */

import { initError, type InitDriver, type InitPackageManager } from "./guards.js";
import { DRIVER_PACKAGES, INIT_SCRIPTS, scriptCommand } from "./text.js";

/** One dependency or script edit. `value` is present only when init adds it. */
export type PackageEdit = {
  readonly key: string;
  readonly action: "add" | "skip";
  readonly value?: string;
};

/** Versions init may write. */
export type PackageVersions = {
  /** Running `okmodel` version, without a range prefix. */
  readonly okmodel: string;
  /** Peer ranges from the running package, keyed by npm name. */
  readonly peers: Readonly<Record<string, string>>;
};

/**
 * Patches dependencies and scripts.
 *
 * @param text - Current `package.json`
 * @param pm - Package manager that prefixes scripts
 * @param driver - Driver to add when it has a package and is missing
 * @param versions - Versions to write
 * @returns The file text and the edits
 */
export function patchPackageJson(
  text: string,
  pm: InitPackageManager,
  driver: InitDriver,
  versions: PackageVersions,
): { readonly text: string; readonly edits: readonly PackageEdit[] } {
  const parsed = parsePackage(text);
  const deps = record(parsed.dependencies);
  const scripts = record(parsed.scripts);
  const caret = usesCaret(parsed);
  const edits: PackageEdit[] = [];
  let depsChanged = false;
  let scriptsChanged = false;

  depsChanged =
    addDep(parsed, deps, edits, "okmodel", range(versions.okmodel, caret)) || depsChanged;
  const driverPackage = DRIVER_PACKAGES[driver];
  if (driverPackage !== undefined) {
    const peer = versions.peers[driverPackage] ?? "";
    if (peer.length > 0) {
      const spec = range(peer.replace(/^[\^~]/, ""), caret);
      depsChanged = addDep(parsed, deps, edits, driverPackage, spec) || depsChanged;
    }
  }
  for (const name of INIT_SCRIPTS) {
    scriptsChanged = addScript(scripts, edits, name, scriptCommand(pm, name)) || scriptsChanged;
  }

  if (!depsChanged && !scriptsChanged) return { text, edits };
  if (depsChanged) parsed.dependencies = deps;
  if (scriptsChanged) parsed.scripts = scripts;
  const newline = text.endsWith("\n") || text.endsWith("\r\n") || !text.includes("\n");
  const body = `${JSON.stringify(parsed, null, indentOf(text))}${newline ? "\n" : ""}`;
  return { text: body, edits };
}

function addDep(
  parsed: Record<string, unknown>,
  deps: Record<string, unknown>,
  edits: PackageEdit[],
  name: string,
  spec: string,
): boolean {
  const key = `dependencies.${name}`;
  if (hasDeclaration(parsed, name)) {
    edits.push({ key, action: "skip" });
    return false;
  }
  deps[name] = spec;
  edits.push({ key, action: "add", value: spec });
  return true;
}

function addScript(
  scripts: Record<string, unknown>,
  edits: PackageEdit[],
  name: string,
  command: string,
): boolean {
  const key = `scripts.${name}`;
  if (typeof scripts[name] === "string") {
    edits.push({ key, action: "skip" });
    return false;
  }
  scripts[name] = command;
  edits.push({ key, action: "add", value: command });
  return true;
}

function parsePackage(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    initError(
      "invalid",
      "package.json is not JSON.",
      "Fix package.json so okm init can edit dependencies and scripts.",
      "failed",
    );
  }
  if (!isPackageRecord(parsed)) {
    return initError(
      "invalid",
      "package.json must be an object.",
      "Fix package.json so okm init can edit dependencies and scripts.",
      "failed",
    );
  }
  return parsed;
}

function isPackageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { ...value };
}

function hasDeclaration(parsed: Record<string, unknown>, name: string): boolean {
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const bag = parsed[key];
    if (typeof bag !== "object" || bag === null || Array.isArray(bag)) continue;
    if (typeof (bag as Record<string, unknown>)[name] === "string") return true;
  }
  return false;
}

function usesCaret(parsed: Readonly<Record<string, unknown>>): boolean {
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const bag = parsed[key];
    if (typeof bag !== "object" || bag === null || Array.isArray(bag)) continue;
    if (Object.values(bag).some((value) => typeof value === "string" && value.startsWith("^"))) {
      return true;
    }
  }
  return false;
}

function range(bare: string, caret: boolean): string {
  const version = bare.replace(/^[\^~]/, "");
  return caret ? `^${version}` : version;
}

function indentOf(text: string): string | number {
  const match = /\n([ \t]+)"/.exec(text.replaceAll("\r\n", "\n"));
  const indent = match?.[1];
  if (indent === undefined) return 2;
  if (indent.includes("\t")) return "\t";
  return indent.length > 0 ? indent.length : 2;
}
