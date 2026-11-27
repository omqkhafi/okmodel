/**
 * Tenant key types for `columnTenancy`, `compositeTenancy`, and `rlsTenancy`.
 *
 * The wire value is always text for `set_config`. `int` stamps a number.
 * `bigint` stamps a decimal string, which is the default bigint codec.
 */

import { OkmError } from "../../contracts/error.js";
import type { ColumnBuilder, FlagTrue, PlainFlags } from "../../dialects/pg/column.js";
import { bigint, integer } from "../../dialects/pg/integer.js";
import { uuid } from "../../dialects/pg/keys.js";
import { definition } from "../../dialects/pg/misuse.js";
import { text } from "../../dialects/pg/text.js";

/** Key types a tenant column accepts. */
export const TENANT_KEY_TYPES = ["uuid", "text", "int", "bigint"] as const;

/** One tenant key type. */
export type TenantKeyType = (typeof TENANT_KEY_TYPES)[number];

/** A guarded tenant column. `int` is a number. The others are strings. */
export type TenantColumn =
  | ColumnBuilder<string, FlagTrue<PlainFlags, "guarded">>
  | ColumnBuilder<number, FlagTrue<PlainFlags, "guarded">>;

/**
 * Reports whether a value is a tenant key type.
 *
 * @param value - Candidate
 * @returns `true` for uuid, text, int, or bigint
 */
export function isTenantKeyType(value: string): value is TenantKeyType {
  return (TENANT_KEY_TYPES as readonly string[]).includes(value);
}

/**
 * Refuses a type outside the tenant key list.
 *
 * @param type - The value the caller passed
 * @param label - Function name
 */
export function assertTenantKeyType(type: string, label: string): asserts type is TenantKeyType {
  if (!isTenantKeyType(type)) {
    definition(`${label} type ${type} must be uuid, text, int, or bigint.`);
  }
}

/**
 * Builds the guarded column and the wire helpers for one key type.
 *
 * @param type - Tenant key type
 * @returns The column, an encoder from the wire string, and the value `for()` stores
 */
export function tenantKey(type: TenantKeyType): {
  readonly column: TenantColumn;
  readonly encode: (wire: string) => string;
  readonly stamp: (wire: string) => string | number;
} {
  if (type === "int") {
    const column = integer().guarded();
    return {
      column,
      encode: (wire) => column.state.encode(Number(wire)),
      stamp: (wire) => Number(wire),
    };
  }
  if (type === "bigint") {
    const column = bigint().guarded();
    return {
      column,
      encode: (wire) => column.state.encode(wire),
      stamp: (wire) => wire,
    };
  }
  const column = (type === "text" ? text() : uuid()).guarded();
  return {
    column,
    encode: (wire) => column.state.encode(wire),
    stamp: (wire) => wire,
  };
}

/**
 * The wire string `for()` stores for one key.
 *
 * @param type - Tenant key type
 * @param value - The JavaScript value
 * @param message - Refusal text
 * @returns The text `set_config` stores
 */
export function tenantWire(type: TenantKeyType, value: unknown, message: string): string {
  if (type === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new OkmError("OKM1701", message);
    }
    integer().state.encode(value);
    return String(value);
  }
  if (type === "bigint") {
    const wire = typeof value === "bigint" ? value.toString() : value;
    if (typeof wire !== "string" || !/^-?\d+$/.test(wire)) {
      throw new OkmError("OKM1701", message);
    }
    bigint().state.encode(wire);
    return wire;
  }
  if (typeof value !== "string" || (type === "uuid" && value.length === 0)) {
    throw new OkmError("OKM1701", message);
  }
  return value;
}
