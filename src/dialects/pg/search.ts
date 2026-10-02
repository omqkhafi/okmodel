/**
 * Full-text search and ltree.
 */

import { type ColumnBuilder, type PlainFlags, required } from "./column.js";
import { rejected } from "./misuse.js";
import { decodeText, encodeText } from "./text.js";

/**
 * Full-text vector. The value is the vector text.
 *
 * @returns A tsvector column
 */
export function tsvector(): ColumnBuilder<string, PlainFlags> {
  return required({
    baseType: "tsvector",
    encode: encodeText,
    decode: decodeText,
    sqlForm: "quote",
  });
}

/**
 * Label tree. The column depends on the `ltree` extension.
 *
 * @returns An ltree column
 */
export function ltree(): ColumnBuilder<string, PlainFlags> {
  return required({
    baseType: "ltree",
    encode: encodeLtree,
    decode: encodeLtree,
    sqlForm: "quote",
    extension: "ltree",
  });
}

/**
 * Encodes an ltree path.
 *
 * @param value - Labels separated by dots
 * @returns The same path when every label is valid
 */
export function encodeLtree(value: string): string {
  if (!ltreeText().test(value)) {
    rejected(
      `ltree ${value} must be labels of letters, digits, or underscores separated by dots, for example top.science.`,
    );
  }
  return value;
}

function ltreeText(): RegExp {
  ltreePattern ??= /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
  return ltreePattern;
}

let ltreePattern: RegExp | undefined;
