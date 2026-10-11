/**
 * Migration file text before it is parsed.
 *
 * Line endings and a UTF-8 BOM are normalized here, once, so every reader
 * sees the same plan. UTF-16 is refused. The kind stays `invalid`.
 */

import { OkmError } from "../../contracts/error.js";

/** Why a migration file was refused before it was applied. */
export type MigrationTextReason = "no-steps" | "utf16";

const FIX: Readonly<Record<MigrationTextReason, string>> = {
  "no-steps":
    "Add -- no steps when the migration is intentionally empty. Otherwise the file needs a statement okm can read.",
  utf16: "Save the file as UTF-8. okm does not read UTF-16.",
};

/**
 * A migration file this version will not apply.
 *
 * `reason` is `no-steps` or `utf16`. The kind stays `invalid`.
 */
export class MigrationTextError extends OkmError {
  /** Which check refused the file. */
  readonly reason: MigrationTextReason;

  /**
   * @param reason - Which check failed
   * @param message - What the author should change
   */
  constructor(reason: MigrationTextReason, message: string) {
    super("invalid", message, {
      kind: "invalid",
      fieldReason: reason,
      fix: { summary: FIX[reason] },
    });
    this.name = "OkmError";
    this.reason = reason;
  }
}

/**
 * Strips a UTF-8 BOM and turns `\r\n` and a lone `\r` into `\n`.
 *
 * @param text - File text
 * @param label - File name used when the text is UTF-16
 * @returns Text `parsePlan` can split on `\n`
 */
export function prepareMigrationText(text: string, label = "Migration SQL"): string {
  if (text.includes("\u0000")) {
    throw new MigrationTextError("utf16", `${label} is UTF-16. Save the file as UTF-8.`);
  }
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/**
 * Refuses a non-empty file that produced no steps and has no `-- no steps` line.
 *
 * An intentional empty plan from `formatPlan` carries that line.
 * Anything else would apply as "nothing to apply" and skip the linter.
 *
 * @param text - Text already passed through {@link prepareMigrationText}
 * @param stepCount - Steps the parser returned
 * @param label - File name in the error
 */
export function assertMigrationSteps(text: string, stepCount: number, label: string): void {
  if (stepCount > 0 || text.trim().length === 0) return;
  if (text.split("\n").includes("-- no steps")) return;
  throw new MigrationTextError("no-steps", `${label} has text but no steps. okm did not apply it.`);
}
