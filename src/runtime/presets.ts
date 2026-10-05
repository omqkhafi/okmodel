/**
 * Runs the presets chained on a table handle.
 *
 * Loaded on the first call that uses a preset. A schema with no preset, and a
 * call that chains none, never load this file.
 *
 * A preset gets a builder with one method, `where`, which adds a filter. The
 * filters join the caller's with AND (`stack`), and the planner writes the
 * tenant predicate and the active set around the result, so no preset can
 * remove either one (D125, D126).
 */

import { OkmError } from "../contracts/error.js";
import type { PresetUse, QuerySchema, TableModel } from "../dialects/pg/model.js";
import { isOperator, operatorValue } from "../dialects/pg/operators.js";
import { checkPresetNames } from "../dialects/pg/preset.js";
import type { AppliedRule, ReadCall } from "./plan.js";
import { stack } from "./preset-stack.js";

/** The filters a chain of presets added, and the inspect lines that name them. */
export type Resolved = {
  readonly wheres: readonly unknown[];
  readonly rules: readonly AppliedRule[];
};

/**
 * Fails on a preset name that is a client method or reserved.
 *
 * Runs when the client connects, for every table that has presets, so a bad
 * name fails before the first query and not at the first preset call.
 *
 * @param schema - Connected schema
 */
export function checkSchema(schema: QuerySchema): void {
  for (const name in schema.model) {
    const presets = schema.model[name]?.presets;
    if (presets !== undefined) checkPresetNames(Object.keys(presets), `table ${name}`);
  }
}

/**
 * Runs the chained presets and collects what each one added.
 *
 * @param schema - Connected schema
 * @param table - Table the chain is on
 * @param uses - The last preset call in the chain
 * @returns The filters, in call order, and one `preset` rule per call
 */
export function resolve(schema: QuerySchema, table: string, uses: PresetUse): Resolved {
  const model = schema.model[table];
  const known = model?.presets ?? {};
  const chain: PresetUse[] = [];
  for (let use: PresetUse | undefined = uses; use !== undefined; use = use[0]) chain.unshift(use);
  const wheres: unknown[] = [];
  const rules: AppliedRule[] = [];
  for (const [, name, args] of chain) {
    const preset = known[name];
    if (typeof preset !== "function") {
      throw new OkmError("OKM1120", `Table ${table} has no preset ${name}.`, {
        fix: { summary: `Use one of: ${Object.keys(known).join(", ")}.` },
      });
    }
    const added: unknown[] = [];
    const q = {
      where(filter: unknown) {
        added.push(filter);
        return q;
      },
    };
    if ((preset as (q: unknown, ...rest: readonly unknown[]) => unknown)(q, ...args) !== q) {
      throw new OkmError(
        "OKM1121",
        `Preset ${name} on ${table} must return the builder it was given.`,
        { fix: { summary: "Return q, as in (q) => q.where({ ... })." } },
      );
    }
    for (const filter of added) wheres.push(filter);
    rules.push({
      rule: "preset",
      contribution: `${name} filters ${[...new Set(added.flatMap(fieldsOf))].join(", ") || "nothing"}`,
      provenance: ownerOf(model, name, table),
      ...(model?.source !== undefined ? { source: model.source } : {}),
    });
  }
  return { wheres, rules };
}

/**
 * Applies the chained presets to a read.
 *
 * The caller's `where` stays first. The call keeps its tenant and active-set
 * rules, and gains one `preset` rule per call for `inspect()`.
 *
 * @param schema - Connected schema
 * @param call - The read as the caller wrote it
 * @param uses - Presets chained on the handle
 * @returns The same read with the presets' filters stacked after its `where`
 */
export function refine(schema: QuerySchema, call: ReadCall, uses: PresetUse): ReadCall {
  const { wheres, rules } = resolve(schema, call.table, uses);
  return {
    ...call,
    where: stack(call.where, wheres),
    ruleLines: [...(call.ruleLines ?? []), ...rules],
  };
}

/** `trait <name>` when a trait added the preset, else the table. */
function ownerOf(model: TableModel | undefined, name: string, table: string): string {
  for (const trait of model?.traits ?? []) {
    const presets = (trait as { readonly presets?: object }).presets;
    if (presets !== undefined && Object.hasOwn(presets, name)) return `trait ${trait.name}`;
  }
  return `table ${table}`;
}

/** Field names a filter constrains, across the branches of an `or`. Never values. */
function fieldsOf(filter: unknown): string[] {
  if (isOperator(filter)) {
    const branches = operatorValue(filter);
    return Array.isArray(branches) ? branches.flatMap(fieldsOf) : [];
  }
  return typeof filter === "object" && filter !== null ? Object.keys(filter) : [];
}
