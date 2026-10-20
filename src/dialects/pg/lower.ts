/**
 * Postgres DDL lowering.
 *
 * Table, column, and constraint changes return every physical statement
 * for that one logical change. Other families stay in the planner until
 * they move here. Output for a catalog pair stays the recorded plan.
 */

import { OkmError } from "../../contracts/error.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ConstraintObject,
} from "../../contracts/catalog/types.js";
import { ddlStep } from "../ddl-step.js";
import type { DdlStep, LogicalChange } from "../ddl.js";
import type { StepKind } from "../step-class.js";
import {
  alterColumnSql,
  createObjectSql,
  createTableSql,
  dropObjectSql,
  qualify,
  quoteIdent,
} from "./ddl.js";
import { notNullSteps } from "./table-safe.js";

const ACCESS = "ACCESS EXCLUSIVE";

/**
 * Lowers one logical change to Postgres statements.
 *
 * @param change - Logical change from the planner
 * @returns Physical steps in apply order
 */
export function lowerPostgres(change: LogicalChange): readonly DdlStep[] {
  switch (change.op) {
    case "pending":
      return [];
    case "rename-table":
      return [
        ddlStep(
          `alter table ${qualify(change.schema, change.from)} rename to ${quoteIdent(change.to)}`,
          "rename-table",
          "ddl",
          ACCESS,
        ),
      ];
    case "rename-column":
      return [
        ddlStep(
          `alter table ${qualify(change.schema, change.table)} rename column ${quoteIdent(change.from)} to ${quoteIdent(change.to)}`,
          "rename-column",
          "ddl",
          ACCESS,
        ),
      ];
    case "rename-constraint":
      return [
        ddlStep(
          `alter table ${qualify(change.schema, change.table)} rename constraint ${quoteIdent(change.from)} to ${quoteIdent(change.to)}`,
          "rename-constraint",
          "ddl",
          ACCESS,
        ),
      ];
    case "drop-table":
    case "drop-column":
    case "drop-constraint":
      return dropRelation(change.object, change.schema, dropKind(change.op));
    case "create-table":
      return [
        ddlStep(
          createTableSql(change.table, change.catalog, change.schema),
          "create-table",
          "ddl",
          ACCESS,
        ),
      ];
    case "add-column":
      return addColumn(change.column, change.schema, change.tableIsNew);
    case "add-constraint":
      return addConstraint(change.constraint, change.schema);
    case "alter-column":
      return alterColumn(change.before, change.after, change.schema, change.catalogs);
    default:
      return unmet(change);
  }
}

function unmet(change: never): never {
  throw new OkmError("invalid", `Postgres lowering has no variant for ${JSON.stringify(change)}.`, {
    fix: { summary: "Add the variant to the Postgres lowering." },
  });
}

function dropKind(op: "drop-table" | "drop-column" | "drop-constraint"): StepKind {
  if (op === "drop-table") return "drop-table";
  if (op === "drop-column") return "drop-column";
  return "drop-constraint";
}

function dropRelation(object: CatalogObject, schema: string, kind: StepKind): readonly DdlStep[] {
  const sql = dropObjectSql(object, schema);
  if (sql === undefined) return [];
  return [ddlStep(sql, kind, "ddl", ACCESS)];
}

function addColumn(column: ColumnObject, schema: string, tableIsNew: boolean): readonly DdlStep[] {
  const sql = createObjectSql(column, schema);
  if (sql === undefined) return [];
  const kind = requiredColumn(column) && !tableIsNew ? "add-column-required" : "add-column";
  return [ddlStep(sql, kind, "ddl", ACCESS)];
}

function addConstraint(constraint: ConstraintObject, schema: string): readonly DdlStep[] {
  const sql = createObjectSql(constraint, schema);
  if (sql === undefined) return [];
  return [ddlStep(sql, "add-constraint", "ddl", ACCESS)];
}

function requiredColumn(column: ColumnObject): boolean {
  const definition = column.definition;
  return (
    !definition.nullable &&
    definition.defaultExpression === undefined &&
    definition.identity === undefined &&
    definition.generated === undefined
  );
}

function alterColumn(
  before: ColumnObject,
  after: ColumnObject,
  schema: string,
  catalogs: readonly Catalog[],
): readonly DdlStep[] {
  const steps: DdlStep[] = [];
  const statements = alterColumnSql(before, after, schema);
  const kinds = columnAlterKinds(before, after);
  for (let index = 0; index < statements.length; index += 1) {
    const sql = statements[index];
    const kind = kinds[index];
    if (sql === undefined || kind === undefined) continue;
    if (kind === "set-not-null") {
      for (const item of notNullSteps(after, schema, "set-not-null", catalogs)) {
        steps.push({
          ...ddlStep(item.sql, item.kind, item.action, item.lock, item.transactional),
          safeRewrite: true,
        });
      }
      continue;
    }
    steps.push(ddlStep(sql, kind, "ddl", ACCESS));
  }
  const identitySql = identityChangeSql(before, after, schema);
  const identity = identityKind(before, after);
  if (identitySql !== undefined && identity !== undefined) {
    steps.push(ddlStep(identitySql, identity, "ddl", ACCESS));
  }
  return steps;
}

function columnAlterKinds(before: ColumnObject, after: ColumnObject): readonly StepKind[] {
  const kinds: StepKind[] = [];
  if (
    before.definition.dataType !== after.definition.dataType ||
    before.definition.collation !== after.definition.collation
  ) {
    kinds.push("set-column-type");
  }
  if (before.definition.nullable !== after.definition.nullable) {
    kinds.push(after.definition.nullable ? "drop-not-null" : "set-not-null");
  }
  if (before.definition.defaultExpression !== after.definition.defaultExpression) {
    kinds.push(after.definition.defaultExpression === undefined ? "drop-default" : "set-default");
  }
  return kinds;
}

function identityKind(before: ColumnObject, after: ColumnObject): StepKind | undefined {
  if (canonical(before.definition.identity) === canonical(after.definition.identity))
    return undefined;
  const next = after.definition.identity;
  const previous = before.definition.identity;
  if (next === undefined) return "drop-identity";
  if (previous === undefined) return "add-identity";
  return next.always ? "set-identity-always" : "set-identity-by-default";
}

function identityChangeSql(
  before: ColumnObject,
  after: ColumnObject,
  schema: string,
): string | undefined {
  if (canonical(before.definition.identity) === canonical(after.definition.identity))
    return undefined;
  const table = qualify(schema, after.identity.parent.name);
  const name = quoteIdent(after.identity.name);
  const next = after.definition.identity;
  const previous = before.definition.identity;
  if (next === undefined) return `alter table ${table} alter column ${name} drop identity`;
  if (previous === undefined) {
    const generated = next.always ? "always" : "by default";
    return `alter table ${table} alter column ${name} add generated ${generated} as identity`;
  }
  return `alter table ${table} alter column ${name} set generated ${next.always ? "always" : "by default"}`;
}

function canonical(value: unknown): string {
  return JSON.stringify(order(value));
}

function order(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => order(item));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) next[key] = order(record[key]);
    return next;
  }
  return value;
}
