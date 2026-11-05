/**
 * `okm generate` asks before it writes a migration that drops an object.
 *
 * A yes writes `-- okm-allow CODE: reason` on each drop step, so the file
 * still carries the acknowledgement a reviewer reads. A no writes nothing.
 * The question is asked only on a terminal without `--json`.
 */

import type { Finding } from "./lint.js";
import type { MigrationPlan, PlanStep } from "./plan.js";

/** Lint codes for a planned drop: table, column, enum, domain, function, view, extension, materialized view. */
const DROP_CODES: ReadonlySet<string> = new Set([
  "OKM1511",
  "OKM1512",
  "OKM1513",
  "OKM1514",
  "OKM1515",
  "OKM1516",
  "OKM1517",
  "OKM1518",
]);

/** Written when the person answers yes and leaves the reason empty. */
export const DEFAULT_DROP_REASON = "confirmed at okm generate";

/** One planned drop, as the question lists it. */
export type PlannedDrop = {
  /** One-based step number. */
  readonly step: number;
  readonly code: string;
  readonly sql: string;
};

/**
 * Asks whether the planned drops are intended.
 *
 * @returns The reason to write, or `undefined` when the person declined
 */
export type ConfirmDrops = (drops: readonly PlannedDrop[]) => Promise<string | undefined>;

/**
 * The drop findings of a plan, one per step and code.
 *
 * @param plan - Planned steps
 * @param findings - Lint findings for that plan
 * @returns Drops in step order
 */
export function plannedDrops(plan: MigrationPlan, findings: readonly Finding[]): PlannedDrop[] {
  const drops: PlannedDrop[] = [];
  for (const finding of findings) {
    if (finding.severity !== "error" || !DROP_CODES.has(finding.code)) continue;
    const step = Number(/^step (\d+)/.exec(finding.place)?.[1]);
    const item = plan.steps[step - 1];
    if (item === undefined) continue;
    if (drops.some((drop) => drop.step === step && drop.code === finding.code)) continue;
    drops.push({ step, code: finding.code, sql: item.sql });
  }
  return drops;
}

/**
 * The plan with `-- okm-allow` on each drop step.
 *
 * @param plan - Planned steps
 * @param drops - Drops from {@link plannedDrops}
 * @param reason - Reason text after the colon
 * @returns A new plan. Steps without a drop are the same objects
 */
export function acknowledgeDrops(
  plan: MigrationPlan,
  drops: readonly PlannedDrop[],
  reason: string,
): MigrationPlan {
  const steps = plan.steps.map((item, index): PlanStep => {
    const codes = drops.filter((drop) => drop.step === index + 1).map((drop) => drop.code);
    if (codes.length === 0) return item;
    return {
      ...item,
      allows: [...(item.allows ?? []), ...codes.map((code) => ({ code, reason }))],
    };
  });
  return { ...plan, steps };
}

/**
 * Terminal question for {@link ConfirmDrops}.
 *
 * @param ask - Reads one answer. The question text goes to stderr
 * @param write - Writes the list of drops to stderr
 * @returns The callback `okm generate` passes on a terminal
 */
export function terminalConfirm(
  ask: (label: string) => Promise<string>,
  write: (text: string) => void,
): ConfirmDrops {
  return async (drops) => {
    let text = "This migration drops data:\n";
    for (const drop of drops) text += `  step ${String(drop.step)} ${drop.code}: ${drop.sql}\n`;
    write(text);
    const answer = (await ask("Drop it? [y/N] ")).toLowerCase();
    if (answer !== "y" && answer !== "yes") return undefined;
    const reason = (await ask(`Reason (Enter for "${DEFAULT_DROP_REASON}"): `)).trim();
    return reason.length === 0 ? DEFAULT_DROP_REASON : reason;
  };
}
