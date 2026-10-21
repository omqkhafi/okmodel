/**
 * Validates warning configuration.
 *
 * Project config accepts `levels` and `ignore`. The slot also accepts
 * `onWarning` and `env`. An ignore without a reason is refused.
 */

import { OkmError } from "../../contracts/error.js";
import { isWarningRecord, type WarningIgnore, type WarningLevel } from "./catalog.js";
import type { WarningNotice } from "./report.js";

const LEVELS: readonly WarningLevel[] = ["off", "hint", "warn", "error"];
const RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Options for {@link warnings}. */
export type WarningOptions = {
  /** Per-rule level. The key is the rule id, not the code. */
  readonly levels?: Readonly<Record<string, WarningLevel>>;
  /** Rules to skip. Each entry needs a reason. */
  readonly ignore?: readonly WarningIgnore[];
  /** Replaces the console. One notice per rule and call site. */
  readonly onWarning?: (notice: WarningNotice) => void;
  /** Overrides `NODE_ENV` for the development and production defaults. */
  readonly env?: "development" | "production";
};

/** Parsed slot options. */
export type ParsedWarnings = {
  readonly levels: Readonly<Record<string, WarningLevel>> | undefined;
  readonly ignore: readonly WarningIgnore[];
  readonly onWarning: ((notice: WarningNotice) => void) | undefined;
  readonly env: "development" | "production" | undefined;
};

/**
 * Validates `defineConfig({ warnings })`.
 *
 * @param value - The `warnings` field, or `undefined`
 */
export function assertProjectWarnings(value: unknown): void {
  if (value === undefined) return;
  if (!isWarningRecord(value)) fail("warnings must be an object.");
  for (const key of Object.keys(value)) {
    if (key !== "levels" && key !== "ignore") fail("warnings only accepts levels and ignore.");
  }
  readLevels(value.levels);
  readIgnoreList(value.ignore);
}

/**
 * Validates and copies `warnings()` options.
 *
 * @param value - Caller options
 * @returns The parsed options
 */
export function parseWarningOptions(value: WarningOptions | undefined): ParsedWarnings {
  if (value === undefined)
    return { levels: undefined, ignore: [], onWarning: undefined, env: undefined };
  if (!isWarningRecord(value)) fail("warnings must be an object.");
  for (const key of Object.keys(value)) {
    if (key !== "levels" && key !== "ignore" && key !== "onWarning" && key !== "env") {
      fail("warnings only accepts levels, ignore, onWarning, and env.");
    }
  }
  return {
    levels: readLevels(value.levels),
    ignore: readIgnoreList(value.ignore),
    onWarning: readHandler(value.onWarning),
    env: readEnv(value.env),
  };
}

/**
 * Reads a call-site ignore. One object or a list. A missing reason throws.
 *
 * @param value - The `ignore` option
 * @returns The ignores. Empty when the option is absent
 */
export function readCallIgnore(value: unknown): readonly WarningIgnore[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(readIgnore);
}

function readIgnoreList(value: unknown): readonly WarningIgnore[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("warnings.ignore must be a list.");
  return value.map(readIgnore);
}

function readIgnore(value: unknown): WarningIgnore {
  if (!isWarningRecord(value)) fail("An ignore is { rule, reason }.");
  for (const key of Object.keys(value)) {
    if (key !== "rule" && key !== "reason") fail("An ignore only has rule and reason.");
  }
  if (typeof value.rule !== "string" || !RULE_ID.test(value.rule)) {
    fail("An ignore rule is a kebab-case id.");
  }
  if (typeof value.reason !== "string" || value.reason.trim() === "") {
    fail("An ignore needs a reason.");
  }
  return { rule: value.rule, reason: value.reason.trim() };
}

function readLevels(value: unknown): Readonly<Record<string, WarningLevel>> | undefined {
  if (value === undefined) return undefined;
  if (!isWarningRecord(value)) fail("warnings.levels must be an object.");
  const levels: Record<string, WarningLevel> = {};
  for (const [rule, level] of Object.entries(value)) {
    if (!RULE_ID.test(rule)) fail("A warnings level key is a kebab-case rule id.");
    if (typeof level !== "string" || !isLevel(level)) {
      fail("A warnings level is off, hint, warn, or error.");
    }
    levels[rule] = level;
  }
  return levels;
}

function readHandler(value: unknown): ((notice: WarningNotice) => void) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") fail("warnings.onWarning must be a function.");
  return value as (notice: WarningNotice) => void;
}

function readEnv(value: unknown): "development" | "production" | undefined {
  if (value === undefined) return undefined;
  if (value === "development" || value === "production") return value;
  fail("warnings env is development or production.");
}

function isLevel(value: string): value is WarningLevel {
  return (LEVELS as readonly string[]).includes(value);
}

function fail(summary: string): never {
  throw new OkmError("invalid", summary, { kind: "invalid" });
}
