/**
 * Development warnings (`okmodel/warnings`).
 *
 * Import `warnings` and pass it to `connect`. A process that never imports
 * this module does not load the rules. The planner calls the returned
 * function once per read, through one nullable slot.
 */

import type { QuerySchema } from "../../dialects/pg/model.js";
import { WARNING_RULES } from "./catalog.js";
import {
  parseWarningOptions,
  readCallIgnore,
  type ParsedWarnings,
  type WarningOptions,
} from "./config.js";
import { ruleFires, type WarningCall } from "./evaluate.js";
import { resolvedLevel, warningEnvironment } from "./level.js";
import { reportWarning, throwWarning } from "./report.js";

export type { WarningIgnore, WarningLevel, WarningSeverity } from "./catalog.js";
export type { WarningOptions } from "./config.js";
export type { WarningNotice } from "./report.js";

/**
 * Slot `connect({ warnings })` stores.
 *
 * The planner passes the schema and the read after presets, text search, and
 * `page()` have rewritten it.
 */
export type WarningSlot = (schema: QuerySchema, call: WarningCall, stack?: string) => void;

/**
 * Builds the plan-time warning slot.
 *
 * Development uses each rule's default level. Production reports nothing
 * until `levels` sets one. `onWarning` replaces the console. `ignore` needs
 * a reason. `error` throws on every evaluation.
 *
 * @param options - Levels, ignores, the callback, and the environment
 * @returns The slot
 */
export function warnings(options?: WarningOptions): WarningSlot {
  const parsed = parseWarningOptions(options);
  return (schema, call, stack) => {
    advise(schema, call, parsed, stack);
  };
}

function advise(
  schema: QuerySchema,
  call: WarningCall,
  parsed: ParsedWarnings,
  stack: string | undefined,
): void {
  const ignores = [...parsed.ignore, ...readCallIgnore(call.ignore)];
  const env = warningEnvironment(parsed.env);
  for (const rule of WARNING_RULES) {
    if (!ruleFires(rule, schema, call)) continue;
    if (ignores.some((item) => item.rule === rule.rule && item.target === undefined)) continue;
    const level = resolvedLevel(rule, parsed.levels, env);
    if (level === "off") continue;
    if (level === "error") throwWarning(rule);
    reportWarning(rule, level, parsed.onWarning, stack);
  }
}
