/**
 * Schema rules for `okm check` (OKM2101, OKM2102, OKM2103).
 *
 * The rules read the catalog, the query model, and the `filters()` calls in
 * source. They do not connect. A rule that cannot decide stays silent: an
 * expression index makes the columns it names undecidable, a preset that
 * throws without its arguments adds nothing, and a `filters()` field that
 * is not a literal is not read.
 */

import type { Catalog, ObjectRef } from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";
import type { TableModel } from "../../dialects/pg/model.js";
import { warningRule, type WarningIgnore } from "../../runtime/warnings/catalog.js";
import type { WarningLevel, WarningRule } from "../../runtime/warnings/catalog.js";
import { resolvedLevel } from "../../runtime/warnings/level.js";
import { fieldsOf } from "../../runtime/presets.js";
import { attachCliDetail } from "../errors/shape.js";
import type { FilterUse } from "./filter-scan.js";

/** What the rules read from a built schema. */
export type SchemaAdviceInput = {
  readonly catalog: Catalog;
  readonly model: Readonly<Record<string, TableModel>>;
  readonly tenancy?: { readonly key: string; readonly keys?: readonly string[] } | undefined;
};

/** Levels and project ignores from `defineConfig({ warnings })`. */
export type SchemaAdviceConfig = {
  readonly levels?: Readonly<Record<string, WarningLevel>> | undefined;
  readonly ignore?: readonly WarningIgnore[] | undefined;
};

/** One finding the project did not ignore. `level` is never `off`. */
export type SchemaAdvice = {
  readonly code: string;
  readonly rule: string;
  readonly level: Exclude<WarningLevel, "off">;
  readonly severity: WarningRule["severity"];
  /** `table` or `table.column`, in SQL names. What an ignore `target` matches. */
  readonly target: string;
  readonly reason: string;
  readonly fix: string;
  readonly location?: { readonly file: string; readonly line: number };
};

/**
 * One project ignore, as `okm check` reports it.
 *
 * `status` is set for a rule `okm check` evaluates. `applied` means a
 * finding matched. `stale` means none did. Other rules have no status.
 */
export type IgnoreReport = {
  readonly rule: string;
  readonly reason: string;
  readonly target?: string;
  readonly status?: "applied" | "stale";
};

type Found = {
  readonly rule: WarningRule;
  readonly table: string;
  readonly target: string;
  readonly reason: string;
  readonly location?: { readonly file: string; readonly line: number };
};

type Group = {
  readonly name: string;
  managed: boolean;
  primary: boolean;
  readonly keys: (readonly string[])[];
  readonly opaque: (readonly string[])[];
  readonly foreign: {
    readonly columns: readonly string[];
    readonly parent: string;
    readonly parentColumns: readonly string[];
  }[];
};

/**
 * Runs the schema rules and applies levels and project ignores.
 *
 * `okm check` has no environment: a rule without a configured level uses the
 * registry default. A finding at level `off` is dropped. An ignore is matched
 * before the level, so turning a rule off does not make its ignore stale.
 *
 * @param input - Catalog, model, and tenancy of the built schema
 * @param uses - `filters()` fields found in source
 * @param config - `warnings.levels` and `warnings.ignore`
 * @returns The findings to report and one report per project ignore
 */
export function schemaAdvice(
  input: SchemaAdviceInput,
  uses: readonly FilterUse[],
  config: SchemaAdviceConfig,
): { readonly advice: readonly SchemaAdvice[]; readonly ignores: readonly IgnoreReport[] } {
  const groups = groupTables(input.catalog);
  const found = [
    ...missingForeignIndexes(groups),
    ...missingPrimaryKeys(groups),
    ...missingFilterIndexes(groups, input, uses),
  ].sort(compareFound);
  const ignore = config.ignore ?? [];
  const used = new Set<WarningIgnore>();
  const advice: SchemaAdvice[] = [];
  for (const item of found) {
    const hit = ignore.filter((entry) => matches(entry, item));
    for (const entry of hit) used.add(entry);
    if (hit.length > 0) continue;
    const level = resolvedLevel(item.rule, config.levels, "development");
    if (level === "off") continue;
    advice.push({
      code: item.rule.code,
      rule: item.rule.rule,
      level,
      severity: item.rule.severity,
      target: item.target,
      reason: item.reason,
      fix: item.rule.fix,
      ...(item.location !== undefined ? { location: item.location } : {}),
    });
  }
  const ignores = ignore.map((entry): IgnoreReport => {
    const base = {
      rule: entry.rule,
      reason: entry.reason,
      ...(entry.target !== undefined ? { target: entry.target } : {}),
    };
    if (!checked(entry.rule)) return base;
    return { ...base, status: used.has(entry) ? "applied" : "stale" };
  });
  return { advice, ignores };
}

/**
 * The refusal for findings at level `error`.
 *
 * @param advice - Findings from {@link schemaAdvice}
 * @returns The error, or `undefined` when no finding is an error
 */
export function adviceRefusal(advice: readonly SchemaAdvice[]): OkmError | undefined {
  const errors = advice.filter((item) => item.level === "error");
  const first = errors[0];
  if (first === undefined) return undefined;
  const lines = errors.map((item) => `${item.code} ${item.target}: ${item.reason}`);
  const error = new OkmError(first.code, lines.join("\n"), {
    kind: "invalid",
    fix: { summary: first.fix },
  });
  return first.location === undefined
    ? error
    : attachCliDetail(error, { location: first.location });
}

/**
 * One line per finding, for the human output.
 *
 * @param advice - Findings from {@link schemaAdvice}
 * @returns The text, or `""` when there are none
 */
export function formatAdvice(advice: readonly SchemaAdvice[]): string {
  if (advice.length === 0) return "";
  const lines = advice.map(
    (item) => `${item.level} ${item.code} ${item.target}: ${item.reason} -- fix: ${item.fix}`,
  );
  return `${lines.join("\n")}\n`;
}

function compareFound(left: Found, right: Found): number {
  if (left.rule.code !== right.rule.code) return left.rule.code < right.rule.code ? -1 : 1;
  if (left.target === right.target) return 0;
  return left.target < right.target ? -1 : 1;
}

function checked(rule: string): boolean {
  return warningRule(rule)?.phase === "check";
}

function matches(entry: WarningIgnore, item: Found): boolean {
  if (entry.rule !== item.rule.rule) return false;
  return entry.target === undefined || entry.target === item.table || entry.target === item.target;
}

function refKey(ref: ObjectRef): string {
  return `${ref.namespace.form === "static" ? ref.namespace.name : ref.namespace.pattern}.${ref.name}`;
}

function groupTables(catalog: Catalog): ReadonlyMap<string, Group> {
  const groups = new Map<string, Group>();
  const open = (ref: ObjectRef): Group => {
    const key = refKey(ref);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        name: ref.name,
        managed: false,
        primary: false,
        keys: [],
        opaque: [],
        foreign: [],
      };
      groups.set(key, group);
    }
    return group;
  };
  for (const object of catalog.objects) {
    if (object.kind === "table") {
      open({ namespace: object.identity.namespace, name: object.identity.name }).managed =
        object.owner === "managed";
    } else if (object.kind === "index") {
      const group = open(object.identity.parent);
      const { columns, expression } = object.definition;
      (expression === undefined ? group.keys : group.opaque).push(columns);
    } else if (object.kind === "constraint") {
      const group = open(object.identity.parent);
      const { constraintKind, columns, references } = object.definition;
      if (constraintKind === "primaryKey") {
        group.primary = true;
        group.keys.push(columns);
      } else if (constraintKind === "unique") {
        group.keys.push(columns);
      } else if (constraintKind === "foreignKey" && references !== undefined) {
        group.foreign.push({
          columns,
          parent: references.parent.name,
          parentColumns: references.columns,
        });
      }
    }
  }
  for (const [key, group] of groups) if (!group.managed) groups.delete(key);
  return groups;
}

function missingForeignIndexes(groups: ReadonlyMap<string, Group>): readonly Found[] {
  const rule = registered("unindexed-foreign-key");
  const found: Found[] = [];
  for (const group of groups.values()) {
    for (const key of group.foreign) {
      if (key.columns.length === 0 || undecided(group, key.columns)) continue;
      const covered = group.keys.some(
        (list) =>
          list.length >= key.columns.length &&
          sameSet(list.slice(0, key.columns.length), key.columns),
      );
      if (covered) continue;
      const columns = key.columns.join(", ");
      found.push({
        rule,
        table: group.name,
        target: `${group.name}.${key.columns.join(",")}`,
        reason: `Foreign key ${group.name} (${columns}) references ${key.parent} (${key.parentColumns.join(", ")}), but no index starts with ${columns}.`,
      });
    }
  }
  return found;
}

function missingPrimaryKeys(groups: ReadonlyMap<string, Group>): readonly Found[] {
  const rule = registered("table-without-primary-key");
  const found: Found[] = [];
  for (const group of groups.values()) {
    if (group.primary) continue;
    found.push({
      rule,
      table: group.name,
      target: group.name,
      reason: `Table ${group.name} has no primary key.`,
    });
  }
  return found;
}

type Reach = {
  readonly sources: string[];
  location?: { readonly file: string; readonly line: number };
};

function missingFilterIndexes(
  groups: ReadonlyMap<string, Group>,
  input: SchemaAdviceInput,
  uses: readonly FilterUse[],
): readonly Found[] {
  const rule = registered("unindexed-filter-column");
  const found: Found[] = [];
  const tenantFields = input.tenancy?.keys ?? (input.tenancy ? [input.tenancy.key] : []);
  for (const name of Object.keys(input.model)) {
    const model = input.model[name];
    if (model === undefined) continue;
    const owners = [...groups.values()].filter((group) => group.name === model.sql);
    const group = owners[0];
    if (owners.length !== 1 || group === undefined) continue;
    const reached = new Map<string, Reach>();
    const reach = (field: string, source: string, at?: FilterUse): void => {
      const column = model.columns.find((item) => item.field === field);
      if (column === undefined) return;
      let entry = reached.get(column.sql);
      if (entry === undefined) {
        entry = { sources: [] };
        reached.set(column.sql, entry);
      }
      if (!entry.sources.includes(source)) entry.sources.push(source);
      if (entry.location === undefined && at !== undefined) {
        entry.location = { file: at.file, line: at.line };
      }
    };
    for (const use of uses) {
      if (use.table === model.name) reach(use.field, `the filters() ${use.list} list`, use);
    }
    for (const preset of presetFields(model)) {
      for (const field of preset.fields) reach(field, `preset ${preset.name}`);
    }
    const tenant = new Set<string>();
    for (const field of tenantFields) {
      const column = model.columns.find((item) => item.field === field);
      if (column !== undefined) tenant.add(column.sql);
    }
    for (const [column, entry] of reached) {
      if (undecided(group, [column])) continue;
      if (group.keys.some((list) => leads(list, column, tenant))) continue;
      found.push({
        rule,
        table: group.name,
        target: `${group.name}.${column}`,
        reason: `${group.name}.${column} is used by ${entry.sources.join(", ")}, but no index starts with ${column}.`,
        ...(entry.location !== undefined ? { location: entry.location } : {}),
      });
    }
  }
  return found;
}

function presetFields(
  model: TableModel,
): readonly { readonly name: string; readonly fields: readonly string[] }[] {
  const out: { name: string; fields: readonly string[] }[] = [];
  for (const [name, preset] of Object.entries(model.presets ?? {})) {
    if (typeof preset !== "function") continue;
    const added: unknown[] = [];
    const q = {
      where(filter: unknown) {
        added.push(filter);
        return q;
      },
    };
    try {
      if ((preset as (builder: unknown) => unknown)(q) !== q) continue;
    } catch {
      continue;
    }
    out.push({ name, fields: [...new Set(added.flatMap(fieldsOf))] });
  }
  return out;
}

function leads(list: readonly string[], column: string, tenant: ReadonlySet<string>): boolean {
  if (list[0] === column) return true;
  let at = 0;
  while (at < list.length && tenant.has(list[at] ?? "")) at += 1;
  return at > 0 && list[at] === column;
}

function undecided(group: Group, columns: readonly string[]): boolean {
  return group.opaque.some(
    (list) => list.length === 0 || list.some((column) => columns.includes(column)),
  );
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function registered(rule: string): WarningRule {
  const found = warningRule(rule);
  if (found === undefined) throw new Error(`${rule} missing from the warning registry.`);
  return found;
}
