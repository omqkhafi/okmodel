/**
 * Chip rule shared by the generated registry file and the heading chip.
 *
 * The generator writes the values. This module is the type only.
 */

/** How one engine provides a feature. */
export type EngineRuleKind = "min" | "range" | "any" | "bundled" | "none";

/** One major in the version table. */
export type VersionRow = {
  readonly version: number;
  readonly available: boolean;
  readonly tested: boolean;
  readonly note: string;
};

/**
 * The rule a heading chip and its plain-text line share.
 *
 * `docsOnly` is true when the heading names an engine and no registry key.
 */
export type EngineRule = {
  readonly engine: string;
  readonly kind: EngineRuleKind;
  readonly label: string;
  readonly line: string;
  readonly docsOnly: boolean;
  readonly tested: readonly number[];
  readonly versions: readonly VersionRow[];
  readonly min?: number;
  readonly max?: number;
};
