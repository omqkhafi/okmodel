/**
 * smallint, integer, and bigint.
 *
 * Bigint defaults to a decimal string. `as` selects number or bigint.
 */

import {
  type ByDefaultIdentityFlags,
  type ColumnBuilder,
  type IdentityFlags,
  type IdentityMark,
  type PlainFlags,
  openColumn,
  required,
} from "./column.js";
import { definition, rejected } from "./misuse.js";

/** How a bigint value is represented in TypeScript. */
export type BigintAs = "string" | "number" | "bigint";

/**
 * 16-bit integer.
 *
 * @returns A smallint column
 */
export function smallint(): ColumnBuilder<number, PlainFlags> {
  return required({
    baseType: "smallint",
    encode: (value) => integerToken(value, -32_768, 32_767, "smallint"),
    decode: (wire) => decodeBounded(wire, -32_768, 32_767, "smallint"),
    sqlForm: "raw",
  });
}

/**
 * 32-bit integer.
 *
 * @returns An integer column
 */
export function integer(): ColumnBuilder<number, PlainFlags> {
  return required({
    baseType: "integer",
    encode: (value) => integerToken(value, -2_147_483_648, 2_147_483_647, "integer"),
    decode: (wire) => decodeBounded(wire, -2_147_483_648, 2_147_483_647, "integer"),
    sqlForm: "raw",
  });
}

/** TypeScript value for a bigint codec mode. */
export type BigintValue<TAs extends BigintAs> = TAs extends "number"
  ? number
  : TAs extends "bigint"
    ? bigint
    : string;

/**
 * 64-bit integer. The default codec is a decimal string.
 *
 * @typeParam TAs - `string`, `number`, or `bigint`
 * @param options - `as` overrides the TypeScript representation
 * @returns A bigint column
 */
export function bigint<const TAs extends BigintAs = "string">(options?: {
  readonly as?: TAs;
}): ColumnBuilder<BigintValue<TAs>, PlainFlags> {
  const mode = options?.as ?? "string";
  if (mode === "number") {
    return required({
      baseType: "bigint",
      encode: encodeBigintNumber,
      decode: decodeBigintNumber,
      sqlForm: "raw",
      typeLabel: "number",
    }) as unknown as ColumnBuilder<BigintValue<TAs>, PlainFlags>;
  }
  if (mode === "bigint") {
    return required({
      baseType: "bigint",
      encode: encodeBigintValue,
      decode: decodeBigintValue,
      sqlForm: "raw",
      typeLabel: "bigint",
    }) as unknown as ColumnBuilder<BigintValue<TAs>, PlainFlags>;
  }
  if (mode !== "string") {
    definition(`bigint as ${String(mode)} must be string, number, or bigint.`);
  }
  return required({
    baseType: "bigint",
    encode: encodeBigintString,
    decode: decodeBigintString,
    sqlForm: "raw",
  }) as unknown as ColumnBuilder<BigintValue<TAs>, PlainFlags>;
}

/** Options for {@link identity} and {@link integerIdentity}. */
export type IdentityOptions = {
  /** `always` omits the insert value. `byDefault` makes it optional. */
  readonly generated?: "always" | "byDefault";
  readonly start?: number | string;
  readonly increment?: number | string;
  readonly cache?: number | string;
  readonly min?: number | string;
  readonly max?: number | string;
  readonly cycle?: boolean;
  /** Comment on the identity sequence, not the column. */
  readonly comment?: string;
  /** Grants on the identity sequence. `usage`, `select`, and `update`. */
  readonly grants?: unknown;
  /** Not accepted. Use `sequence()` from `okmodel/seq`. */
  readonly scope?: unknown;
  /** Not accepted. Use `sequence()` from `okmodel/seq`. */
  readonly reset?: unknown;
  /** Not accepted. Use `sequence()` from `okmodel/seq`. */
  readonly when?: unknown;
};

/**
 * `bigint` identity column, `GENERATED AS IDENTITY`, and a primary key.
 *
 * The default is `GENERATED ALWAYS`. Insert and update omit it. `byDefault`
 * makes the insert value optional. The codec follows the same `as` modes as {@link bigint}.
 *
 * @typeParam TAs - `string`, `number`, or `bigint`
 * @param options - Codec, generation, and sequence bounds
 * @returns An identity column
 */
export function identity<const TAs extends BigintAs = "string">(
  options: IdentityOptions & { readonly as?: TAs; readonly generated: "byDefault" },
): ColumnBuilder<BigintValue<TAs>, ByDefaultIdentityFlags>;
export function identity<const TAs extends BigintAs = "string">(
  options?: IdentityOptions & { readonly as?: TAs },
): ColumnBuilder<BigintValue<TAs>, IdentityFlags>;
export function identity<const TAs extends BigintAs = "string">(
  options?: IdentityOptions & { readonly as?: TAs },
): ColumnBuilder<BigintValue<TAs>, IdentityFlags | ByDefaultIdentityFlags> {
  const mode = options?.as ?? "string";
  const flags = identityFlags(options);
  if (mode === "number") {
    return openColumn({
      ...flags,
      encode: encodeBigintNumber,
      decode: decodeBigintNumber,
      typeLabel: "number",
    }) as unknown as ColumnBuilder<BigintValue<TAs>, IdentityFlags>;
  }
  if (mode === "bigint") {
    return openColumn({
      ...flags,
      encode: encodeBigintValue,
      decode: decodeBigintValue,
      typeLabel: "bigint",
    }) as unknown as ColumnBuilder<BigintValue<TAs>, IdentityFlags>;
  }
  if (mode !== "string") {
    definition(`identity as ${String(mode)} must be string, number, or bigint.`);
  }
  return openColumn({
    ...flags,
    encode: encodeBigintString,
    decode: decodeBigintString,
  }) as unknown as ColumnBuilder<BigintValue<TAs>, IdentityFlags>;
}

/**
 * `integer` identity column, `GENERATED AS IDENTITY`, and a primary key.
 *
 * The sequence type is `integer`, so an existing `t.identity()` bigint sequence stays a bigint.
 *
 * @param options - Generation and sequence bounds
 * @returns An identity column
 */
export function integerIdentity(
  options: IdentityOptions & { readonly generated: "byDefault" },
): ColumnBuilder<number, ByDefaultIdentityFlags>;
export function integerIdentity(options?: IdentityOptions): ColumnBuilder<number, IdentityFlags>;
export function integerIdentity(
  options?: IdentityOptions,
): ColumnBuilder<number, IdentityFlags | ByDefaultIdentityFlags> {
  return openColumn({
    ...identityFlags(options),
    baseType: "integer",
    encode: (value: number) => integerToken(value, -2_147_483_648, 2_147_483_647, "integer"),
    decode: (wire) => decodeBounded(wire, -2_147_483_648, 2_147_483_647, "integer"),
  }) as unknown as ColumnBuilder<number, IdentityFlags>;
}

/**
 * Encodes a bigint decimal string.
 *
 * @param value - Decimal integer
 * @returns The same spelling when it is a canonical integer
 */
export function encodeBigintString(value: string): string {
  parseBigint(value);
  return value;
}

/**
 * Decodes a bigint decimal string.
 *
 * @param wire - Decimal integer
 * @returns The same spelling
 */
export function decodeBigintString(wire: string): string {
  return encodeBigintString(wire);
}

/**
 * Encodes a safe integer as a bigint literal.
 *
 * @param value - Safe integer
 * @returns Decimal text
 */
export function encodeBigintNumber(value: number): string {
  if (!Number.isSafeInteger(value)) {
    rejected(
      `bigint number ${String(value)} must be an integer from ${String(Number.MIN_SAFE_INTEGER)} to ${String(Number.MAX_SAFE_INTEGER)}.`,
    );
  }
  return String(value);
}

/**
 * Decodes a bigint literal that fits in a safe integer.
 *
 * @param wire - Decimal integer
 * @returns A safe integer
 */
export function decodeBigintNumber(wire: string): number {
  const parsed = parseBigint(wire);
  const value = Number(parsed);
  if (!Number.isSafeInteger(value)) {
    rejected(
      `bigint ${wire} must be an integer from ${String(Number.MIN_SAFE_INTEGER)} to ${String(Number.MAX_SAFE_INTEGER)} when as is number.`,
    );
  }
  return value;
}

/**
 * Encodes a native bigint.
 *
 * @param value - Bigint
 * @returns Decimal text
 */
export function encodeBigintValue(value: bigint): string {
  return value.toString();
}

/**
 * Decodes a bigint literal to a native bigint.
 *
 * @param wire - Decimal integer
 * @returns A bigint
 */
export function decodeBigintValue(wire: string): bigint {
  return parseBigint(wire);
}

/**
 * Encodes an integer that must lie in a closed range.
 *
 * @param value - Integer
 * @param min - Inclusive lower bound
 * @param max - Inclusive upper bound
 * @param role - Type name used in the error
 * @returns Decimal text
 */
export function integerToken(value: number, min: number, max: number, role: string): string {
  if (!Number.isInteger(value) || value < min || value > max) {
    rejected(`${role} ${String(value)} must be an integer from ${String(min)} to ${String(max)}.`);
  }
  return String(value);
}

export function decodeBounded(wire: string, min: number, max: number, role: string): number {
  if (!integerText().test(wire)) {
    rejected(`${role} ${wire} must be an integer, for example 0 or -12.`);
  }
  const value = Number(wire);
  integerToken(value, min, max, role);
  return value;
}

function identityFlags(options?: IdentityOptions): {
  readonly baseType: "bigint";
  readonly nullable: false;
  readonly hasDefault: true;
  readonly generated: false;
  readonly guarded: false;
  readonly hidden: false;
  readonly omitWrite: boolean;
  readonly omitUpdate: true;
  readonly sqlForm: "raw";
  readonly identity: IdentityMark;
  readonly primaryKey: true;
} {
  if (options?.scope !== undefined || options?.reset !== undefined || options?.when !== undefined) {
    definition("identity does not take scope, reset, or when. Use sequence() from okmodel/seq.");
  }
  const generated = options?.generated ?? "always";
  if (generated !== "always" && generated !== "byDefault") {
    definition(`identity generated ${String(generated)} must be always or byDefault.`);
  }
  const start = sequenceDecimal(options?.start, "identity start");
  const increment = sequenceDecimal(options?.increment, "identity increment");
  const min = sequenceDecimal(options?.min, "identity min");
  const max = sequenceDecimal(options?.max, "identity max");
  const cache = sequenceDecimal(options?.cache, "identity cache");
  const identity: IdentityMark = {
    always: generated !== "byDefault",
    ...(start !== undefined ? { start } : {}),
    ...(increment !== undefined ? { increment } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(options?.cycle === true ? { cycle: true } : {}),
    ...(options?.comment !== undefined ? { comment: options.comment } : {}),
    ...(options?.grants !== undefined ? { grants: options.grants } : {}),
  };
  return {
    baseType: "bigint",
    nullable: false,
    hasDefault: true,
    generated: false,
    guarded: false,
    hidden: false,
    omitWrite: generated !== "byDefault",
    omitUpdate: true,
    sqlForm: "raw",
    identity,
    primaryKey: true,
  };
}

function sequenceDecimal(value: number | string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value);
  if (!/^-?(?:0|[1-9]\d*)$/.test(text)) {
    definition(`${label} ${text} must be an integer.`);
  }
  return text;
}

function parseBigint(wire: string): bigint {
  if (!integerText().test(wire)) {
    rejected(`bigint ${wire} must be an integer with no leading zeros, for example 0 or -12.`);
  }
  return BigInt(wire);
}

function integerText(): RegExp {
  integerPattern ??= /^-?(?:0|[1-9]\d*)$/;
  return integerPattern;
}

let integerPattern: RegExp | undefined;
