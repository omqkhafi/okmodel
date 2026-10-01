/**
 * Applies presets, traits, tenancy, archive visibility, and field rules.
 *
 * Contributions are additive. A preset is a list of predicates, not a function
 * that receives the query, so it cannot delete a rule that was already added.
 * Tenancy and archive predicates are attached at the root AND after user filters.
 */

import { SafetyError, violation } from "./errors.js";
import { defineFilters } from "./filters.js";
import { assertKnownField } from "./identifier.js";
import {
  type Catalog,
  type Contribution,
  type DraftPredicate,
  type Escape,
  type LogicalQuery,
  type Predicate,
  type Provenance,
  type QueryDraft,
  type TableMeta,
  type ValueBinding,
  andExpr,
  archiveField,
  predExpr,
  tableByName,
  tenantField,
  usableReason,
} from "./model.js";

/**
 * Builds a logical query from a draft and the catalog.
 *
 * @param draft - Caller input
 * @param catalog - Trusted catalog
 * @returns The query, before verification
 */
export function compose(draft: QueryDraft, catalog: Catalog): LogicalQuery {
  const primary = requireTable(catalog, draft.table);
  const parsed = draft.filters
    ? defineFilters(catalog, primary.name, {
        allow: draft.filters.allow,
        ...(draft.filters.sort !== undefined ? { sort: draft.filters.sort } : {}),
        ...(draft.filters.relations !== undefined ? { relations: draft.filters.relations } : {}),
      }).parse(draft.filters.payload)
    : undefined;
  const touched = unique([primary.name, ...(draft.touched ?? []), ...(parsed?.touched ?? [])]);
  for (const name of touched) {
    requireTable(catalog, name);
  }

  const escapes = stampEscapes(draft.escapes ?? []);
  const unscoped = escapes.some(
    (escape) => escape.hatch === "unscoped" && usableReason(escape.reason),
  );
  const trusted = escapes.some(
    (escape) => escape.hatch === "trusted" && usableReason(escape.reason),
  );

  const userPredicates: Predicate[] = [];
  for (const predicate of draft.caller ?? []) {
    userPredicates.push(
      stampPredicate(primary, predicate, provenance("caller", "where", "caller.ts:1")),
    );
  }
  const presetNames = draft.presets ?? [];
  if (new Set(presetNames).size !== presetNames.length) {
    throw new SafetyError([
      violation("OKM1120", "preset", primary.name, "A preset is listed twice.", "preset"),
    ]);
  }
  for (const name of presetNames) {
    const preset = primary.presets.find((entry) => entry.name === name);
    if (preset === undefined) {
      throw new SafetyError([
        violation("OKM1120", "preset", primary.name, `Unknown preset ${name}.`, "preset"),
      ]);
    }
    for (const predicate of preset.predicates) {
      userPredicates.push(
        stampPredicate(primary, predicate, provenance("preset", preset.name, preset.location)),
      );
    }
  }
  for (const predicate of parsed?.predicates ?? []) {
    const table = requireTable(catalog, predicate.table);
    userPredicates.push(
      stampPredicate(table, predicate, provenance("filter", predicate.column, "filters.ts:parse")),
    );
  }

  const safety: Predicate[] = [];
  if (!trusted) {
    for (const name of touched) {
      const table = requireTable(catalog, name);
      const tenant = draft.op === "insert" ? undefined : tenantPredicate(table, unscoped);
      if (tenant !== undefined) {
        safety.push(tenant);
      }
      const archive = archivePredicate(table, draft.op, draft.archive ?? "active");
      if (archive !== undefined) {
        safety.push(archive);
      }
    }
  }

  const values = bindings(primary, draft, unscoped);
  const select = draft.select === undefined || draft.select === "default" ? "default" : "explicit";
  const projection =
    select === "default"
      ? primary.fields.filter((field) => !field.hidden).map((field) => field.name)
      : explicitProjection(primary, draft.select);
  const redacted = touched.flatMap((name) => {
    const table = requireTable(catalog, name);
    return table.fields.filter((field) => field.sensitive).map((field) => field.name);
  });

  const contributions = contributionsFor(catalog, touched, [...safety, ...userPredicates], values);
  const ids = contributions.map((contribution) => contribution.id);

  return {
    op: draft.op,
    tables: touched,
    where: andExpr([...safety, ...userPredicates].map(predExpr)),
    userWhere: andExpr(userPredicates.map(predExpr)),
    select,
    projection,
    input: draft.input ?? [],
    values,
    limit: draft.limit,
    archive: draft.archive ?? "active",
    escapes,
    contributions,
    requested: ids,
    redacted: unique(redacted),
  };
}

function tenantPredicate(table: TableMeta, unscoped: boolean): Predicate | undefined {
  if (table.tenancy !== "column" || unscoped) {
    return undefined;
  }
  const field = tenantField(table);
  if (field === undefined) {
    return undefined;
  }
  return {
    table: table.name,
    column: field.name,
    op: "eq",
    parameter: "$tenant",
    provenance: provenance("tenancy", "schema.tenancy", "schema.ts:tenancy"),
  };
}

function archivePredicate(
  table: TableMeta,
  op: QueryDraft["op"],
  mode: NonNullable<QueryDraft["archive"]>,
): Predicate | undefined {
  if (op === "insert" || !table.traits.includes("archivable") || mode === "withArchived") {
    return undefined;
  }
  const field = archiveField(table);
  if (field === undefined) {
    return undefined;
  }
  return {
    table: table.name,
    column: field.name,
    op: mode === "onlyArchived" ? "isNotNull" : "isNull",
    parameter: undefined,
    provenance: provenance("archive", "archivable", "traits.ts:archivable"),
  };
}

function bindings(table: TableMeta, draft: QueryDraft, unscoped: boolean): readonly ValueBinding[] {
  if (draft.op !== "insert" && draft.op !== "update") {
    return [];
  }
  const values: ValueBinding[] = [];
  for (const column of draft.input ?? []) {
    assertKnownField(
      table.fields.map((field) => field.name),
      column,
      "where",
    );
    values.push({
      table: table.name,
      column,
      parameter: `$input_${column}`,
      provenance: provenance("caller", column, "caller.ts:input"),
    });
  }
  if (draft.op === "insert" && table.tenancy === "column" && !unscoped) {
    const field = tenantField(table);
    if (field !== undefined) {
      values.push({
        table: table.name,
        column: field.name,
        parameter: "$tenant",
        provenance: provenance("tenancy", "schema.tenancy", "schema.ts:tenancy"),
      });
    }
  }
  return values;
}

function explicitProjection(table: TableMeta, select: QueryDraft["select"]): readonly string[] {
  if (select === undefined || select === "default") {
    return [];
  }
  for (const name of select) {
    assertKnownField(
      table.fields.map((field) => field.name),
      name,
      "select",
    );
  }
  return [...select];
}

function contributionsFor(
  catalog: Catalog,
  touched: readonly string[],
  predicates: readonly Predicate[],
  values: readonly ValueBinding[],
): readonly Contribution[] {
  const contributions: Contribution[] = [];
  const seen = new Map<string, number>();
  const push = (base: string, provenance: Provenance, effect: Contribution["effect"]): void => {
    contributions.push({ id: uniqueId(base, seen), provenance, effect });
  };
  for (const predicate of predicates) {
    push(predicateId(predicate), predicate.provenance, { kind: "predicate", predicate });
  }
  for (const value of values) {
    if (value.provenance.kind !== "tenancy") {
      continue;
    }
    push(`value:${value.table}:${value.column}:${value.parameter}`, value.provenance, {
      kind: "value",
      table: value.table,
      column: value.column,
      parameter: value.parameter,
    });
  }
  for (const name of touched) {
    const table = requireTable(catalog, name);
    for (const field of table.fields) {
      if (field.hidden) {
        const source = provenance("hidden", field.name, "table.ts:hidden");
        push(`hide:${table.name}:${field.name}`, source, {
          kind: "hide",
          table: table.name,
          column: field.name,
        });
      }
      if (field.sensitive) {
        const source = provenance("sensitive", field.name, "table.ts:sensitive");
        push(`redact:${table.name}:${field.name}`, source, {
          kind: "redact",
          table: table.name,
          column: field.name,
        });
      }
      if (field.guarded) {
        const source = provenance("guard", field.name, "table.ts:guard");
        push(`guard:${table.name}:${field.name}`, source, {
          kind: "guard",
          table: table.name,
          column: field.name,
        });
      }
    }
  }
  contributions.sort((left, right) => left.id.localeCompare(right.id));
  return contributions;
}

function stampPredicate(
  table: TableMeta,
  predicate: DraftPredicate,
  source: Provenance,
): Predicate {
  assertKnownField(
    table.fields.map((field) => field.name),
    predicate.column,
    "where",
  );
  return {
    table: table.name,
    column: predicate.column,
    op: predicate.op,
    parameter: predicate.parameter,
    provenance: source,
  };
}

function stampEscapes(
  escapes: readonly NonNullable<QueryDraft["escapes"]>[number][],
): readonly Escape[] {
  return escapes.map((escape) => {
    const source = provenance("escape", escape.hatch, "caller.ts:escape");
    if (escape.hatch === "allow") {
      return { hatch: "allow", fields: escape.fields, provenance: source };
    }
    return { hatch: escape.hatch, reason: escape.reason, provenance: source };
  });
}

function provenance(kind: Provenance["kind"], name: string, location: string): Provenance {
  return { kind, name, location };
}

function predicateId(predicate: Predicate): string {
  return [
    "pred",
    predicate.table,
    predicate.column,
    predicate.op,
    predicate.parameter ?? "",
    predicate.provenance.kind,
    predicate.provenance.name,
  ].join(":");
}

function uniqueId(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}#${String(count)}`;
}

function requireTable(catalog: Catalog, name: string): TableMeta {
  const table = tableByName(catalog, name);
  if (table === undefined) {
    throw new SafetyError([
      violation("OKM1120", "unknown-field", "", `Unknown table ${name}.`, "missing"),
    ]);
  }
  return table;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
