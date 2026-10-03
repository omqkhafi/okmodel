/**
 * UUID keys.
 */

import {
  type ColumnBuilder,
  type IdFlags,
  type IdSuppliedFlags,
  type PlainFlags,
  openColumn,
  required,
} from "./column.js";
import { definition, rejected } from "./misuse.js";

/** How {@link id} fills the primary key. */
export type IdDefault = "uuidv7" | "random" | "none";

/**
 * UUID primary key.
 *
 * The default is `uuidv7()` (Postgres 18). `random` is `gen_random_uuid()`
 * (built in from Postgres 13). `none` takes the id on insert. A database
 * default is omitted from insert and update. `none` is required on insert
 * and omitted from update.
 *
 * @param options - Which default to store. Omitted means `uuidv7`
 * @returns An id column
 */
export function id(): ColumnBuilder<string, IdFlags>;
export function id(options: { readonly default: "none" }): ColumnBuilder<string, IdSuppliedFlags>;
export function id(options: {
  readonly default: "uuidv7" | "random";
}): ColumnBuilder<string, IdFlags>;
export function id(options?: {
  readonly default?: IdDefault;
}): ColumnBuilder<string, IdFlags | IdSuppliedFlags> {
  const mode = options?.default ?? "uuidv7";
  const supplied = mode === "none";
  if (!supplied && mode !== "uuidv7" && mode !== "random") {
    definition(`id() default ${String(mode)} must be uuidv7, random, or none.`);
  }
  return openColumn<string, IdFlags | IdSuppliedFlags>({
    baseType: "uuid",
    nullable: false,
    hasDefault: !supplied,
    generated: false,
    guarded: !supplied,
    hidden: false,
    omitWrite: !supplied,
    omitUpdate: true,
    ...(supplied ? {} : { defaultSql: mode === "random" ? "gen_random_uuid()" : "uuidv7()" }),
    primaryKey: true,
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
