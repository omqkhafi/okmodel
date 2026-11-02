/**
 * Codec encode that keeps hidden and sensitive values out of OKM1210 messages.
 *
 * Shared by writes and by read/write error scrubbing. Kept out of the featureless
 * startup graph: only the write and exposure chunks import it.
 */

import { OkmError } from "../contracts/error.js";
import type { ColumnModel } from "../dialects/pg/model.js";

/**
 * Encodes a column value. A hidden or sensitive codec rejection whose message
 * names the submitted value becomes `Field <field> was rejected.`
 *
 * @param column - Column being encoded
 * @param value - Caller value
 * @returns Wire text
 */
export function encodeColumn(column: ColumnModel, value: unknown): string {
  if (!column.hidden && !column.sensitive) return column.encode(value);
  try {
    return column.encode(value);
  } catch (error) {
    if (error instanceof OkmError && mentionsValue(error.message, value)) {
      throw rejectedField(error, column.field);
    }
    throw error;
  }
}

/**
 * Rewrites an OKM1210 whose message still names a submitted sensitive value.
 *
 * @param error - Codec or scrubbed failure
 * @param field - Column field name
 * @param value - Submitted value that may appear in the message
 * @returns The same error, or `Field <field> was rejected.`
 */
export function scrubCodecEcho(error: OkmError, field: string, value: unknown): OkmError {
  if (error.code !== "OKM1210" || !mentionsValue(error.message, value)) return error;
  return rejectedField(error, field);
}

export function mentionsValue(message: string, value: unknown): boolean {
  if (typeof value === "string") return value.length > 0 && message.includes(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    const text = String(value);
    return text.length > 0 && message.includes(text);
  }
  return false;
}

function rejectedField(error: OkmError, field: string): OkmError {
  return new OkmError(error.code, `Field ${field} was rejected.`, {
    kind: error.kind,
    fix: error.fix,
  });
}
