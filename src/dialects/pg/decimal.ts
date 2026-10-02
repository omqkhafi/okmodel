/**
 * numeric, real, and double precision.
 */

import { type ColumnBuilder, type PlainFlags, required } from "./column.js";
import { decimalText } from "./finite.js";
import { definition, rejected } from "./misuse.js";

/** How a numeric value is represented in TypeScript. */
export type NumericAs = "string" | "number";

/** TypeScript value for a numeric codec mode. */
export type NumericValue<TAs extends NumericAs> = TAs extends "number" ? number : string;

/**
 * Exact numeric. The default codec is a decimal string.
 *
 * @typeParam TAs - `string` or `number`
 * @param precision - Total digits, with `scale`
 * @param scale - Digits after the decimal point
 * @param options - Codec selection
 * @returns A numeric column
 */
export function numeric<const TAs extends NumericAs = "string">(
  precision?: number,
  scale?: number,
  options?: { readonly as?: TAs },
): ColumnBuilder<NumericValue<TAs>, PlainFlags> {
  const baseType = numericType(precision, scale);
  if (options?.as === "number") {
    return required({
      baseType,
      encode: encodeNumericNumber,
      decode: decodeNumericNumber,
      sqlForm: "raw",
      typeLabel: "number",
    }) as unknown as ColumnBuilder<NumericValue<TAs>, PlainFlags>;
  }
  if (options !== undefined && options.as !== undefined && options.as !== "string") {
    definition(`numeric as ${String(options.as)} must be string or number.`);
  }
  return required({
    baseType,
    encode: encodeNumericString,
    decode: decodeNumericString,
    sqlForm: "raw",
  }) as unknown as ColumnBuilder<NumericValue<TAs>, PlainFlags>;
}

/**
 * Single-precision float.
 *
 * @returns A real column
 */
export function real(): ColumnBuilder<number, PlainFlags> {
  return required({
    baseType: "real",
    encode: (value) => decimalText(value, "real"),
    decode: (wire) => decodeFinite(wire, "real"),
    sqlForm: "raw",
  });
}

/**
 * Double-precision float.
 *
 * @returns A double precision column
 */
export function double(): ColumnBuilder<number, PlainFlags> {
  return required({
    baseType: "double precision",
    encode: (value) => decimalText(value, "double"),
    decode: (wire) => decodeFinite(wire, "double"),
    sqlForm: "raw",
  });
}

/**
 * Encodes a canonical numeric literal.
 *
 * @param value - Decimal text
 * @returns The same spelling when it is a numeric literal
 */
export function encodeNumericString(value: string): string {
  if (!numericText().test(value)) {
    rejected(`numeric ${value} must be a decimal literal, for example 1, -2.5, or 1e-3.`);
  }
  return value;
}

/**
 * Decodes a numeric literal to the same string.
 *
 * @param wire - Decimal text
 * @returns The same spelling
 */
export function decodeNumericString(wire: string): string {
  return encodeNumericString(wire);
}

/**
 * Encodes a finite number as a numeric literal.
 *
 * @param value - Finite number
 * @returns Decimal text
 */
export function encodeNumericNumber(value: number): string {
  return decimalText(value, "numeric");
}

/**
 * Decodes a numeric literal to a number.
 *
 * Precision past a JavaScript number is lost. The string codec is the default.
 *
 * @param wire - Decimal text
 * @returns A number
 */
export function decodeNumericNumber(wire: string): number {
  encodeNumericString(wire);
  return Number(wire);
}

function numericType(precision: number | undefined, scale: number | undefined): string {
  if (precision === undefined && scale === undefined) {
    return "numeric";
  }
  if (
    precision === undefined ||
    !Number.isInteger(precision) ||
    precision < 1 ||
    precision > 1000
  ) {
    definition(`numeric precision ${String(precision)} must be an integer from 1 to 1000.`);
  }
  if (scale === undefined) {
    return `numeric(${String(precision)})`;
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > precision) {
    definition(`numeric scale ${String(scale)} must be an integer from 0 to ${String(precision)}.`);
  }
  return `numeric(${String(precision)},${String(scale)})`;
}

function decodeFinite(wire: string, role: string): number {
  const value = Number(wire);
  if (!Number.isFinite(value)) {
    rejected(`${role} ${wire} must be a finite number.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function numericText(): RegExp {
  numericPattern ??= /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  return numericPattern;
}

let numericPattern: RegExp | undefined;
