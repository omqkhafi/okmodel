/**
 * Postgres array literals.
 *
 * Encode and decode run only when a column uses `.array()`. The scanner is
 * created per call.
 */

import { rejected } from "./misuse.js";
import { arrayElement } from "./quote.js";

/** One cell of a parsed array literal. Nested arrays are subarrays. */
type ArrayCell = string | null | readonly ArrayCell[];

/**
 * Writes a nested array as a Postgres array literal.
 *
 * @param value - Nested arrays of scalar values
 * @param dims - Rank, at least 1
 * @param encode - Scalar encoder
 * @param raw - Whether scalar tokens may stay bare
 * @returns A `{...}` literal
 */
export function writeArray(
  value: unknown,
  dims: number,
  encode: (value: unknown) => string,
  raw: boolean,
): string {
  return writeLevel(value, dims, encode, raw);
}

/**
 * Reads a Postgres array literal back into nested scalars.
 *
 * @param wire - Literal produced by {@link writeArray}
 * @param dims - Rank, at least 1
 * @param decode - Scalar decoder
 * @returns Nested arrays
 */
export function readArray(wire: string, dims: number, decode: (wire: string) => unknown): unknown {
  const cursor = { text: wire, index: 0 };
  const parsed = parseValue(cursor);
  skipSpace(cursor);
  if (cursor.index !== cursor.text.length) {
    rejected("Array literal has trailing text.");
  }
  if (!Array.isArray(parsed)) {
    rejected("Array literal must start with `{`.");
  }
  return interpret(parsed, dims, decode);
}

function writeLevel(
  value: unknown,
  dims: number,
  encode: (value: unknown) => string,
  raw: boolean,
): string {
  if (!Array.isArray(value)) {
    rejected("Array column expected an array.");
  }
  const parts: string[] = [];
  if (dims === 1) {
    for (const item of value) {
      if (item === null || item === undefined) {
        rejected("Array elements cannot be null.");
      }
      parts.push(arrayElement(encode(item), raw));
    }
  } else {
    for (const item of value) {
      parts.push(writeLevel(item, dims - 1, encode, raw));
    }
  }
  return `{${parts.join(",")}}`;
}

function interpret(
  nodes: readonly ArrayCell[],
  dims: number,
  decode: (wire: string) => unknown,
): unknown {
  if (dims === 1) {
    return nodes.map((cell) => {
      if (typeof cell !== "string") {
        rejected("Array rank does not match dims.");
      }
      return decode(cell);
    });
  }
  return nodes.map((cell) => {
    if (!Array.isArray(cell)) {
      rejected("Array rank does not match dims.");
    }
    return interpret(cell, dims - 1, decode);
  });
}

type Cursor = { readonly text: string; index: number };

function parseValue(cursor: Cursor): ArrayCell | readonly ArrayCell[] {
  skipSpace(cursor);
  if (peek(cursor) === "{") {
    return parseArray(cursor);
  }
  return parseElement(cursor);
}

function parseArray(cursor: Cursor): ArrayCell[] {
  expectChar(cursor, "{");
  skipSpace(cursor);
  if (peek(cursor) === "}") {
    cursor.index += 1;
    return [];
  }
  const items: ArrayCell[] = [];
  for (;;) {
    items.push(parseValue(cursor));
    skipSpace(cursor);
    if (peek(cursor) === ",") {
      cursor.index += 1;
      skipSpace(cursor);
      continue;
    }
    expectChar(cursor, "}");
    return items;
  }
}

function parseElement(cursor: Cursor): string | null {
  if (peek(cursor) === '"') {
    return parseQuoted(cursor);
  }
  const start = cursor.index;
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index];
    if (char === "," || char === "}" || char === undefined || isSpace(char)) {
      break;
    }
    cursor.index += 1;
  }
  const token = cursor.text.slice(start, cursor.index);
  if (token.length === 0) {
    rejected("Array literal is missing an element.");
  }
  if (token === "NULL") {
    return null;
  }
  return token;
}

function parseQuoted(cursor: Cursor): string {
  expectChar(cursor, '"');
  let out = "";
  for (;;) {
    const char = next(cursor);
    if (char === undefined) {
      rejected("Array literal ended inside a quote.");
    }
    if (char === '"') {
      if (peek(cursor) === '"') {
        cursor.index += 1;
        out += '"';
        continue;
      }
      return out;
    }
    if (char === "\\") {
      const escaped = next(cursor);
      if (escaped === undefined) {
        rejected("Array literal ended inside an escape.");
      }
      out += escaped;
      continue;
    }
    out += char;
  }
}

function expectChar(cursor: Cursor, expected: string): void {
  if (peek(cursor) !== expected) {
    rejected(`Array literal expected ${expected}.`);
  }
  cursor.index += 1;
}

function peek(cursor: Cursor): string | undefined {
  return cursor.text[cursor.index];
}

function next(cursor: Cursor): string | undefined {
  const char = cursor.text[cursor.index];
  if (char !== undefined) {
    cursor.index += 1;
  }
  return char;
}

function skipSpace(cursor: Cursor): void {
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index];
    if (char === undefined || !isSpace(char)) {
      return;
    }
    cursor.index += 1;
  }
}

function isSpace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t";
}
