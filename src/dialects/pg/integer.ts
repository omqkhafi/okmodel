/**
 * smallint, integer, and bigint.
 *
 * Bigint defaults to a decimal string. `as` selects number or bigint.
 */

import {
  type ColumnBuilder,
  type IdentityFlags,
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
    }) as unknown as ColumnBuilder<BigintValue<TAs>, PlainFlags>;
  }
  if (mode === "bigint") {
    return required({
      baseType: "bigint",
      encode: encodeBigintValue,
      decode: decodeBigintValue,
      sqlForm: "raw",
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

/**
 * `bigint` identity column, `GENERATED ALWAYS AS IDENTITY`.
 *
 * Insert and update omit it. The codec follows the same `as` modes as {@link bigint}.
 *
 * @typeParam TAs - `string`, `number`, or `bigint`
 * @param options - Codec selection
 * @returns An identity column
 */
export function identity<const TAs extends BigintAs = "string">(options?: {
  readonly as?: TAs;
}): ColumnBuilder<BigintValue<TAs>, IdentityFlags> {
  const mode = options?.as ?? "string";
  if (mode === "number") {
    return openColumn({
      ...identityFlags(),
      encode: encodeBigintNumber,
      decode: decodeBigintNumber,
    }) as unknown as ColumnBuilder<BigintValue<TAs>, IdentityFlags>;
  }
  if (mode === "bigint") {
    return openColumn({
      ...identityFlags(),
      encode: encodeBigintValue,
      decode: decodeBigintValue,
    }) as unknown as ColumnBuilder<BigintValue<TAs>, IdentityFlags>;
  }
  if (mode !== "string") {
    definition(`identity as ${String(mode)} must be string, number, or bigint.`);
  }
  return openColumn({
    ...identityFlags(),
    encode: encodeBigintString,
    decode: decodeBigintString,
  }) as unknown as ColumnBuilder<BigintValue<TAs>, IdentityFlags>;
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

function decodeBounded(wire: string, min: number, max: number, role: string): number {
  if (!integerText().test(wire)) {
    rejected(`${role} ${wire} must be an integer, for example 0 or -12.`);
  }
  const value = Number(wire);
  integerToken(value, min, max, role);
  return value;
}

function identityFlags(): {
  readonly baseType: "bigint";
  readonly nullable: false;
  readonly hasDefault: true;
  readonly generated: false;
  readonly guarded: false;
  readonly hidden: false;
  readonly omitWrite: true;
  readonly sqlForm: "raw";
  readonly identity: { readonly always: true };
} {
  return {
    baseType: "bigint",
    nullable: false,
    hasDefault: true,
    generated: false,
    guarded: false,
    hidden: false,
    omitWrite: true,
    sqlForm: "raw",
    identity: { always: true },
  };
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
