/**
 * UUID keys.
 */

import { readClientGenerator, type ClientGenerator } from "../../contracts/generator.js";
import {
  type ColumnBuilder,
  type IdFlags,
  type IdSuppliedFlags,
  type PlainFlags,
  openColumn,
  required,
} from "./column.js";
import { definition, rejected } from "./misuse.js";
import { decodeText, encodeText } from "./text.js";

/** How {@link id} fills the primary key. */
export type IdDefault = "uuidv7" | "uuidv4" | "none";

/**
 * Primary key.
 *
 * With no options, the database default is `uuidv7()` unless
 * `schema({ defaults: { id } })` says otherwise. `uuidv4` stores
 * `gen_random_uuid()` (built in from Postgres 13). `none` takes the id on
 * insert. A client generator (`uuidv4`, `uuidv7`, or `okid(...)` from
 * `okmodel/ids`) is filled on insert and stored with no database default.
 * OKID is `text` with collation `C`. A database default is omitted from
 * insert and update. `none` is required on insert and omitted from update.
 *
 * @param options - Which default to store. Omitted means the schema default, or `uuidv7()`
 * @returns An id column
 */
export function id(): ColumnBuilder<string, IdFlags>;
export function id(options: { readonly default: "none" }): ColumnBuilder<string, IdSuppliedFlags>;
export function id(options: {
  readonly default: "uuidv7" | "uuidv4" | ClientGenerator<string>;
}): ColumnBuilder<string, IdFlags>;
export function id(options?: {
  readonly default?: IdDefault | ClientGenerator<string>;
}): ColumnBuilder<string, IdFlags | IdSuppliedFlags> {
  const chosen = options?.default;
  const client = typeof chosen === "function" ? readClientGenerator(chosen) : undefined;
  const okid = client?.name === "okid";
  const supplied = chosen === "none";
  if (
    client === undefined &&
    chosen !== undefined &&
    chosen !== "uuidv7" &&
    chosen !== "uuidv4" &&
    chosen !== "none"
  ) {
    definition(
      `id() default ${String(chosen)} must be uuidv7, uuidv4, none, or a client generator.`,
    );
  }
  return openColumn<string, IdFlags | IdSuppliedFlags>({
    baseType: okid ? "text" : "uuid",
    nullable: false,
    hasDefault: client !== undefined || !supplied,
    generated: false,
    guarded: client !== undefined || !supplied,
    hidden: false,
    omitWrite: client !== undefined || !supplied,
    omitUpdate: true,
    ...(client !== undefined ? { clientDefault: client } : {}),
    ...(okid ? { collation: "C" } : {}),
    idSource: chosen === undefined ? "implicit" : "column",
    ...(client === undefined && !supplied
      ? { defaultSql: chosen === "uuidv4" ? "gen_random_uuid()" : "uuidv7()" }
      : {}),
    primaryKey: true,
    encode: okid ? encodeText : encodeUuid,
    decode: okid ? decodeText : decodeUuid,
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
