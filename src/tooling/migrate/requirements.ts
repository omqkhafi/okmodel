/**
 * Schema requirements `describe()` reports (D300).
 *
 * `minPostgres` is the lowest major that supports every feature the schema
 * uses, at least the project floor. Extensions are the ones the catalog
 * declares or that a column, index, or function depends on, each with the
 * reason it is needed. This module is tooling. It does not enter the runtime
 * entry.
 */

import type { Catalog, CatalogObject } from "../../contracts/catalog/types.js";
import {
  parsePostgresFloor,
  POSTGRES_FLOOR,
  UUIDV7_POSTGRES,
  type PostgresMajor,
} from "../../dialects/pg/floor.js";
import { isUuidV7Default } from "../capabilities/used.js";
import { OPCLASS_EXTENSIONS } from "./opclass-extensions.js";

/**
 * One extension the schema needs.
 *
 * `name` is the extension. `reason` says why, in catalog order.
 */
export type RequiredExtension = {
  readonly name: string;
  readonly reason: string;
};

/**
 * Reads the floor a schema stored, or the project floor when none was stored.
 *
 * @param requires - `schema().requires`, when the caller has the schema result
 * @returns The declared major, or {@link POSTGRES_FLOOR}
 */
export function declaredFloor(requires: { readonly postgres?: string } | undefined): PostgresMajor {
  const parsed = parsePostgresFloor(requires?.postgres);
  if (parsed === 15 || parsed === 16 || parsed === 17 || parsed === 18) return parsed;
  return POSTGRES_FLOOR;
}

/**
 * Lowest major that supports every feature the catalog uses.
 *
 * A `uuidv7()` default raises the floor to 18. A declared floor that is
 * already higher stays. Anything else is the project floor.
 *
 * @param catalog - Catalog `schema()` built
 * @param declared - Floor `schema({ minPostgres })` stored, or the project floor
 * @returns 15, 16, 17, or 18
 */
export function schemaMinPostgres(catalog: Catalog, declared: PostgresMajor): PostgresMajor {
  let floor = declared;
  if (usesUuidV7(catalog) && floor < UUIDV7_POSTGRES) floor = UUIDV7_POSTGRES;
  return floor;
}

/**
 * Extensions the catalog needs, with one reason each.
 *
 * A declaration is `extension(name)`. A column, index, or function that
 * depends on an extension names that object. The same name appears once.
 * The reason joins every use, in catalog order.
 *
 * @param catalog - Catalog `schema()` built
 * @returns Extensions sorted by name
 */
export function requiredExtensions(catalog: Catalog): readonly RequiredExtension[] {
  const reasons = new Map<string, string[]>();
  const opclassOwner = opclassExtensions();
  for (const object of catalog.objects) {
    if (object.kind === "extension") {
      pushReason(reasons, object.identity.name, `extension(${object.identity.name})`);
    }
    for (const edge of object.dependencies) {
      if (edge.target.kind !== "extension") continue;
      pushReason(reasons, edge.target.name, useReason(object));
    }
    if (object.kind === "index" && object.definition.expression !== undefined) {
      for (const opclass of opclassOf(object.definition.expression)) {
        const owner = opclassOwner.get(opclass);
        if (owner === undefined) continue;
        pushReason(
          reasons,
          owner,
          `index ${object.identity.parent.name}.${object.identity.name} uses ${owner}`,
        );
      }
    }
  }
  return [...reasons.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([name, uses]) => ({ name, reason: unique(uses).join("; ") }));
}

function usesUuidV7(catalog: Catalog): boolean {
  for (const object of catalog.objects) {
    if (object.kind === "column" && isUuidV7Default(object.definition.defaultExpression)) {
      return true;
    }
  }
  return false;
}

function useReason(object: CatalogObject): string {
  if (object.kind === "column") {
    return `column ${object.identity.parent.name}.${object.identity.name}`;
  }
  if (object.kind === "index") {
    return `index ${object.identity.parent.name}.${object.identity.name}`;
  }
  if (object.kind === "function") {
    return `function ${object.identity.name}`;
  }
  if ("name" in object.identity && typeof object.identity.name === "string") {
    return `${object.kind} ${object.identity.name}`;
  }
  return object.kind;
}

function opclassExtensions(): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const [method, name, extension] of OPCLASS_EXTENSIONS) {
    owners.set(opclassKey(method, name), extension);
  }
  return owners;
}

function opclassKey(method: string, name: string): string {
  return `${method}\0${name}`;
}

/**
 * Operator classes in index position, keyed by method and name.
 *
 * A `*_ops` word inside a column expression or a string is not a class.
 * `int4_ops` on btree is built in; the same name on gin is `btree_gin`.
 * An unquoted class is folded. The method is the `using` name.
 *
 * @param expression - Catalog index expression
 * @returns `method` + class name, in left-to-right order
 */
function opclassOf(expression: string): readonly string[] {
  const match = /^\s*using\s+([A-Za-z_][\w$]*)\s*\(/i.exec(expression);
  const method = match?.[1]?.toLowerCase();
  if (match === null || method === undefined) return [];
  const open = match[0].length - 1;
  const body = balanced(expression, open);
  if (body === undefined) return [];
  const keys: string[] = [];
  for (const element of splitTop(body, ",")) {
    const name = opclassAt(element);
    if (name !== undefined) keys.push(opclassKey(method, name));
  }
  return keys;
}

/** Operator class after the column or expression, and an optional COLLATE. */
function opclassAt(element: string): string | undefined {
  let index = skipSpace(element, 0);
  index = skipTarget(element, index);
  index = skipSpace(element, index);
  if (wordAt(element, index, "collate")) {
    index = skipSpace(element, index + "collate".length);
    index = skipQualified(element, index);
    index = skipSpace(element, index);
  }
  const read = readClass(element, index);
  return read?.name;
}

function skipTarget(text: string, index: number): number {
  const char = text[index];
  if (char === "(") return skipGroup(text, index) ?? index;
  if (char === '"') return skipQuoted(text, index, '"') ?? index;
  const word = readBare(text, index);
  return word === undefined ? index : index + word.length;
}

function readClass(
  text: string,
  index: number,
): { readonly name: string; readonly end: number } | undefined {
  if (text[index] === '"') {
    const end = skipQuoted(text, index, '"');
    if (end === undefined) return undefined;
    const name = text.slice(index + 1, end - 1).replaceAll('""', '"');
    return name.toLowerCase().endsWith("_ops") ? { name, end } : undefined;
  }
  const first = readBare(text, index);
  if (first === undefined) return undefined;
  let name = first;
  let end = index + first.length;
  if (text[end] === ".") {
    const second = readBare(text, end + 1);
    if (second !== undefined) {
      name = second;
      end += 1 + second.length;
    }
  }
  if (!name.toLowerCase().endsWith("_ops")) return undefined;
  return { name: name.toLowerCase(), end };
}

function skipQualified(text: string, index: number): number {
  if (text[index] === '"') return skipQuoted(text, index, '"') ?? index;
  const first = readBare(text, index);
  if (first === undefined) return index;
  let end = index + first.length;
  if (text[end] === ".") {
    if (text[end + 1] === '"') return skipQuoted(text, end + 1, '"') ?? end;
    const second = readBare(text, end + 1);
    if (second !== undefined) end += 1 + second.length;
  }
  return end;
}

function balanced(text: string, open: number): string | undefined {
  const end = skipGroup(text, open);
  if (end === undefined) return undefined;
  return text.slice(open + 1, end - 1);
}

function splitTop(text: string, separator: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'" || char === '"') {
      const end = skipQuoted(text, index, char);
      if (end === undefined) break;
      index = end;
      continue;
    }
    if (char === "(") {
      const end = skipGroup(text, index);
      if (end === undefined) break;
      index = end;
      continue;
    }
    if (text.startsWith(separator, index)) {
      parts.push(text.slice(start, index));
      index += separator.length;
      start = index;
      continue;
    }
    index += 1;
  }
  parts.push(text.slice(start));
  return parts;
}

function skipGroup(text: string, open: number): number | undefined {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const char = text[index];
    if (char === "'" || char === '"') {
      const end = skipQuoted(text, index, char);
      if (end === undefined) return undefined;
      index = end;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return undefined;
}

function skipQuoted(text: string, open: number, quote: string): number | undefined {
  let index = open + 1;
  while (index < text.length) {
    if (text.startsWith(quote + quote, index)) {
      index += 2;
      continue;
    }
    if (text[index] === quote) return index + 1;
    index += 1;
  }
  return undefined;
}

function readBare(text: string, index: number): string | undefined {
  const match = /^[A-Za-z_][\w$]*/.exec(text.slice(index));
  return match?.[0];
}

function wordAt(text: string, index: number, word: string): boolean {
  const found = readBare(text, index);
  return found !== undefined && found.toLowerCase() === word && found.length === word.length;
}

function skipSpace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function pushReason(reasons: Map<string, string[]>, name: string, reason: string): void {
  const list = reasons.get(name);
  if (list === undefined) reasons.set(name, [reason]);
  else list.push(reason);
}

function unique(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
