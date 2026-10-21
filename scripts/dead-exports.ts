/**
 * Reports exports in `src/` that nothing in `src/`, `tests/`, or `scripts/`
 * imports and that are not on the public API surface.
 *
 * The surface is `tests/fixtures/api-surface.json` reached through
 * `package.json` `exports`. A re-export counts as an import. Type imports
 * count. An import from `packages/` or `site/` is not a use; the report
 * names that file so a later cleanup can see it.
 *
 *   bun ./scripts/dead-exports.ts
 *
 * The script prints the list and exits 0. It does not fail the build.
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSync, type ImportNameKind } from "oxc-parser";

import { posixRelative } from "./posix.js";
import { repoRoot } from "./root.js";

/** Directories whose imports count as a use. */
const INSIDE = ["src", "tests", "scripts"] as const;

/** Directories skipped while walking. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".next", ".okm-docs-pack"]);

/** One export nobody in `src/`, `tests/`, or `scripts/` imports. */
export type DeadExport = {
  /** Forward-slash path relative to the repository root. */
  readonly file: string;
  /** Exported name. `default` is the default export. */
  readonly name: string;
  /** 1-based line of the export. */
  readonly line: number;
  /** True for `export type` and `export { type … }`. */
  readonly isType: boolean;
  /**
   * Importers outside `src/`, `tests/`, and `scripts/`, relative to the root.
   *
   * Empty when nothing in the repository imports the name.
   */
  readonly outside: readonly string[];
};

type DirectExport = {
  readonly name: string;
  readonly line: number;
  readonly isType: boolean;
  readonly reexport?: { readonly spec: string; readonly importName: string };
};

type StarExport = {
  readonly spec: string;
  readonly includeDefault: boolean;
};

type ModuleInfo = {
  readonly file: string;
  readonly exports: ReadonlyMap<string, DirectExport>;
  readonly stars: readonly StarExport[];
  readonly imports: readonly ImportRef[];
};

type ImportRef = {
  readonly spec: string;
  readonly kind: "name" | "default" | "namespace";
  readonly name?: string;
};

type ResolvedExport = {
  readonly name: string;
  readonly line: number;
  readonly isType: boolean;
  readonly reexport?: { readonly file: string; readonly importName: string };
};

type ResolvedModule = {
  readonly file: string;
  readonly exports: ReadonlyMap<string, ResolvedExport>;
  readonly stars: readonly { readonly file: string; readonly includeDefault: boolean }[];
};

/**
 * Dead exports under `src/`.
 *
 * @param root - Repository root. It must contain `package.json`. The API
 *   snapshot is `tests/fixtures/api-surface.json` when that file exists.
 * @returns Exports sorted by file, then name
 */
export function deadExports(root: string): readonly DeadExport[] {
  const files = walkSources(root);
  const packageEntries = readPackageEntries(root);
  const packageName = readPackageName(root);
  const known = new Set(files);
  const parsed = files.map((file) => parseModule(root, file));
  const resolved = new Map<string, ResolvedModule>();
  for (const mod of parsed) {
    resolved.set(mod.file, resolveModule(mod, root, known, packageEntries, packageName));
  }
  const used = new Set<string>();
  const outside = new Map<string, Set<string>>();
  for (const mod of parsed) {
    const inside = isInside(mod.file);
    const target = resolved.get(mod.file);
    if (target === undefined) continue;
    for (const star of target.stars) {
      markAll(
        resolved,
        star.file,
        star.includeDefault,
        inside,
        inside ? undefined : mod.file,
        used,
        outside,
        new Set(),
      );
    }
    for (const ref of mod.imports) {
      const imported = resolveSpecifier(
        root,
        mod.file,
        ref.spec,
        known,
        packageEntries,
        packageName,
      );
      if (imported === undefined) continue;
      if (ref.kind === "namespace") {
        markAll(
          resolved,
          imported,
          true,
          inside,
          inside ? undefined : mod.file,
          used,
          outside,
          new Set(),
        );
      } else if (ref.kind === "default") {
        markUsed(
          resolved,
          imported,
          "default",
          inside,
          inside ? undefined : mod.file,
          used,
          outside,
          new Set(),
        );
      } else if (ref.name !== undefined) {
        markUsed(
          resolved,
          imported,
          ref.name,
          inside,
          inside ? undefined : mod.file,
          used,
          outside,
          new Set(),
        );
      }
    }
  }
  const publicIds = publicSurface(root, packageName, packageEntries, resolved);
  const dead: DeadExport[] = [];
  for (const mod of resolved.values()) {
    if (!mod.file.startsWith("src/")) continue;
    for (const exp of mod.exports.values()) {
      const id = key(mod.file, exp.name);
      if (used.has(id) || publicIds.has(id)) continue;
      dead.push({
        file: mod.file,
        name: exp.name,
        line: exp.line,
        isType: exp.isType,
        outside: [...(outside.get(id) ?? [])].sort(),
      });
    }
  }
  dead.sort((left, right) => {
    if (left.file < right.file) return -1;
    if (left.file > right.file) return 1;
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
  return dead;
}

/**
 * Text report. One export per line.
 *
 * @param found - Dead exports
 * @returns The report, ending in a newline
 */
export function formatDeadExports(found: readonly DeadExport[]): string {
  const lines = [`dead-exports: ${String(found.length)}`];
  for (const exp of found) {
    const kind = exp.isType ? " type" : "";
    const extra = exp.outside.length === 0 ? "" : `  outside ${exp.outside.join(", ")}`;
    lines.push(`${exp.file}:${String(exp.line)} ${exp.name}${kind}${extra}`);
  }
  return `${lines.join("\n")}\n`;
}

function publicSurface(
  root: string,
  packageName: string,
  packageEntries: ReadonlyMap<string, string>,
  modules: ReadonlyMap<string, ResolvedModule>,
): ReadonlySet<string> {
  const surface = readSurface(root);
  const ids = new Set<string>();
  for (const [subpath, file] of packageEntries) {
    const names = surface.get(surfaceKey(packageName, subpath));
    if (names === undefined) continue;
    for (const name of names) {
      markPublic(modules, file, name, ids, new Set());
    }
  }
  return ids;
}

/**
 * API-snapshot key for one `package.json` export subpath.
 *
 * `"."` is the package name. `"./pg"` is `okmodel/pg`.
 *
 * @param packageName - `package.json` name
 * @param subpath - Export key, including the leading dot
 * @returns The key `tests/fixtures/api-surface.json` uses
 */
export function surfaceKey(packageName: string, subpath: string): string {
  if (subpath === ".") return packageName;
  if (subpath.startsWith("./")) return `${packageName}${subpath.slice(1)}`;
  return `${packageName}/${subpath}`;
}

function markPublic(
  modules: ReadonlyMap<string, ResolvedModule>,
  file: string,
  name: string,
  ids: Set<string>,
  stack: Set<string>,
): void {
  const id = key(file, name);
  if (stack.has(id)) return;
  stack.add(id);
  const mod = modules.get(file);
  if (mod === undefined) return;
  const direct = mod.exports.get(name);
  if (direct !== undefined) {
    ids.add(id);
    if (direct.reexport !== undefined) {
      markPublic(modules, direct.reexport.file, direct.reexport.importName, ids, stack);
    }
    return;
  }
  for (const star of mod.stars) {
    if (!star.includeDefault && name === "default") continue;
    markPublic(modules, star.file, name, ids, stack);
  }
}

function markUsed(
  modules: ReadonlyMap<string, ResolvedModule>,
  file: string,
  name: string,
  inside: boolean,
  outsideFile: string | undefined,
  used: Set<string>,
  outside: Map<string, Set<string>>,
  stack: Set<string>,
): void {
  const id = key(file, name);
  if (stack.has(id)) return;
  stack.add(id);
  const mod = modules.get(file);
  if (mod === undefined) return;
  const direct = mod.exports.get(name);
  if (direct !== undefined) {
    if (inside) used.add(id);
    else if (outsideFile !== undefined) addOutside(outside, id, outsideFile);
    if (direct.reexport !== undefined) {
      markUsed(
        modules,
        direct.reexport.file,
        direct.reexport.importName,
        inside,
        outsideFile,
        used,
        outside,
        stack,
      );
    }
    return;
  }
  for (const star of mod.stars) {
    if (!star.includeDefault && name === "default") continue;
    markUsed(modules, star.file, name, inside, outsideFile, used, outside, stack);
  }
}

function markAll(
  modules: ReadonlyMap<string, ResolvedModule>,
  file: string,
  includeDefault: boolean,
  inside: boolean,
  outsideFile: string | undefined,
  used: Set<string>,
  outside: Map<string, Set<string>>,
  stack: Set<string>,
): void {
  const guard = `*${includeDefault ? "1" : "0"}${file}`;
  if (stack.has(guard)) return;
  stack.add(guard);
  const mod = modules.get(file);
  if (mod === undefined) return;
  for (const name of mod.exports.keys()) {
    if (!includeDefault && name === "default") continue;
    markUsed(modules, file, name, inside, outsideFile, used, outside, stack);
  }
  for (const star of mod.stars) {
    markAll(
      modules,
      star.file,
      includeDefault && star.includeDefault,
      inside,
      outsideFile,
      used,
      outside,
      stack,
    );
  }
}

function addOutside(outside: Map<string, Set<string>>, id: string, file: string): void {
  const found = outside.get(id);
  if (found === undefined) outside.set(id, new Set([file]));
  else found.add(file);
}

function resolveModule(
  mod: ModuleInfo,
  root: string,
  known: ReadonlySet<string>,
  packageEntries: ReadonlyMap<string, string>,
  packageName: string,
): ResolvedModule {
  const exports = new Map<string, ResolvedExport>();
  for (const exp of mod.exports.values()) {
    if (exp.reexport === undefined) {
      exports.set(exp.name, { name: exp.name, line: exp.line, isType: exp.isType });
      continue;
    }
    const file = resolveSpecifier(
      root,
      mod.file,
      exp.reexport.spec,
      known,
      packageEntries,
      packageName,
    );
    if (file === undefined) {
      exports.set(exp.name, { name: exp.name, line: exp.line, isType: exp.isType });
      continue;
    }
    exports.set(exp.name, {
      name: exp.name,
      line: exp.line,
      isType: exp.isType,
      reexport: { file, importName: exp.reexport.importName },
    });
  }
  const stars: { file: string; includeDefault: boolean }[] = [];
  for (const star of mod.stars) {
    const file = resolveSpecifier(root, mod.file, star.spec, known, packageEntries, packageName);
    if (file !== undefined) stars.push({ file, includeDefault: star.includeDefault });
  }
  return { file: mod.file, exports, stars };
}

function parseModule(root: string, file: string): ModuleInfo {
  const absolute = join(root, ...file.split("/"));
  const source = stripShebang(readFileSync(absolute, "utf8"));
  const parsed = parseSync(absolute, source, { lang: langOf(file), sourceType: "module" });
  const failure = parsed.errors[0];
  if (failure !== undefined) throw new Error(`${file}: ${failure.message}`);
  const exports = new Map<string, DirectExport>();
  const stars: StarExport[] = [];
  const imports: ImportRef[] = [];
  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      const spec = entry.moduleRequest?.value;
      if (entry.importName.kind === "AllButDefault" && spec !== undefined) {
        stars.push({ spec, includeDefault: false });
        continue;
      }
      if (
        entry.importName.kind === "All" &&
        spec !== undefined &&
        entry.exportName.kind === "Name"
      ) {
        imports.push({ spec, kind: "namespace" });
      } else if (entry.importName.kind === "All" && spec !== undefined) {
        stars.push({ spec, includeDefault: true });
        continue;
      }
      const name = exportName(entry.exportName.kind, entry.exportName.name);
      if (name === undefined) continue;
      const reexport =
        spec !== undefined && entry.importName.kind === "Name" && entry.importName.name !== null
          ? { spec, importName: entry.importName.name }
          : undefined;
      if (exports.has(name)) continue;
      exports.set(name, {
        name,
        line: lineAt(source, entry.start),
        isType: entry.isType,
        ...(reexport === undefined ? {} : { reexport }),
      });
    }
  }
  for (const statement of parsed.module.staticImports) {
    const spec = statement.moduleRequest.value;
    if (statement.entries.length === 0) continue;
    for (const entry of statement.entries) {
      const kind = importKind(entry.importName.kind);
      if (kind === "namespace") imports.push({ spec, kind });
      else if (kind === "default") imports.push({ spec, kind });
      else if (entry.importName.name !== null)
        imports.push({ spec, kind, name: entry.importName.name });
    }
  }
  for (const dynamic of parsed.module.dynamicImports) {
    const spec = quoted(source.slice(dynamic.moduleRequest.start, dynamic.moduleRequest.end));
    if (spec.length > 0) imports.push({ spec, kind: "namespace" });
  }
  return { file, exports, stars, imports };
}

function quoted(raw: string): string {
  const text = raw.trim();
  const first = text.charAt(0);
  const last = text.charAt(text.length - 1);
  if (text.length >= 2 && (first === '"' || first === "'") && last === first) {
    return text.slice(1, -1);
  }
  return "";
}

function exportName(kind: string, name: string | null): string | undefined {
  if (kind === "Default") return "default";
  if (kind === "Name" && name !== null && name.length > 0) return name;
  return undefined;
}

function importKind(kind: ImportNameKind): "name" | "default" | "namespace" {
  if (kind === "NamespaceObject") return "namespace";
  if (kind === "Default") return "default";
  return "name";
}

function walkSources(root: string): readonly string[] {
  const files = new Set<string>();
  walk(root, root, files);
  return [...files].sort();
}

function walk(root: string, dir: string, files: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile() || !isTypeScript(entry.name)) continue;
    const absolute = join(dir, entry.name);
    try {
      const rel = toPosix(root, realpathSync(absolute));
      if (!rel.startsWith("../")) files.add(rel);
    } catch {
      const rel = toPosix(root, absolute);
      if (!rel.startsWith("../")) files.add(rel);
    }
  }
}

function isTypeScript(name: string): boolean {
  if (name.endsWith(".d.ts")) return false;
  return name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".mts");
}

function isInside(file: string): boolean {
  return INSIDE.some((dir) => file === dir || file.startsWith(`${dir}/`));
}

/**
 * Resolves a specifier to a forward-slash path under `root`.
 *
 * Relative specifiers accept the `.js` extension the source uses for `.ts`
 * files. `okmodel` and `okmodel/…` follow `package.json` `exports`.
 *
 * @param root - Repository root
 * @param fromFile - Importer, forward-slash relative to `root`
 * @param spec - Module specifier
 * @param known - TypeScript files that exist, forward-slash relative to `root`
 * @param packageEntries - Export subpath to source file
 * @param packageName - `package.json` name
 * @returns The file, or undefined when the specifier is not a project module
 */
export function resolveSpecifier(
  root: string,
  fromFile: string,
  spec: string,
  known: ReadonlySet<string>,
  packageEntries: ReadonlyMap<string, string>,
  packageName: string,
): string | undefined {
  if (spec.startsWith(".")) {
    const base = resolve(dirname(join(root, ...fromFile.split("/"))), spec);
    return existing(root, base, known);
  }
  if (spec === packageName || spec.startsWith(`${packageName}/`)) {
    const subpath = spec === packageName ? "." : `.${spec.slice(packageName.length)}`;
    return packageEntries.get(subpath);
  }
  return undefined;
}

function existing(root: string, base: string, known: ReadonlySet<string>): string | undefined {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  if (base.endsWith(".js")) {
    const stem = base.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, join(stem, "index.ts"));
  }
  for (const candidate of candidates) {
    let rel: string;
    try {
      rel = toPosix(root, realpathSync(candidate));
    } catch {
      rel = toPosix(root, candidate);
    }
    if (known.has(rel) && !rel.startsWith("../")) return rel;
  }
  return undefined;
}

function readPackageEntries(root: string): Map<string, string> {
  const manifest = readJson(join(root, "package.json"));
  const entries = new Map<string, string>();
  if (!isRecord(manifest)) return entries;
  const exported = manifest.exports;
  if (!isRecord(exported)) return entries;
  for (const [subpath, value] of Object.entries(exported)) {
    const target = exportTarget(value);
    if (target === undefined) continue;
    const source = distToSource(target);
    if (source !== undefined) entries.set(subpath, source);
  }
  return entries;
}

function readPackageName(root: string): string {
  const manifest = readJson(join(root, "package.json"));
  if (isRecord(manifest) && typeof manifest.name === "string") return manifest.name;
  return "";
}

function readSurface(root: string): Map<string, readonly string[]> {
  const path = join(root, "tests", "fixtures", "api-surface.json");
  let parsed: unknown;
  try {
    parsed = readJson(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return new Map();
    throw error;
  }
  const surface = new Map<string, string[]>();
  if (!isRecord(parsed)) return surface;
  for (const [subpath, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    const names: string[] = [];
    for (const entry of value) {
      if (isRecord(entry) && typeof entry.name === "string") names.push(entry.name);
    }
    surface.set(subpath, names);
  }
  return surface;
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.import === "string") return value.import;
  if (typeof value.default === "string") return value.default;
  if (typeof value.types === "string") return value.types;
  return undefined;
}

function distToSource(spec: string): string | undefined {
  if (!spec.startsWith("./dist/")) return undefined;
  let rel = spec.slice("./dist/".length);
  if (rel.endsWith(".d.ts")) rel = `${rel.slice(0, -5)}.ts`;
  else if (rel.endsWith(".js")) rel = `${rel.slice(0, -3)}.ts`;
  else return undefined;
  return `src/${rel}`;
}

function langOf(file: string): "ts" | "tsx" {
  return file.endsWith(".tsx") ? "tsx" : "ts";
}

function stripShebang(source: string): string {
  if (!source.startsWith("#!")) return source;
  const newline = source.indexOf("\n");
  return newline === -1 ? "" : source.slice(newline + 1);
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, source.length);
  for (let index = 0; index < end; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function toPosix(root: string, file: string): string {
  return posixRelative(root, file);
}

function key(file: string, name: string): string {
  return `${file}\0${name}`;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (import.meta.main) {
  process.stdout.write(formatDeadExports(deadExports(repoRoot())));
}
