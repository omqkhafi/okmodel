/**
 * Writes the fill into a plan, and the apply check that refuses a plan
 * without one (D195, D334).
 *
 * Order: backfill, check NOT VALID, the same backfill, validate, set not
 * null, drop the check. The statement is the D195 null fill.
 */

import { OkmError } from "../../contracts/error.js";
import type { Catalog, ColumnObject } from "../../contracts/catalog/types.js";
import { ddlStep } from "../../dialects/ddl-step.js";
import { qualify, quoteIdent } from "../../dialects/pg/ddl.js";
import { notNullSteps } from "../../dialects/pg/table-safe.js";
import { nullFillUpdate, primaryKeyColumns, resolveBatchSize } from "./backfill.js";
import { strictestClass } from "./classify.js";
import { countPhrase, type Fill, type ProbeCount } from "./data-probe.js";
import type { MigrationPlan, PlanStep } from "./plan.js";

export function spliceFills(
  plan: MigrationPlan,
  fills: readonly Fill[],
  catalogs: readonly Catalog[],
  schema: string,
  batchSize?: number,
): MigrationPlan {
  const batch = resolveBatchSize(batchSize);
  let steps = [...plan.steps];
  for (const fill of fills) steps = spliceOne(steps, fill, catalogs, schema, batch);
  return { ...plan, steps, class: strictestClass(steps.map((step) => step.class)) };
}

export function unfilledRequired(
  steps: readonly { readonly sql: string }[],
): readonly { readonly table: string; readonly column: string; readonly added: boolean }[] {
  const found: { table: string; column: string; added: boolean }[] = [];
  for (const step of steps) {
    const set = /^alter table\s+(\S+)\s+alter column\s+(\S+)\s+set not null\b/.exec(step.sql);
    const add = /^alter table\s+(\S+)\s+add column\s+(\S+)\s+(?!generated\b).+\bnot null\b/.exec(
      step.sql,
    );
    const match = set ?? add;
    if (match === null) continue;
    if (add !== null && /\bdefault\b/.test(step.sql)) continue;
    const table = lastIdent(match[1] ?? "");
    const column = unquote(match[2] ?? "");
    if (filled(steps, table, column)) continue;
    if (found.some((item) => item.table === table && item.column === column)) continue;
    found.push({ table, column, added: add !== null && set === null });
  }
  return found;
}

/**
 * OKM1525 before apply changes anything.
 *
 * @param table - Table name
 * @param column - Column name
 * @param count - Empty rows
 * @returns The error. The fix names both next steps
 */
export function unfilledError(table: string, column: string, count: ProbeCount): OkmError {
  const how =
    count.kind === "exact"
      ? `${countPhrase(count)} rows with no value`
      : count.kind === "least"
        ? "10,000 or more rows with no value"
        : "rows with no value (I could not count in 2 s)";
  return new OkmError(
    "OKM1525",
    `${table}.${column} has ${how}, and this migration does not fill them.\nNothing was changed.`,
    {
      fix: {
        summary: `Regenerate it with --fill ${table}.${column}=<expression> if it has not run anywhere shared. Otherwise add a data migration that fills ${table}.${column} before the constraint.`,
      },
    },
  );
}

function spliceOne(
  steps: readonly PlanStep[],
  fill: Fill,
  catalogs: readonly Catalog[],
  schema: string,
  batch: number,
): PlanStep[] {
  const backfill = backfillStep(fill, catalogs, schema, batch);
  const quoted = quoteIdent(fill.column);
  const check = steps.findIndex(
    (step) =>
      step.sql.includes(`check (${quoted} is not null) not valid`) &&
      step.sql.includes(quoteIdent(fill.table)),
  );
  if (check >= 0) {
    const next = [...steps];
    next.splice(check, 0, backfill);
    next.splice(check + 2, 0, backfill);
    return next;
  }
  const add = steps.findIndex(
    (step) =>
      step.kind === "add-column-required" &&
      step.sql.includes(quoted) &&
      step.sql.includes(quoteIdent(fill.table)),
  );
  if (add < 0) {
    throw new OkmError("invalid", `No required-column step for ${fill.table}.${fill.column}.`, {
      fix: {
        summary: "Generate the migration again. The column has to become required in this plan.",
      },
    });
  }
  const column = columnObject(catalogs, fill.table, fill.column);
  const added = steps[add];
  if (added === undefined) return [...steps];
  const nullable: PlanStep = {
    ...added,
    sql: added.sql.replace(/ not null$/, ""),
    kind: "add-column",
    class: "expand",
  };
  const rewritten = notNullSteps(column, schema, "add-column", catalogs).map((item) =>
    ddlStep(item.sql, item.kind, item.action, item.lock, item.transactional),
  );
  const sequence = [backfill, rewritten[0], backfill, ...rewritten.slice(1)].filter(
    (step): step is PlanStep => step !== undefined,
  );
  return [...steps.slice(0, add), nullable, ...sequence, ...steps.slice(add + 1)];
}

function backfillStep(
  fill: Fill,
  catalogs: readonly Catalog[],
  schema: string,
  batch: number,
): PlanStep {
  const key = primaryKeyColumns(catalogs, fill.table);
  const table = qualify(schema, fill.table);
  const name = quoteIdent(fill.column);
  const filled = nullFillUpdate(table, name, fill.expression, key, batch);
  return {
    ...ddlStep(filled.sql, "backfill-contract", "backfill", "ROW EXCLUSIVE", false),
    backfill: filled.backfill,
  };
}

function columnObject(catalogs: readonly Catalog[], table: string, column: string): ColumnObject {
  for (const source of catalogs) {
    for (const object of source.objects) {
      if (
        object.kind === "column" &&
        object.identity.parent.name === table &&
        object.identity.name === column
      ) {
        return object;
      }
    }
  }
  throw new OkmError("invalid", `Column ${table}.${column} is not in the catalog.`, {
    fix: { summary: "Keep the column on the table this migration changes." },
  });
}

function filled(
  steps: readonly { readonly sql: string }[],
  table: string,
  column: string,
): boolean {
  const name = quoteIdent(column);
  return steps.some(
    (step) =>
      step.sql.startsWith("update ") &&
      step.sql.includes(quoteIdent(table)) &&
      step.sql.includes(`set ${name} =`) &&
      step.sql.includes(`${name} is null`),
  );
}

function lastIdent(token: string): string {
  const names = [...token.matchAll(/"((?:[^"]|"")*)"/g)].map((match) =>
    (match[1] ?? "").replaceAll('""', '"'),
  );
  return names.at(-1) ?? token;
}

function unquote(token: string): string {
  const match = /^"((?:[^"]|"")*)"$/.exec(token);
  return match === null ? token : (match[1] ?? "").replaceAll('""', '"');
}
