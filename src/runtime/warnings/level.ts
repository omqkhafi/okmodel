/**
 * Resolves a warning level from severity, environment, and an override.
 *
 * The code number is not a level. Development maps low to hint and medium or
 * high to warn. Production maps every rule to off until a level is set.
 */

import type { WarningLevel, WarningRule, WarningSeverity } from "./catalog.js";

/**
 * Default level for a severity in development.
 *
 * @param severity - Rule severity
 * @returns The development level
 */
export function developmentLevel(severity: WarningSeverity): WarningLevel {
  return severity === "low" ? "hint" : "warn";
}

/**
 * Environment for one evaluation.
 *
 * An explicit `env` wins. Otherwise `NODE_ENV=production` is production and
 * every other value, including an unset one, is development.
 *
 * @param env - Override from `warnings({ env })`
 * @returns The environment used for defaults
 */
export function warningEnvironment(
  env: "development" | "production" | undefined,
): "development" | "production" {
  if (env !== undefined) return env;
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

/**
 * Level for one rule on one evaluation.
 *
 * A configured level wins in both environments, including `error` and `off`.
 *
 * @param rule - Registered rule
 * @param levels - Per-rule overrides
 * @param env - Resolved environment
 * @returns The level to apply
 */
export function resolvedLevel(
  rule: WarningRule,
  levels: Readonly<Record<string, WarningLevel>> | undefined,
  env: "development" | "production",
): WarningLevel {
  const chosen = levels?.[rule.rule];
  if (chosen !== undefined) return chosen;
  return env === "production" ? "off" : rule.defaultLevel;
}
