/**
 * Refusals for `okm init`.
 *
 * The codes are OKM1862–OKM1867. Retry is false. The messages do not name a
 * global overwrite flag. `okm generate init` is a different command and is
 * not handled here.
 */

import { OkmError } from "../../contracts/error.js";
import { tagOutcome, type CliOutcomeName } from "../cli/outcome.js";

/** Drivers `okm init --driver` accepts. */
export const INIT_DRIVERS = ["postgresjs", "pg", "bun-sql", "pglite", "neon"] as const;

/** One driver name. */
export type InitDriver = (typeof INIT_DRIVERS)[number];

/** Package managers `okm init --pm` accepts. */
export const INIT_PACKAGE_MANAGERS = ["bun", "pnpm", "yarn", "npm"] as const;

/** One package manager. */
export type InitPackageManager = (typeof INIT_PACKAGE_MANAGERS)[number];

/** Tenancy modes the flag accepts. `schema` and `database` are refused. */
export const INIT_TENANCY = ["none", "column", "schema", "database"] as const;

/** One tenancy mode. */
export type InitTenancy = (typeof INIT_TENANCY)[number];

/** Tenancy modes init can write. */
export type InitSupportedTenancy = "none" | "column";

/**
 * Throws an init error with a fixed outcome and `retryable: false`.
 *
 * @param code - OKM1862–OKM1867
 * @param message - What failed
 * @param fix - What to change
 * @param outcome - Exit outcome
 * @returns Never
 */
export function initError(
  code: string,
  message: string,
  fix: string,
  outcome: CliOutcomeName,
): never {
  throw tagOutcome(
    new OkmError(code, message, {
      kind: "invalid",
      retryable: false,
      fix: { summary: fix },
    }),
    outcome,
  );
}

/**
 * Refuses a driver that is not the one already installed.
 *
 * @param installed - Driver package already in the project
 * @param requested - `--driver` value
 */
export function refuseDifferentDriver(installed: string, requested: string): void {
  if (installed === requested) return;
  initError(
    "OKM1862",
    `Driver ${installed} is already installed. okm init will not add ${requested}.`,
    "Drop --driver, or remove the installed driver package before choosing another.",
    "guard",
  );
}

/**
 * Refuses a non-interactive run that still needs a choice.
 *
 * @param flags - Flags the user can pass. Empty means the choice was given
 */
export function refuseMissingDecision(flags: readonly string[]): void {
  if (flags.length === 0) return;
  initError(
    "OKM1863",
    `okm init needs a choice before it can write files. Pass ${flags.join(", ")}.`,
    `Pass ${flags.join(", ")}.`,
    "decision",
  );
}

/**
 * Refuses to replace a file the user changed.
 *
 * @param paths - Project-relative paths. Empty means nothing blocks
 */
export function refuseUserModified(paths: readonly string[]): void {
  if (paths.length === 0) return;
  initError(
    "OKM1864",
    `${paths.join(", ")} was edited after init recorded it.`,
    "Keep the file, or pass the force-file flag with that path to replace it.",
    "guard",
  );
}

/**
 * Refuses a directory init cannot use.
 *
 * @param reason - Why, or `undefined` when the directory is usable
 */
export function refuseUnsupported(reason: string): never;
export function refuseUnsupported(reason: undefined): void;
export function refuseUnsupported(reason: string | undefined): void {
  if (reason === undefined) return;
  initError(
    "OKM1865",
    reason,
    "Use a package directory that can be written, and keep paths inside it.",
    "unreachable",
  );
}

/**
 * Refuses an apply whose plan hash is not the one just computed.
 *
 * @param expected - `--plan-hash`
 * @param actual - Hash of this directory
 */
export function refusePlanHash(expected: string, actual: string): void {
  if (expected === actual) return;
  initError(
    "OKM1866",
    "The plan hash does not match this directory anymore.",
    "Print the plan again and pass the new plan-hash.",
    "guard",
  );
}

/**
 * Refuses a tenancy mode init does not write.
 *
 * @param tenancy - Requested mode
 */
export function refuseTenancy(tenancy: string): void {
  if (tenancy === "none" || tenancy === "column") return;
  initError(
    "OKM1867",
    `Tenancy ${tenancy} is not supported by init yet.`,
    "Pass --tenancy none, or --tenancy column.",
    "decision",
  );
}

/**
 * Refuses a non-interactive init that has several workspace candidates.
 *
 * @param candidates - Package names or paths. Fewer than two is not a refusal
 */
export function refuseWorkspaceChoice(candidates: readonly string[]): void {
  if (candidates.length < 2) return;
  const listed = [...candidates].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  initError(
    "OKM1891",
    `okm init needs a workspace. Candidates: ${listed.join(", ")}.`,
    "Pass --workspace <name>, --all-workspaces, or --shared.",
    "decision",
  );
}

/**
 * Refuses two packages that use one migrations directory.
 *
 * @param packages - Package paths. Fewer than two is not a refusal
 * @param directory - The shared directory
 */
export function refuseSharedMigrations(packages: readonly string[], directory: string): void {
  if (packages.length < 2) return;
  const listed = [...packages].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  initError(
    "OKM1892",
    `${listed.join(", ")} use the same migrations directory ${directory}.`,
    "Give each package its own migrations directory.",
    "guard",
  );
}

/**
 * Usage error for a flag value init does not accept.
 *
 * @param message - What was wrong
 * @param fix - What to pass
 * @returns Never
 */
export function initUsage(message: string, fix: string): never {
  return initError("invalid", message, fix, "usage");
}

/**
 * Whether `value` is a driver name.
 *
 * @param value - Flag text
 * @returns `true` when it is in {@link INIT_DRIVERS}
 */
export function isInitDriver(value: string): value is InitDriver {
  return (INIT_DRIVERS as readonly string[]).includes(value);
}

/**
 * Whether `value` is a package manager name.
 *
 * @param value - Flag text
 * @returns `true` when it is in {@link INIT_PACKAGE_MANAGERS}
 */
export function isInitPackageManager(value: string): value is InitPackageManager {
  return (INIT_PACKAGE_MANAGERS as readonly string[]).includes(value);
}

/**
 * Whether `value` is a tenancy mode the flag accepts.
 *
 * @param value - Flag text
 * @returns `true` when it is in {@link INIT_TENANCY}
 */
export function isInitTenancy(value: string): value is InitTenancy {
  return (INIT_TENANCY as readonly string[]).includes(value);
}
