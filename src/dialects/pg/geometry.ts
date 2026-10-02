/**
 * Built-in geometric columns. PostGIS stays in an extension package.
 */

import { type ColumnBuilder, type PlainFlags, required } from "./column.js";
import { decimalText } from "./finite.js";
import { rejected } from "./misuse.js";

/** A point on a plane. */
export type Point = {
  readonly x: number;
  readonly y: number;
};

/** An infinite line `ax + by + c = 0`. */
export type Line = {
  readonly a: number;
  readonly b: number;
  readonly c: number;
};

/**
 * Point. Wire text is `(x,y)`.
 *
 * @returns A point column
 */
export function point(): ColumnBuilder<Point, PlainFlags> {
  return required({
    baseType: "point",
    encode: encodePoint,
    decode: decodePoint,
    sqlForm: "quote",
  });
}

/**
 * Infinite line. Wire text is `{a,b,c}`.
 *
 * @returns A line column
 */
export function line(): ColumnBuilder<Line, PlainFlags> {
  return required({
    baseType: "line",
    encode: encodeLine,
    decode: decodeLine,
    sqlForm: "quote",
  });
}

/**
 * Encodes a point.
 *
 * @param value - Coordinates
 * @returns `(x,y)`
 */
export function encodePoint(value: Point): string {
  return `(${decimalText(value.x, "point")},${decimalText(value.y, "point")})`;
}

/**
 * Decodes `(x,y)`.
 *
 * @param wire - Point text
 * @returns Coordinates
 */
export function decodePoint(wire: string): Point {
  const match = pointText().exec(wire);
  const x = match?.[1];
  const y = match?.[2];
  if (x === undefined || y === undefined) {
    rejected(`point ${wire} must be (x,y), for example (1,2).`);
  }
  return { x: finite(Number(x), "point"), y: finite(Number(y), "point") };
}

/**
 * Encodes a line.
 *
 * @param value - Line coefficients
 * @returns `{a,b,c}`
 */
export function encodeLine(value: Line): string {
  return `{${decimalText(value.a, "line")},${decimalText(value.b, "line")},${decimalText(value.c, "line")}}`;
}

/**
 * Decodes `{a,b,c}`.
 *
 * @param wire - Line text
 * @returns Coefficients
 */
export function decodeLine(wire: string): Line {
  const match = lineText().exec(wire);
  const a = match?.[1];
  const b = match?.[2];
  const c = match?.[3];
  if (a === undefined || b === undefined || c === undefined) {
    rejected(`line ${wire} must be {a,b,c}, for example {1,0,-1}.`);
  }
  return {
    a: finite(Number(a), "line"),
    b: finite(Number(b), "line"),
    c: finite(Number(c), "line"),
  };
}

function finite(value: number, role: string): number {
  if (!Number.isFinite(value)) {
    rejected(
      `${role} ${String(value)} must be a finite number. Infinity and NaN are not accepted.`,
    );
  }
  return Object.is(value, -0) ? 0 : value;
}

function pointText(): RegExp {
  pointPattern ??=
    /^\(([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?),([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\)$/;
  return pointPattern;
}

function lineText(): RegExp {
  linePattern ??=
    /^\{([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?),([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?),([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\}$/;
  return linePattern;
}

let pointPattern: RegExp | undefined;
let linePattern: RegExp | undefined;
