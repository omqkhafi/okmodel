/**
 * Resolver and emitters of a `morph` relation.
 *
 * The relation object carries both. `schema()` calls the resolver, and the
 * planner calls the emitter with its own helpers, so a schema that never
 * calls `morph` or `morphMany` does not ship this module. A target in another
 * tenant or archived never shows: the include planner applies those predicates
 * to each target, the same way it does for any relation.
 */

import { OkmError, catalogError, throwNamed } from "../../contracts/error.js";
import type { MorphModel, RelationModel, ThroughEmit } from "./model.js";
import type { RelationDescribed, RelationScope } from "./relations.js";

/** One column `schema()` can check against a morph id. */
type MorphColumn = {
  readonly field: string;
  readonly sqlName: string;
  readonly dataType: string;
  readonly nullable: boolean;
};

const refuseTo: ThroughEmit = (planner, schema, relation, child, sink, parent, alias, depth) => {
  void planner;
  void schema;
  void child;
  void sink;
  void parent;
  void alias;
  void depth;
  const morph = relation.morph;
  const typeField = morph?.typeField ?? "type";
  const idField = morph?.idField ?? "id";
  throw new OkmError(
    "OKM1120",
    `Relation ${relation.name} is a morph. Filter ${typeField} and ${idField}, or include it. has, none, and every are not available on it.`,
  );
};

/**
 * Resolves `morph(name, targets)` on the table that holds the type and id columns.
 *
 * @param scope - What `schema()` knows
 * @param name - Column stem: `${name}Type` and `${name}Id`
 * @param targets - Closed list of target table names
 * @returns The resolved to-one relation
 */
export function resolveMorph(
  scope: RelationScope,
  name: string,
  targets: readonly string[],
): RelationModel {
  const label = `${scope.owner}.${scope.name}`;
  const owner = described(scope, scope.owner, label);
  const typeField = `${name}Type`;
  const idField = `${name}Id`;
  const typeColumn = requireColumn(owner, typeField, label);
  const idColumn = requireColumn(owner, idField, label);
  if (typeColumn.nullable !== idColumn.nullable) {
    catalogError(
      "OKM1021",
      `Relation ${label} columns ${owner.tsName}.${typeColumn.field} and ${owner.tsName}.${idColumn.field} must both be nullable, or neither.`,
    );
  }
  if (!isTextType(typeColumn.dataType)) {
    catalogError(
      "OKM1022",
      `Relation ${label} type column ${owner.tsName}.${typeColumn.field} is ${typeColumn.dataType}. Accepted type: text.`,
    );
  }
  const seen = new Set<string>();
  const resolved: MorphModel["targets"][number][] = [];
  for (const targetName of targets) {
    if (seen.has(targetName)) {
      catalogError("OKM1023", `Relation ${label} lists ${targetName} twice.`);
    }
    seen.add(targetName);
    if (!scope.tables.includes(targetName)) {
      throwNamed(
        "OKM1020",
        targetName,
        scope.tables,
        `Relation ${label} names ${targetName}, which is not in the schema. Accepted names: ${scope.tables.join(", ")}.`,
      );
    }
    const target = described(scope, targetName, label);
    const key = requireKey(target, label, scope.scopeFields);
    if (idColumn.dataType !== key.dataType) {
      catalogError(
        "OKM1022",
        `Relation ${label} id column ${owner.tsName}.${idColumn.field} is ${idColumn.dataType} and ${target.tsName}.${key.field} is ${key.dataType}. Accepted type: ${key.dataType}.`,
      );
    }
    const limit = textLimit(typeColumn.dataType);
    if (limit !== undefined && targetName.length > limit) {
      catalogError(
        "OKM1022",
        `Relation ${label} type column ${owner.tsName}.${typeColumn.field} is ${typeColumn.dataType} and ${target.tsName} does not fit. Accepted type: text.`,
      );
    }
    resolved.push({
      type: target.tsName,
      table: target.tsName,
      sql: target.sqlName,
      keySql: key.sql,
    });
  }
  const first = resolved[0];
  if (first === undefined) {
    catalogError("OKM1020", `Relation ${label} needs a target table.`);
  }
  const morph: MorphModel = {
    direction: "to",
    name,
    typeField,
    idField,
    typeSql: typeColumn.sqlName,
    idSql: idColumn.sqlName,
    targets: resolved,
  };
  return {
    name: scope.name,
    kind: "one",
    table: first.table,
    local: [idColumn.sqlName],
    remote: [first.keySql],
    morph,
    through: {
      table: first.table,
      local: [idColumn.sqlName],
      remote: [first.keySql],
      emit: refuseTo,
    },
  };
}

/**
 * Resolves `morphMany(table, name)` on a target table.
 *
 * The many reads the owner table's type and id columns. The owner must declare
 * `morph(name, targets)` and list this table.
 *
 * @param scope - What `schema()` knows. `owner` is the target table
 * @param table - Table that holds the type and id columns
 * @param name - Column stem declared on that table
 * @returns The resolved to-many relation
 */
export function resolveMorphMany(scope: RelationScope, table: string, name: string): RelationModel {
  const label = `${scope.owner}.${scope.name}`;
  if (!scope.tables.includes(table)) {
    throwNamed(
      "OKM1020",
      table,
      scope.tables,
      `Relation ${label} names ${table}, which is not in the schema. Accepted names: ${scope.tables.join(", ")}.`,
    );
  }
  const owner = described(scope, table, label);
  const here = described(scope, scope.owner, label);
  const targets = declaredTargets(owner.relationOptions, name);
  if (targets === undefined) {
    catalogError(
      "OKM1021",
      `Relation ${label} needs morph("${name}", [...]) on ${owner.tsName}. ${owner.tsName} has no morph named ${name}.`,
    );
  }
  if (!targets.includes(scope.owner)) {
    catalogError(
      "OKM1020",
      `Relation ${label} is not a target of ${owner.tsName}.${name}. Accepted tables: ${targets.join(", ")}.`,
    );
  }
  const typeField = `${name}Type`;
  const idField = `${name}Id`;
  const typeColumn = requireColumn(owner, typeField, label);
  const idColumn = requireColumn(owner, idField, label);
  const key = requireKey(here, label, scope.scopeFields);
  if (idColumn.dataType !== key.dataType) {
    catalogError(
      "OKM1022",
      `Relation ${label} id column ${owner.tsName}.${idColumn.field} is ${idColumn.dataType} and ${here.tsName}.${key.field} is ${key.dataType}. Accepted type: ${key.dataType}.`,
    );
  }
  const morph: MorphModel = {
    direction: "many",
    name,
    typeField,
    idField,
    typeSql: typeColumn.sqlName,
    idSql: idColumn.sqlName,
    typeValue: here.tsName,
    targets: [
      {
        type: here.tsName,
        table: here.tsName,
        sql: here.sqlName,
        keySql: key.sql,
      },
    ],
  };
  return {
    name: scope.name,
    kind: "many",
    table: owner.tsName,
    local: [key.sql],
    remote: [idColumn.sqlName],
    morph,
    through: {
      table: owner.tsName,
      local: [idColumn.sqlName],
      remote: [key.sql],
      emit: morphManyEmit(here.tsName),
    },
  };
}

/**
 * Writes `owner alias where type = this table and id = parent key`.
 *
 * The caller adds tenancy, the active set, and the include filter.
 *
 * @param typeValue - Table name stored in the type column
 * @returns The emitter stored on the relation
 */
function morphManyEmit(typeValue: string): ThroughEmit {
  return (planner, schema, relation, child, sink, parent, alias) => {
    void schema;
    const pair = relation.morph;
    const local = relation.local[0];
    if (pair === undefined || local === undefined) {
      throw new OkmError("OKM1120", `Relation ${relation.name} is not a morph many.`);
    }
    const { quote } = planner;
    sink.text(quote(child.model.sql));
    sink.text(" ");
    sink.text(alias);
    sink.text(" where ");
    sink.text(alias);
    sink.text(".");
    sink.text(quote(pair.typeSql));
    sink.text(" = ");
    sink.param(typeValue);
    sink.text("::text");
    sink.text(" and ");
    sink.text(alias);
    sink.text(".");
    sink.text(quote(pair.idSql));
    sink.text(" = ");
    sink.text(parent);
    sink.text(".");
    sink.text(quote(local));
  };
}

function described(scope: RelationScope, table: string, label: string): RelationDescribed {
  const found = scope.describe?.(table);
  if (!isDescribed(found)) {
    catalogError("OKM1020", `Relation ${label} names ${table}, which is not in the schema.`);
  }
  return found;
}

function isDescribed(value: unknown): value is RelationDescribed {
  if (typeof value !== "object" || value === null) return false;
  if (!("tsName" in value) || typeof value.tsName !== "string") return false;
  if (!("sqlName" in value) || typeof value.sqlName !== "string") return false;
  if (!("primary" in value) || !Array.isArray(value.primary)) return false;
  if (!("byField" in value) || !(value.byField instanceof Map)) return false;
  if (!("bySql" in value) || !(value.bySql instanceof Map)) return false;
  return "relationOptions" in value;
}

function requireColumn(table: RelationDescribed, field: string, label: string): MorphColumn {
  const column = table.byField.get(field);
  if (column === undefined) {
    catalogError("OKM1021", `Relation ${label} needs column ${field} on ${table.tsName}.`);
  }
  return column;
}

function requireKey(
  table: RelationDescribed,
  label: string,
  scopeFields: readonly string[] | undefined,
): { readonly field: string; readonly sql: string; readonly dataType: string } {
  const skip = scopeFields ?? [];
  const keys: { readonly field: string; readonly sql: string; readonly dataType: string }[] = [];
  for (const sql of table.primary) {
    const column = table.bySql.get(sql);
    if (column === undefined || skip.includes(column.field)) continue;
    keys.push({ field: column.field, sql, dataType: column.dataType });
  }
  const only = keys.length === 1 ? keys[0] : undefined;
  if (only !== undefined) return only;
  const names = keys.map((key) => key.field);
  catalogError(
    "OKM1021",
    `Relation ${label} cannot use ${table.tsName} as a target. Its primary key is ${names.length === 0 ? "(none)" : names.join(", ")}. A morph id matches one column.`,
  );
}

function declaredTargets(options: unknown, name: string): readonly string[] | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  for (const value of Object.values(options as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || !("morph" in value)) continue;
    const morph = (
      value as { readonly morph?: { readonly name?: unknown; readonly targets?: unknown } }
    ).morph;
    if (morph === undefined || morph.name !== name || !Array.isArray(morph.targets)) continue;
    const names: string[] = [];
    for (const target of morph.targets) {
      if (typeof target === "string") names.push(target);
    }
    return names;
  }
  return undefined;
}

function isTextType(dataType: string): boolean {
  return (
    dataType === "text" ||
    dataType === "citext" ||
    dataType.startsWith("varchar(") ||
    dataType.startsWith("character varying(") ||
    dataType.startsWith("char(") ||
    dataType.startsWith("character(")
  );
}

function textLimit(dataType: string): number | undefined {
  const match = /^(?:varchar|character varying|char|character)\((\d+)\)$/.exec(dataType);
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]);
}
