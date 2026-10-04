/**
 * Phrases the archive safety rule reads.
 *
 * Installed by `archivable()`. A schema that does not use the trait does not
 * load this file, and reads record nothing.
 */

import type { TableModel } from "../dialects/pg/model.js";
import { installArchiveInspect, type AppliedRule, type ArchiveView } from "./plan.js";

/**
 * Installs the phrase recorder on the planner.
 *
 * Safe to call more than once. The recorder replaces the previous one.
 */
export function installArchiveContributions(): void {
  installArchiveInspect(archiveContributions);
}

function archiveContributions(
  model: TableModel | undefined,
  view: ArchiveView | undefined,
): readonly AppliedRule[] | undefined {
  const archive = model?.archive;
  if (archive === undefined) return undefined;
  const rules: AppliedRule[] = [
    view === "with"
      ? { rule: "archive", contribution: "with archived", provenance: "caller" }
      : view === "only"
        ? { rule: "archive", contribution: "only archived", provenance: "caller" }
        : { rule: "archive", contribution: "active set", provenance: "planner" },
  ];
  for (const child of archive.cascade) {
    rules.push({
      rule: "archive",
      contribution: `cascade ${child.table}`,
      provenance: "catalog",
    });
  }
  return rules;
}
