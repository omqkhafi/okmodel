/**
 * Casing for `okm import drizzle`.
 *
 * The order is the `--drizzle-casing` flag, then `snakeCase` / `camelCase`
 * builders read off `getTableConfig` columns, then a scan of the schema and
 * `drizzle.config`, then `none`. An empty SQL name is left empty.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Drizzle's casing names. `none` leaves each stored name as it is. */
export type DrizzleCasing = "snake_case" | "camelCase" | "none";

/** `toSnakeCase` and `toCamelCase` from the project's `drizzle-orm`. */
export type Spellings = {
  readonly snake: (name: string) => string;
  readonly camel: (name: string) => string;
};

/** What a scan of the schema and the Drizzle config found. */
export type CasingScan = {
  readonly casing: DrizzleCasing | undefined;
  /** Two files, or one file, named different casings. */
  readonly conflict: boolean;
};

const CONFIG_NAMES = [
  "drizzle.config.ts",
  "drizzle.config.js",
  "drizzle.config.mjs",
  "drizzle.config.cjs",
  "drizzle.config.json",
] as const;

const CASING_VALUE = /casing\s*:\s*(["'])(snake_case|camelCase|none)\1/g;
const BUILDER = /\b(snakeCase|camelCase)\s*\.\s*(?:table|schema|view|materializedView)\b/g;

/**
 * Reads `--drizzle-casing`.
 *
 * @param value - The flag's value
 * @returns The casing, or `undefined` when the value is not one of the three
 */
export function drizzleCasingValue(value: string): DrizzleCasing | undefined {
  if (value === "snake_case" || value === "camelCase" || value === "none") return value;
  return undefined;
}

/**
 * SQL name of one Drizzle column.
 *
 * A `keyAsName` column whose stored name still equals the property is spelled
 * with the detected casing. A name the builder already spelled is kept. An
 * empty result is `undefined`: the property is not substituted.
 *
 * @param name - Column `name` from Drizzle. Empty when unset
 * @param keyAsName - Drizzle set the name from the property
 * @param property - TypeScript key
 * @param casing - Detected casing. `none` and `undefined` do not spell
 * @param spell - The project's spelling functions
 * @returns The SQL name, or `undefined` when it is empty
 */
export function effectiveColumnName(
  name: string,
  keyAsName: boolean,
  property: string,
  casing: DrizzleCasing | undefined,
  spell: Spellings,
): string | undefined {
  if (!keyAsName) return name.length > 0 ? name : undefined;
  if (name.length === 0) return undefined;
  if (casing === undefined || casing === "none" || name !== property) return name;
  const spelled = casing === "snake_case" ? spell.snake(property) : spell.camel(property);
  return spelled.length > 0 ? spelled : undefined;
}

/**
 * Casing a `snakeCase` or `camelCase` builder already wrote into column names.
 *
 * A column votes only when `keyAsName` is set and the stored name differs from
 * the property. Votes that disagree are `mixed`.
 *
 * @param columns - Property, stored name, and `keyAsName`
 * @param spell - The project's spelling functions
 * @returns The builder casing, `mixed`, or `undefined` when nothing voted
 */
export function inferBuilderCasing(
  columns: readonly {
    readonly property: string;
    readonly name: string;
    readonly keyAsName: boolean;
  }[],
  spell: Spellings,
): "snake_case" | "camelCase" | "mixed" | undefined {
  const votes = new Set<"snake_case" | "camelCase">();
  for (const column of columns) {
    if (!column.keyAsName || column.name.length === 0 || column.name === column.property) continue;
    const snake = spell.snake(column.property);
    const camel = spell.camel(column.property);
    if (snake === column.name && camel !== column.name) votes.add("snake_case");
    else if (camel === column.name && snake !== column.name) votes.add("camelCase");
  }
  if (votes.size > 1) return "mixed";
  if (votes.size === 1) return votes.has("snake_case") ? "snake_case" : "camelCase";
  return undefined;
}

/**
 * Picks one casing.
 *
 * The flag wins. Then a single builder vote. Then a scan that agrees with
 * itself. Anything else is `none`, with a finding when a choice was refused.
 *
 * @param input - Flag, builder vote, and scan
 * @returns The casing and a finding when none was chosen over a disagreement
 */
export function chooseDrizzleCasing(input: {
  readonly flag: DrizzleCasing | undefined;
  readonly inferred: "snake_case" | "camelCase" | "mixed" | undefined;
  readonly scan: CasingScan;
}): { readonly casing: DrizzleCasing; readonly finding: string | undefined } {
  if (input.flag !== undefined) return { casing: input.flag, finding: undefined };
  if (input.inferred === "mixed") {
    return {
      casing: "none",
      finding: "tables use more than one casing, so none was chosen",
    };
  }
  if (input.inferred === "snake_case" || input.inferred === "camelCase") {
    return { casing: input.inferred, finding: undefined };
  }
  if (input.scan.conflict) {
    return {
      casing: "none",
      finding: "the Drizzle config names more than one casing, so none was chosen",
    };
  }
  if (input.scan.casing !== undefined) return { casing: input.scan.casing, finding: undefined };
  return { casing: "none", finding: undefined };
}

/**
 * Casings named in one source file.
 *
 * Comments are skipped. `casing: "snake_case"` and `snakeCase.table` both count.
 *
 * @param source - File text
 * @returns The casings the text names
 */
export function casingsInSource(source: string): readonly DrizzleCasing[] {
  const text = stripComments(source);
  const found = new Set<DrizzleCasing>();
  for (const match of text.matchAll(CASING_VALUE)) {
    const value = drizzleCasingValue(match[2] ?? "");
    if (value !== undefined) found.add(value);
  }
  for (const match of text.matchAll(BUILDER)) {
    if (match[1] === "snakeCase") found.add("snake_case");
    if (match[1] === "camelCase") found.add("camelCase");
  }
  return [...found];
}

/**
 * Scans the schema file and Drizzle config files under the project.
 *
 * A schema file outside the project is read on its own. Config files are read
 * from the project root and, when the schema lives in the project, from the
 * schema's directory up to that root.
 *
 * @param cwd - Project directory
 * @param schemaFile - Absolute or project-relative schema path
 * @returns The casing the files agree on, or a conflict
 */
export function scanProjectCasing(cwd: string, schemaFile: string): CasingScan {
  const found = new Set<DrizzleCasing>();
  for (const path of sourcePaths(cwd, schemaFile)) {
    let text: string;
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size > 1_000_000) continue;
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const casing of casingsInSource(text)) found.add(casing);
  }
  if (found.size > 1) return { casing: undefined, conflict: true };
  if (found.size === 1) return { casing: [...found][0], conflict: false };
  return { casing: undefined, conflict: false };
}

/**
 * Spelling functions shipped with drizzle-orm 0.45.
 *
 * Used only when `drizzle-orm/casing` does not export its own.
 *
 * @param input - A TypeScript key
 * @returns The snake_case spelling
 */
export function fallbackSnake(input: string): string {
  const words =
    input.replace(/['\u2019]/g, "").match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? [];
  return words.map((word) => word.toLowerCase()).join("_");
}

/**
 * Camel spelling shipped with drizzle-orm 0.45.
 *
 * @param input - A TypeScript key
 * @returns The camelCase spelling
 */
export function fallbackCamel(input: string): string {
  const words =
    input.replace(/['\u2019]/g, "").match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? [];
  return words.reduce((acc, word, index) => {
    if (index === 0) return acc + word.toLowerCase();
    const head = word[0] ?? "";
    return acc + head.toUpperCase() + word.slice(1);
  }, "");
}

function sourcePaths(cwd: string, schemaFile: string): readonly string[] {
  const root = resolve(cwd);
  const schema = resolve(schemaFile);
  const paths = new Set<string>([schema]);
  const directories = new Set<string>([root]);
  if (schema.startsWith(`${root}/`)) {
    let dir = dirname(schema);
    while (dir.startsWith(root)) {
      directories.add(dir);
      if (dir === root) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const directory of directories) {
    for (const name of CONFIG_NAMES) {
      const path = join(directory, name);
      if (existsSync(path)) paths.add(path);
    }
  }
  if (schema.startsWith(`${root}/`)) collectSiblings(dirname(schema), paths);
  return [...paths];
}

function collectSiblings(directory: string, paths: Set<string>): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(name) || name.endsWith(".d.ts")) continue;
    const path = join(directory, name);
    if (paths.has(path)) continue;
    let text: string;
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size > 1_000_000) continue;
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (
      text.includes("drizzle(") ||
      text.includes("casing") ||
      text.includes("snakeCase") ||
      text.includes("camelCase")
    ) {
      paths.add(path);
    }
  }
}

function stripComments(source: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        index += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        index += 1;
        continue;
      }
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
      out += char;
      continue;
    }
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += char;
      }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
        continue;
      }
      if (char === "\n") out += char;
      continue;
    }
    out += char;
    if (char === "\\") {
      out += next;
      index += 1;
      continue;
    }
    if (state === "single" && char === "'") state = "code";
    else if (state === "double" && char === '"') state = "code";
    else if (state === "template" && char === "`") state = "code";
  }
  return out;
}
