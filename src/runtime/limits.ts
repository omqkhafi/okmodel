/**
 * `connect({ limits })` (M-7): the check at connect, the default and the
 * ceiling on a read, and the OKM2011 hook. Loaded by a client that sets
 * `limits`, never by one that does not.
 */

import { OkmError } from "../contracts/error.js";
import { attachHttp, type Session } from "./client.js";
import { fail, type Plan, type ReadCall } from "./plan.js";
import type { Limits } from "./plan.js";

const KEYS = ["find", "include", "page", "groupBy", "max"];

/**
 * Throws OKM1120 unless `value` is an object of known keys whose values are
 * positive integers, and no key is above `max`.
 *
 * @param value - The `limits` option
 */
export function assertLimits(value: unknown): void {
  const record = value as Record<string, unknown>;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    bad("limits is an object.");
  }
  const max = record.max;
  for (const key of Object.keys(record)) {
    const limit = record[key];
    if (!KEYS.includes(key)) bad(`limits.${key} is unknown. Use ${KEYS.join(", ")}.`);
    if (limit === undefined) continue;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
      bad(`limits.${key} is a positive integer.`);
    }
    if (typeof max === "number" && limit > max) bad(`limits.${key} is above limits.max.`);
  }
}

function bad(message: string): never {
  throw new OkmError("OKM1120", message, {
    fix: { summary: "Pass limits as { find, include, page, groupBy, max } of positive integers." },
  });
}

/**
 * Refuses a written limit above `limits.max`. `.all(reason)` is the way past it.
 *
 * @param value - The limit the caller wrote
 * @param max - `limits.max`, when set
 */
export function capLimit(value: number, max: number | undefined): void {
  if (max !== undefined && value > max) {
    fail(
      "OKM1101",
      `limit ${String(value)} is above limits.max (${String(max)}).`,
      "Lower the limit, or call .all(reason) to read past limits.max.",
    );
  }
}

/**
 * Applies `limits.find` and `limits.max` to `find`, `descendants`, and `ancestors`.
 *
 * A call with neither `limit` nor `.all(reason)` takes `limits.find`. A
 * written limit is checked against `limits.max`. `.all(reason)` reads past
 * the ceiling. A `page()`, an `aggregate`, and every other read keep the
 * limit they planned.
 *
 * @param session - Client session
 * @param call - The read, with `limits` set
 * @returns The same call, or a copy with the default as `limit`
 */
export function limit(session: Session, call: ReadCall): ReadCall {
  const limits = call.limits as Limits;
  if (
    (call.op !== "find" && call.op !== "descendants" && call.op !== "ancestors") ||
    call.all !== undefined ||
    call.size !== undefined
  ) {
    return call;
  }
  if (call.limit !== undefined) {
    try {
      capLimit(call.limit as number, limits.max);
    } catch (error) {
      throw error instanceof OkmError ? attachHttp(session.http, error) : error;
    }
    return call;
  }
  const value = limits.find;
  return value === undefined ? call : { ...call, limit: value, dl: ["find", value] };
}

/**
 * Wraps `decode` so the warning slot sees the rows of a read that took a default.
 *
 * @param session - Client session, whose `w` is set
 * @param call - The read as planned
 * @param stack - The stack of the call site
 * @param decode - Turns the wire rows into the result
 * @returns A decode that reports the result to OKM2011
 */
export function watch(
  session: Session,
  call: ReadCall,
  stack: string | undefined,
  decode: (plan: Plan, rows: readonly (readonly (string | null)[])[]) => unknown,
): typeof decode {
  return async (plan, rows) => {
    const value = await decode(plan, rows);
    session.w?.(session.schema, call, stack, { plan, value });
    return value;
  };
}
