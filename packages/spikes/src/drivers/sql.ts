/**
 * Quoting and wire codecs for the spike.
 *
 * Adapters return Postgres text. Decoding lives here, on the dialect side of
 * the boundary the spec describes.
 */

import { DriverError } from "./errors.js";
import type { ExecuteOptions, PreparedMode } from "./types.js";

/**
 * Quotes an identifier.
 *
 * @param name - Raw identifier
 * @returns A double-quoted identifier
 */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Quotes a SQL string literal.
 *
 * @param value - Raw text
 * @returns A single-quoted literal
 */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Inlines wire parameters for the simple query protocol.
 *
 * `$1` is `params[0]`. Null becomes `NULL`. This is the `prepared: "none"` path.
 *
 * @param text - SQL with placeholders
 * @param params - Wire parameters
 * @returns SQL with literals in place of placeholders
 */
export function inlineParams(text: string, params: readonly (string | null)[] | undefined): string {
  if (params === undefined || params.length === 0) return text;
  return text.replaceAll(/\$(\d+)\b/g, (match, index: string) => {
    const value = params[Number(index) - 1];
    if (value === undefined) return match;
    if (value === null) return "NULL";
    return quoteLiteral(value);
  });
}

/**
 * Schema-qualified name.
 *
 * @param schema - Schema identifier
 * @param table - Table identifier
 * @returns Quoted `schema.table`
 */
export function qualify(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** A deadline shared by every statement of one call. */
export type CallWatch = {
  /** Aborts when the caller aborts or the timeout fires. */
  readonly signal: AbortSignal;
  /** Clears the timer and the parent listener. */
  finish(): void;
  /** Which side aborted, once `signal` has aborted. */
  cause(): "signal" | "timeout" | undefined;
};

/**
 * Builds the abort signal for one call.
 *
 * @param options - Caller signal and timeout
 * @returns A watch, or undefined when the call has neither
 */
export function watchCall(options: ExecuteOptions | undefined): CallWatch | undefined {
  const parent = options?.signal;
  const timeout = options?.timeout;
  if (parent === undefined && timeout === undefined) return undefined;
  const controller = new AbortController();
  let why: "signal" | "timeout" | undefined;
  const abort = (cause: "signal" | "timeout"): void => {
    why = why ?? cause;
    if (!controller.signal.aborted) controller.abort();
  };
  const onParent = (): void => abort("signal");
  if (parent?.aborted === true) abort("signal");
  else parent?.addEventListener("abort", onParent, { once: true });
  const timer =
    timeout === undefined ? undefined : setTimeout(() => abort("timeout"), Math.max(0, timeout));
  return {
    signal: controller.signal,
    finish() {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
    cause() {
      return why;
    },
  };
}

/**
 * Resolves the prepared mode for one call.
 *
 * @param fallback - Pool default
 * @param options - Per-call override
 * @returns The mode to use
 */
export function preparedMode(
  fallback: PreparedMode,
  options: ExecuteOptions | undefined,
): PreparedMode {
  return options?.prepared ?? fallback;
}

/**
 * Decodes a Postgres boolean wire value.
 *
 * @param wire - `t` or `f`
 * @returns The boolean
 */
export function decodeBoolean(wire: string): boolean {
  if (wire === "t") return true;
  if (wire === "f") return false;
  throw new Error(`bad boolean wire ${wire}`);
}

/**
 * Decodes a one-dimensional Postgres array of text.
 *
 * Quoted elements and `NULL` are accepted. Nested arrays are not.
 *
 * @param wire - Array literal, such as `{a,b}` or `{NULL}`
 * @returns The elements
 */
export function decodeTextArray(wire: string): readonly (string | null)[] {
  if (wire.length < 2 || !wire.startsWith("{") || !wire.endsWith("}")) {
    throw new Error(`bad array wire ${wire}`);
  }
  const body = wire.slice(1, -1);
  if (body.length === 0) return [];
  const values: (string | null)[] = [];
  let index = 0;
  while (index < body.length) {
    if (body[index] === '"') {
      let text = "";
      index += 1;
      while (index < body.length) {
        const char = body[index];
        if (char === "\\") {
          text += body[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (char === '"') {
          index += 1;
          break;
        }
        text += char;
        index += 1;
      }
      values.push(text);
    } else {
      const end = body.indexOf(",", index);
      const slice = body.slice(index, end === -1 ? body.length : end);
      values.push(slice === "NULL" ? null : slice);
      index += slice.length;
    }
    if (body[index] === ",") index += 1;
  }
  return values;
}

/**
 * Reads one cell as Postgres wire text.
 *
 * A decoded JavaScript number or Date is a leak across the codec boundary.
 *
 * @param cell - Value from the driver
 * @returns Wire text, or null
 */
export function wireCell(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "string") return cell;
  if (cell instanceof Uint8Array) return Buffer.from(cell).toString("utf8");
  const kind = cell instanceof Date ? "date" : typeof cell;
  throw new DriverError(`value crossed the driver boundary as ${kind}, not wire text`, {
    cause: cell,
  });
}

/**
 * Parses a timestamptz wire value to epoch milliseconds.
 *
 * @param wire - Postgres timestamp text
 * @returns Epoch milliseconds
 */
export function decodeTimestamp(wire: string): number {
  const parsed = Date.parse(wire.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  if (Number.isNaN(parsed)) throw new Error(`bad timestamp wire ${wire}`);
  return parsed;
}
