/**
 * Postgres DDL lowering.
 *
 * Table, column, constraint, index, type, extension, routine, view, policy,
 * and privilege changes return every physical statement for that one logical
 * change. Other families stay in the planner until they move here. Output for
 * a catalog pair stays the recorded plan.
 */

import { isDomain } from "../../contracts/catalog/enum.js";
import { fitIdentifier } from "../../contracts/catalog/identifier.js";
import { OkmError } from "../../contracts/error.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ConstraintObject,
  ExtensionObject,
  FunctionObject,
  IndexObject,
  MaterializedViewObject,
  PolicyObject,
  TriggerObject,
  TypeObject,
  ViewObject,
} from "../../contracts/catalog/types.js";
import { ddlStep } from "../ddl-step.js";
import type { DdlStep, LogicalChange } from "../ddl.js";
import { classOf, type StepKind } from "../step-class.js";
import {
  alterColumnSql,
  createObjectSql,
  createTableSql,
  dropObjectSql,
  functionSql,
  policyCreatePlan,
  policyDropPlan,
  qualify,
  quoteIdent,
  refreshMaterializedViewSql,
  viewSql,
} from "./ddl.js";
import { privilegeSql } from "./role/sql.js";
import { quoteLiteral } from "./quote.js";
import { notNullSteps } from "./table-safe.js";

const ACCESS = "ACCESS EXCLUSIVE";
const SHARE = "SHARE";
const SHARE_UPDATE = "SHARE UPDATE EXCLUSIVE";

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
    case "rename-index":
      return [
        ddlStep(
          `alter index ${qualify(change.schema, change.from)} rename to ${quoteIdent(change.to)}`,
          "rename-index",
          "ddl",
          SHARE_UPDATE,
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
    case "create-index":
      return createIndex(change.index, change.schema, change.onExistingTable);
    case "drop-index":
      return dropIndex(change.index, change.schema, change.onExistingTable);
    case "create-type":
      return createType(change.object, change.schema);
    case "drop-type":
      return dropType(change.object, change.schema);
    case "add-enum-values":
      return addEnumValues(change.schema, change.name, change.before, change.after);
    case "replace-enum":
      return replaceEnum(change.schema, change.name, change.labels, change.columns);
    case "alter-domain-check":
      return alterDomainCheck(change.schema, change.name, change.expression);
    case "create-extension":
      return createExtension(change.object, change.schema);
    case "drop-extension":
      return dropExtension(change.object, change.schema);
    case "move-extension":
      return moveExtension(change.name, change.schema);
    case "update-extension":
      return updateExtension(change.name, change.version);
    case "create-function":
      return createRoutine(change.object, change.schema, "create-function");
    case "drop-function":
      return dropRoutine(change.object, change.schema, "drop-function");
    case "replace-function":
      return replaceRoutine(functionSql(change.object, change.schema, true), "replace-function");
    case "create-trigger":
      return createRoutine(change.object, change.schema, "create-trigger");
    case "drop-trigger":
      return dropRoutine(change.object, change.schema, "drop-trigger");
    case "create-view":
      return createRoutine(change.object, change.schema, "create-view");
    case "drop-view":
      return dropRoutine(change.object, change.schema, "drop-view");
    case "replace-view":
      return replaceRoutine(viewSql(change.object, change.schema, true), "replace-view");
    case "create-matview":
      return createRoutine(change.object, change.schema, "create-matview");
    case "drop-matview":
      return dropRoutine(change.object, change.schema, "drop-matview");
    case "refresh-matview":
      return [
        ddlStep(
          refreshMaterializedViewSql(change.object, change.schema, false),
          "refresh-matview",
          "backfill",
          ACCESS,
        ),
      ];
    case "create-policy":
      return policySteps(policyCreatePlan(change.object, change.schema), change.object);
    case "drop-policy":
      return policySteps(policyDropPlan(change.object, change.schema), change.object);
    case "privileges":
      return privilegeSteps(
        change.phase,
        change.before,
        change.after,
        change.schema,
        change.recreated,
      );
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

function createIndex(
  index: IndexObject,
  schema: string,
  onExistingTable: boolean,
): readonly DdlStep[] {
  const sql = createObjectSql(index, schema);
  if (sql === undefined) return [];
  if (!onExistingTable) return [ddlStep(sql, "create-index", "ddl", SHARE)];
  return [
    {
      ...ddlStep(concurrentIndexSql(sql), "create-index", "ddl", SHARE_UPDATE, false),
      safeRewrite: true,
    },
  ];
}

function dropIndex(
  index: IndexObject,
  schema: string,
  onExistingTable: boolean,
): readonly DdlStep[] {
  const sql = dropObjectSql(index, schema);
  if (sql === undefined) return [];
  if (!onExistingTable) return [ddlStep(sql, "drop-index", "ddl", ACCESS)];
  return [
    {
      ...ddlStep(concurrentDropIndexSql(sql), "drop-index", "ddl", SHARE_UPDATE, false, [
        index.identity.parent.name,
      ]),
      safeRewrite: true,
    },
  ];
}

function concurrentIndexSql(sql: string): string {
  const unique = "create unique index ";
  const plain = "create index ";
  if (sql.startsWith(unique)) return `create unique index concurrently ${sql.slice(unique.length)}`;
  if (sql.startsWith(plain)) return `create index concurrently ${sql.slice(plain.length)}`;
  return sql;
}

function concurrentDropIndexSql(sql: string): string {
  const prefix = "drop index ";
  if (!sql.startsWith(prefix)) return sql;
  return `drop index concurrently ${sql.slice(prefix.length)}`;
}

function createType(object: TypeObject, schema: string): readonly DdlStep[] {
  const sql = createObjectSql(object, schema);
  if (sql === undefined) return [];
  const kind = isDomain(object.definition) ? "create-domain" : "create-enum";
  return [ddlStep(sql, kind, "ddl", ACCESS)];
}

function dropType(object: TypeObject, schema: string): readonly DdlStep[] {
  const sql = dropObjectSql(object, schema);
  if (sql === undefined) return [];
  const kind = isDomain(object.definition) ? "drop-domain" : "drop-enum";
  return [ddlStep(sql, kind, "ddl", ACCESS)];
}

function addEnumValues(
  schema: string,
  name: string,
  before: readonly string[],
  after: readonly string[],
): readonly DdlStep[] {
  return addValueStatements(schema, name, before, after).map((sql) =>
    ddlStep(sql, "add-enum-value", "ddl", ACCESS, false),
  );
}

function addValueStatements(
  schema: string,
  name: string,
  before: readonly string[],
  after: readonly string[],
): string[] {
  const present = new Set(before);
  const statements: string[] = [];
  const type = qualify(schema, name);
  for (let index = 0; index < after.length; index += 1) {
    const label = after[index];
    if (label === undefined || present.has(label)) continue;
    let beforeNeighbor: string | undefined;
    for (let cursor = index + 1; cursor < after.length; cursor += 1) {
      const next = after[cursor];
      if (next !== undefined && present.has(next)) {
        beforeNeighbor = next;
        break;
      }
    }
    let sql = `alter type ${type} add value ${quoteLiteral(label)}`;
    if (beforeNeighbor !== undefined) {
      sql += ` before ${quoteLiteral(beforeNeighbor)}`;
    } else {
      let afterNeighbor: string | undefined;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const previous = after[cursor];
        if (previous !== undefined && present.has(previous)) {
          afterNeighbor = previous;
          break;
        }
      }
      if (afterNeighbor !== undefined) sql += ` after ${quoteLiteral(afterNeighbor)}`;
    }
    statements.push(sql);
    present.add(label);
  }
  return statements;
}

function replaceEnum(
  schema: string,
  name: string,
  labels: readonly string[],
  columns: readonly { readonly table: string; readonly column: string }[],
): readonly DdlStep[] {
  const type = qualify(schema, name);
  const old = quoteIdent(`${name}_old`);
  const listed = labels.map((label) => quoteLiteral(label)).join(", ");
  const steps: DdlStep[] = [
    ddlStep(`alter type ${type} rename to ${old}`, "rename-enum", "ddl", ACCESS),
    ddlStep(`create type ${type} as enum (${listed})`, "recreate-enum", "ddl", ACCESS),
  ];
  for (const column of columns) {
    const table = qualify(schema, column.table);
    const columnName = quoteIdent(column.column);
    steps.push(
      ddlStep(
        `alter table ${table} alter column ${columnName} type ${type} using ${columnName}::text::${type}`,
        "set-enum-column",
        "ddl",
        ACCESS,
      ),
    );
  }
  steps.push(ddlStep(`drop type ${qualify(schema, `${name}_old`)}`, "drop-enum", "ddl", ACCESS));
  return steps;
}

function alterDomainCheck(schema: string, name: string, expression: string): readonly DdlStep[] {
  const type = qualify(schema, name);
  const current = quoteIdent(fitIdentifier(`${name}_check`));
  const upcoming = quoteIdent(fitIdentifier(`${name}_check_next`));
  return [
    ddlStep(
      `alter domain ${type} add constraint ${upcoming} check (${expression}) not valid`,
      "add-domain-check",
      "ddl",
      ACCESS,
    ),
    ddlStep(
      `alter domain ${type} validate constraint ${upcoming}`,
      "validate-domain-check",
      "ddl",
      ACCESS,
    ),
    ddlStep(`alter domain ${type} drop constraint ${current}`, "drop-domain-check", "ddl", ACCESS),
    ddlStep(
      `alter domain ${type} rename constraint ${upcoming} to ${current}`,
      "rename-domain-check",
      "ddl",
      ACCESS,
    ),
  ];
}

function createExtension(object: ExtensionObject, schema: string): readonly DdlStep[] {
  const sql = createObjectSql(object, schema);
  if (sql === undefined) return [];
  return [ddlStep(sql, "create-extension", "ddl", ACCESS)];
}

function dropExtension(object: ExtensionObject, schema: string): readonly DdlStep[] {
  const sql = dropObjectSql(object, schema);
  if (sql === undefined) return [];
  return [ddlStep(sql, "drop-extension", "ddl", ACCESS)];
}

function moveExtension(name: string, schema: string): readonly DdlStep[] {
  return [
    ddlStep(
      `alter extension ${quoteIdent(name)} set schema ${quoteIdent(schema)}`,
      "move-extension",
      "ddl",
      ACCESS,
    ),
  ];
}

function updateExtension(name: string, version: string): readonly DdlStep[] {
  return [
    {
      ...ddlStep(
        `alter extension ${quoteIdent(name)} update to ${quoteLiteral(version)}`,
        "update-extension",
        "ddl",
        ACCESS,
      ),
      path: "unverified",
    },
  ];
}

function createRoutine(
  object: FunctionObject | TriggerObject | ViewObject | MaterializedViewObject,
  schema: string,
  kind: StepKind,
): readonly DdlStep[] {
  const sql = createObjectSql(object, schema);
  if (sql === undefined) return [];
  return [ddlStep(sql, kind, "ddl", ACCESS)];
}

function dropRoutine(
  object: FunctionObject | TriggerObject | ViewObject | MaterializedViewObject,
  schema: string,
  kind: StepKind,
): readonly DdlStep[] {
  const sql = dropObjectSql(object, schema);
  if (sql === undefined) return [];
  return [ddlStep(sql, kind, "ddl", ACCESS)];
}

function replaceRoutine(
  sql: string,
  kind: "replace-function" | "replace-view",
): readonly DdlStep[] {
  return [
    {
      sql,
      kind,
      class: classOf(kind),
      action: "ddl",
      lock: ACCESS,
      transactional: true,
      behavior: "change",
    },
  ];
}

function policySteps(
  planned: readonly { readonly sql: string; readonly kind: StepKind }[],
  object: PolicyObject,
): readonly DdlStep[] {
  return planned.map((item) =>
    ddlStep(item.sql, item.kind, "ddl", ACCESS, true, [object.identity.parent.name]),
  );
}

function privilegeSteps(
  phase: "revoke" | "prepare" | "grant",
  before: readonly CatalogObject[],
  after: readonly CatalogObject[],
  schema: string,
  recreated: readonly string[],
): readonly DdlStep[] {
  const planned = privilegeSql(before, after, schema, new Set(recreated));
  const statements =
    phase === "revoke" ? planned.revoke : phase === "prepare" ? planned.prepare : planned.grant;
  return statements.map((item) => ddlStep(item.sql, item.kind, "ddl", ACCESS));
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
