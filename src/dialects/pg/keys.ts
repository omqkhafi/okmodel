/**
 * UUID keys.
 */

import {
  type ColumnBuilder,
  type IdFlags,
  type PlainFlags,
  openColumn,
  required,
} from "./column.js";
import { rejected } from "./misuse.js";

/**
 * UUID primary key with default `uuidv7()`.
 *
 * Insert and update omit it, and it is guarded.
 *
 * @returns An id column
 */
export function id(): ColumnBuilder<string, IdFlags> {
  return openColumn({
    baseType: "uuid",
    nullable: false,
    hasDefault: true,
    generated: false,
    guarded: true,
    hidden: false,
    omitWrite: true,
    defaultSql: "uuidv7()",
    encode: encodeUuid,
    decode: decodeUuid,
    sqlForm: "quote",
  });
}

/**
 * UUID text, with no default.
 *
 * @returns A uuid column
 */
export function uuid(): ColumnBuilder<string, PlainFlags> {
  return required({
    baseType: "uuid",
    encode: encodeUuid,
    decode: decodeUuid,
    sqlForm: "quote",
  });
}

/**
 * Encodes a UUID as lowercase hex with hyphens.
 *
 * @param value - UUID text
 * @returns Canonical UUID
 */
export function encodeUuid(value: string): string {
  const text = value.toLowerCase();
  if (!uuidText().test(text)) {
    rejected(
      `uuid ${value} must be 8-4-4-4-12 hexadecimal digits, for example 01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d.`,
    );
  }
  return text;
}

/**
 * Decodes UUID text.
 *
 * @param wire - UUID text
 * @returns Canonical UUID
 */
export function decodeUuid(wire: string): string {
  return encodeUuid(wire);
}

function uuidText(): RegExp {
  uuidPattern ??= /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return uuidPattern;
}

let uuidPattern: RegExp | undefined;
