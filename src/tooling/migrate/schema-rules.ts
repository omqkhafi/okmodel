/**
 * Schema rules for `okm check` (OKM2101, OKM2102, OKM2103).
 *
 * The rules read the catalog, the query model, and the `filters()` calls in
 * source. They do not connect. A rule that cannot decide stays silent: an
 * expression index makes the columns it names undecidable, a preset that
 * throws without its arguments adds nothing, and a `filters()` field that
 * is not a literal is not read.
 */

import type { Catalog, IndexDefinition, ObjectRef } from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";
import type { TableModel } from "../../dialects/pg/model.js";
import type { RolesInput } from "../../dialects/pg/role/config.js";
import { warningRule, type WarningIgnore } from "../../runtime/warnings/catalog.js";
import { policyFindings } from "./policy-rules.js";
import { procedureFindings } from "./procedure-rules.js";
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
  readonly partials: { readonly columns: readonly string[]; readonly predicate: string }[];
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
  roles?: RolesInput,
): { readonly advice: readonly SchemaAdvice[]; readonly ignores: readonly IgnoreReport[] } {
  const groups = groupTables(input.catalog);
  const found = [
    ...missingForeignIndexes(groups),
    ...missingPrimaryKeys(groups),
    ...missingFilterIndexes(groups, input, uses),
    ...duplicateIndexes(input.catalog),
    ...genericPlanTrap(groups, input, uses),
    ...nullableMatchSimple(input.catalog),
    ...policyFindings(input.catalog, roles),
    ...procedureFindings(input.catalog, input.tenancy),
    ...seriesFindings(input.catalog),
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

function seriesFindings(catalog: Catalog): Found[] {
  const found: Found[] = [];
  const deleteRule = warningRule("counter-delete");
  const periodRule = warningRule("reference-period");
  const yearRule = warningRule("reference-year");
  const resetting = new Set<string>();
  const counters = new Set<string>();
  const archived = new Set<string>();
  const types = new Map<string, string>();
  for (const object of catalog.objects) {
    if (object.kind !== "column") continue;
    const table = object.identity.parent.name;
    types.set(`${table}.${object.identity.name}`, object.definition.dataType);
    if (object.identity.name === "archivedAt") archived.add(table);
    const series = object.definition.series;
    if (series === undefined) continue;
    counters.add(table);
    if (series.reset !== undefined) resetting.add(table);
  }
  if (deleteRule !== undefined) {
    for (const table of counters) {
      if (archived.has(table)) continue;
      const deletes = catalog.objects.some(
        (object) =>
          object.kind === "grant" &&
          object.identity.object.kind === "table" &&
          object.identity.object.name === table &&
          object.identity.privilege === "DELETE",
      );
      if (!deletes) continue;
      found.push({
        rule: deleteRule,
        table,
        target: table,
        reason: `${table} has a counter and a DELETE grant. A deleted row leaves a gap and the number is not reused.`,
      });
    }
  }
  if (periodRule !== undefined) {
    for (const object of catalog.objects) {
      if (object.kind !== "column" || object.definition.series?.reset === undefined) continue;
      const table = object.identity.parent.name;
      const number = object.identity.name;
      const watched = new Set<string>([number]);
      for (const column of catalog.objects) {
        if (column.kind !== "column" || column.identity.parent.name !== table) continue;
        const expression = column.definition.generated?.expression;
        if (expression !== undefined && expression.includes(number))
          watched.add(column.identity.name);
      }
      for (const index of catalog.objects) {
        if (
          index.kind !== "index" ||
          index.identity.parent.name !== table ||
          !index.definition.unique
        ) {
          continue;
        }
        if (!index.definition.columns.some((name) => watched.has(name))) continue;
        const expression = index.definition.expression ?? "";
        if (expression.includes("extract(") || expression.includes("date_trunc(")) continue;
        found.push({
          rule: periodRule,
          table,
          target: `${table}.${index.identity.name}`,
          reason: `${table}.${number} resets, and unique index ${index.identity.name} does not include the period.`,
        });
      }
    }
  }
  if (yearRule !== undefined) {
    for (const object of catalog.objects) {
      if (object.kind !== "column" || !resetting.has(object.identity.parent.name)) continue;
      const expression = object.definition.generated?.expression;
      if (expression === undefined) continue;
      const folded = expression.toLowerCase();
      const year =
        folded.includes("extract(year") ||
        folded.includes("date_trunc('year'") ||
        folded.includes('date_trunc("year"');
      if (!year || folded.includes("at time zone")) continue;
      const table = object.identity.parent.name;
      const unstable = [...types.entries()].some(([key, type]) => {
        if (!key.startsWith(`${table}.`) || type !== "timestamptz") return false;
        const name = key.slice(table.length + 1);
        return expression.includes(`"${name}"`) || expression.includes(name);
      });
      if (!unstable) continue;
      found.push({
        rule: yearRule,
        table,
        target: `${table}.${object.identity.name}`,
        reason: `${table}.${object.identity.name} takes a year from timestamptz. Use a date or timestamp column, or at time zone with a constant zone.`,
      });
    }
  }
  return found;
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
        partials: [],
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
      const { columns, expression, predicate } = object.definition;
      if (expression !== undefined) group.opaque.push(columns);
      else if (predicate !== undefined) group.partials.push({ columns, predicate });
      else group.keys.push(columns);
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
    const presets = presetFields(model);
    for (const preset of presets) {
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
      if (partialCovers(group, column, tenant, entry, presets, model)) continue;
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

function presetFields(model: TableModel): readonly {
  readonly name: string;
  readonly fields: readonly string[];
  readonly filters: readonly unknown[];
}[] {
  const out: { name: string; fields: readonly string[]; filters: readonly unknown[] }[] = [];
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
    out.push({ name, fields: [...new Set(added.flatMap(fieldsOf))], filters: added });
  }
  return out;
}

function partialCovers(
  group: Group,
  column: string,
  tenant: ReadonlySet<string>,
  entry: Reach,
  presets: readonly { readonly name: string; readonly filters: readonly unknown[] }[],
  model: TableModel,
): boolean {
  return group.partials.some((partial) => {
    if (!leads(partial.columns, column, tenant)) return false;
    return entry.sources.every((source) => {
      if (!source.startsWith("preset ")) return false;
      const preset = presets.find((item) => item.name === source.slice("preset ".length));
      return (
        preset?.filters.some((filter) => predicateIncluded(partial.predicate, filter, model)) ===
        true
      );
    });
  });
}

function predicateIncluded(predicate: string, filter: unknown, model: TableModel): boolean {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return false;
  const body = predicate.toLowerCase();
  const entries = Object.entries(filter);
  if (entries.length === 0) return false;
  for (const [field, value] of entries) {
    const column = model.columns.find((item) => item.field === field);
    const sql = (column?.sql ?? field).toLowerCase();
    if (!body.includes(sql)) return false;
    if (value === null) {
      if (!body.includes("is null")) return false;
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      if (!body.includes(String(value).toLowerCase())) return false;
      continue;
    }
    return false;
  }
  return true;
}

function duplicateIndexes(catalog: Catalog): readonly Found[] {
  const duplicate = registered("duplicate-index");
  const redundant = registered("redundant-index");
  const found: Found[] = [];
  const byTable = new Map<string, Extract<(typeof catalog.objects)[number], { kind: "index" }>[]>();
  for (const object of catalog.objects) {
    if (object.kind !== "index") continue;
    const list = byTable.get(object.identity.parent.name) ?? [];
    list.push(object);
    byTable.set(object.identity.parent.name, list);
  }
  for (const [table, indexes] of byTable) {
    for (let leftAt = 0; leftAt < indexes.length; leftAt += 1) {
      for (let rightAt = leftAt + 1; rightAt < indexes.length; rightAt += 1) {
        const left = indexes[leftAt];
        const right = indexes[rightAt];
        if (left === undefined || right === undefined) continue;
        if (sameIndex(left.definition, right.definition)) {
          found.push({
            rule: duplicate,
            table,
            target: `${table}.${right.identity.name}`,
            reason: `Index ${right.identity.name} duplicates ${left.identity.name}.`,
          });
          continue;
        }
        const shorter = prefixRedundant(left, right);
        if (shorter === undefined) continue;
        found.push({
          rule: redundant,
          table,
          target: `${table}.${shorter.identity.name}`,
          reason: `Index ${shorter.identity.name} is a prefix of another index on ${table}. A unique, partial, or expression index is redundant only on a full match.`,
        });
      }
    }
  }
  return found;
}

function sameIndex(left: IndexDefinition, right: IndexDefinition): boolean {
  return (
    left.unique === right.unique &&
    (left.method ?? "btree") === (right.method ?? "btree") &&
    left.predicate === right.predicate &&
    left.expression === right.expression &&
    left.columns.length === right.columns.length &&
    left.columns.every((column, index) => column === right.columns[index])
  );
}

function prefixRedundant(
  left: Extract<Catalog["objects"][number], { kind: "index" }>,
  right: Extract<Catalog["objects"][number], { kind: "index" }>,
): Extract<Catalog["objects"][number], { kind: "index" }> | undefined {
  if (!plainIndex(left) || !plainIndex(right)) return undefined;
  const leftCols = left.definition.columns;
  const rightCols = right.definition.columns;
  if (
    leftCols.length < rightCols.length &&
    leftCols.every((column, index) => column === rightCols[index])
  ) {
    return left;
  }
  if (
    rightCols.length < leftCols.length &&
    rightCols.every((column, index) => column === leftCols[index])
  ) {
    return right;
  }
  return undefined;
}

function plainIndex(index: Extract<Catalog["objects"][number], { kind: "index" }>): boolean {
  return (
    index.definition.unique !== true &&
    index.definition.predicate === undefined &&
    index.definition.expression === undefined
  );
}

function genericPlanTrap(
  groups: ReadonlyMap<string, Group>,
  input: SchemaAdviceInput,
  uses: readonly FilterUse[],
): readonly Found[] {
  const rule = registered("partial-index-bound-value");
  const found: Found[] = [];
  for (const name of Object.keys(input.model)) {
    const model = input.model[name];
    if (model === undefined) continue;
    const group = [...groups.values()].find((item) => item.name === model.sql);
    if (group === undefined) continue;
    const bound = new Set<string>();
    for (const use of uses) {
      if (use.table !== model.name) continue;
      const column = model.columns.find((item) => item.field === use.field);
      if (column !== undefined) bound.add(column.sql);
    }
    for (const preset of presetFields(model)) {
      for (const field of preset.fields) {
        const column = model.columns.find((item) => item.field === field);
        if (column !== undefined) bound.add(column.sql);
      }
    }
    for (const partial of group.partials) {
      for (const column of partial.columns) {
        if (!bound.has(column)) continue;
        if (!partial.predicate.toLowerCase().includes(column.toLowerCase())) continue;
        found.push({
          rule,
          table: group.name,
          target: `${group.name}.${column}`,
          reason: `${group.name}.${column} is filtered with a bound value and is also a partial-index predicate column. Presets and filters() compile to parameters, so the generic plan may ignore that index.`,
        });
      }
    }
  }
  return found;
}

function nullableMatchSimple(catalog: Catalog): Found[] {
  const rule = warningRule("nullable-match-simple");
  if (rule === undefined) return [];
  const nullable = new Set<string>();
  for (const object of catalog.objects) {
    if (object.kind === "column" && object.definition.nullable) {
      nullable.add(`${refKey(object.identity.parent)}.${object.identity.name}`);
    }
  }
  const found: Found[] = [];
  for (const object of catalog.objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "foreignKey") continue;
    if (object.definition.columns.length < 2 || object.definition.references?.match === "full")
      continue;
    const parent = refKey(object.identity.parent);
    if (!object.definition.columns.some((name) => nullable.has(`${parent}.${name}`))) continue;
    found.push({
      rule,
      table: object.identity.parent.name,
      target: `${object.identity.parent.name}.${object.identity.name}`,
      reason:
        "A nullable column in a composite foreign key with MATCH SIMPLE skips the check when that column is null.",
    });
  }
  return found;
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
