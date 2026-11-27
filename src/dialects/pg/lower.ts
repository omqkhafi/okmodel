/**
 * Postgres DDL lowering.
 *
 * Table, column, constraint, index, type, extension, routine, view, policy,
 * privilege, sequence, check, and row-rewrite changes return every physical
 * statement for that one logical change. Output for a catalog pair stays the
 * recorded plan.
 */

import { isComposite } from "../../contracts/catalog/composite.js";
import { isDomain } from "../../contracts/catalog/enum.js";
import { isRange } from "../../contracts/catalog/range.js";
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
  SequenceObject,
  TableObject,
  MaterializedViewObject,
  PolicyObject,
  TriggerObject,
  TypeObject,
  ViewObject,
} from "../../contracts/catalog/types.js";
import { sealLowered, type DdlStep, type LogicalChange, type LoweredStep } from "../ddl.js";
import { ddlStep } from "../ddl-step.js";
import { classOf, type StepKind } from "../step-class.js";
import {
  alterColumnSql,
  createObjectSql,
  createTableSql,
  dropObjectSql,
  definerRevokeSql,
  functionSql,
  policyAlterPlan,
  policyCreatePlan,
  policyDropPlan,
  qualify,
  quoteIdent,
  refreshMaterializedViewSql,
  validatesNotNull,
  viewSql,
} from "./ddl.js";
import { privilegeSql } from "./role/sql.js";
import { quoteLiteral } from "./quote.js";
import { notNullSteps } from "./table-safe.js";

const ACCESS = "ACCESS EXCLUSIVE";
const SHARE = "SHARE";
const SHARE_UPDATE = "SHARE UPDATE EXCLUSIVE";
const ROW = "ROW EXCLUSIVE";

/**
 * Lowers one logical change to Postgres statements.
 *
 * Every returned step has non-empty SQL, a kind, and the class of that kind.
 *
 * @param change - Logical change from the planner
 * @returns Physical steps in apply order
 * @throws OkmError OKM1559 when a step breaks that contract
 */
export function lowerPostgres(change: LogicalChange): readonly LoweredStep[] {
  try {
    return sealLowered(lowerChange(change));
  } catch (error) {
    if (error instanceof OkmError) throw error;
    if (error instanceof TypeError) {
      throw new OkmError("OKM1559", "Postgres lowering was given a change it cannot read.", {
        cause: error,
        fix: { summary: "Pass a complete logical change to the Postgres lowering." },
      });
    }
    throw error;
  }
}

function lowerChange(change: LogicalChange): readonly DdlStep[] {
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
    case "comment":
      return commentChange(change.object, change.schema, change.text);
    case "create-table":
      return [
        ddlStep(
          createTableSql(change.table, change.catalog, change.schema),
          "create-table",
          "ddl",
          ACCESS,
        ),
        ...foldedComments(change.table, change.catalog, change.schema),
      ];
    case "add-column":
      return withObjectComment(
        addColumn(change.column, change.schema, change.tableIsNew),
        change.column,
        change.schema,
      );
    case "add-constraint":
      return withObjectComment(
        addConstraint(change.constraint, change.schema),
        change.constraint,
        change.schema,
      );
    case "create-index":
      return withObjectComment(
        createIndex(change.index, change.schema, change.onExistingTable),
        change.index,
        change.schema,
      );
    case "drop-index":
      return dropIndex(change.index, change.schema, change.onExistingTable);
    case "create-type":
      return withObjectComment(
        createType(change.object, change.schema),
        change.object,
        change.schema,
      );
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
      return withDefinerRevoke(
        withObjectComment(
          createRoutine(change.object, change.schema, "create-function"),
          change.object,
          change.schema,
        ),
        change.object,
        change.schema,
      );
    case "drop-function":
      return dropRoutine(change.object, change.schema, "drop-function");
    case "replace-function":
      return withDefinerRevoke(
        withObjectComment(
          replaceRoutine(functionSql(change.object, change.schema, true), "replace-function"),
          change.object,
          change.schema,
        ),
        change.object,
        change.schema,
      );
    case "create-trigger":
      return withObjectComment(
        createRoutine(change.object, change.schema, "create-trigger"),
        change.object,
        change.schema,
      );
    case "drop-trigger":
      return dropRoutine(change.object, change.schema, "drop-trigger");
    case "create-view":
      return withObjectComment(
        createRoutine(change.object, change.schema, "create-view"),
        change.object,
        change.schema,
      );
    case "drop-view":
      return dropRoutine(change.object, change.schema, "drop-view");
    case "replace-view":
      return withObjectComment(
        replaceRoutine(viewSql(change.object, change.schema, true), "replace-view"),
        change.object,
        change.schema,
      );
    case "rename-view-column":
      return [
        ddlStep(
          `alter view ${qualify(change.schema, change.object.identity.name)} rename column ${quoteIdent(change.from)} to ${quoteIdent(change.to)}`,
          "rename-view-column",
          "ddl",
          ACCESS,
        ),
      ];
    case "create-matview":
      return withObjectComment(
        createRoutine(change.object, change.schema, "create-matview"),
        change.object,
        change.schema,
      );
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
      return withObjectComment(
        policySteps(policyCreatePlan(change.object, change.schema), change.object),
        change.object,
        change.schema,
      );
    case "alter-policy":
      return withObjectComment(
        policySteps(policyAlterPlan(change.object, change.schema), change.object),
        change.object,
        change.schema,
      );
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
    case "create-sequence":
      return withObjectComment(
        createRoutine(change.object, change.schema, "create-sequence"),
        change.object,
        change.schema,
      );
    case "drop-sequence":
      return dropRoutine(change.object, change.schema, "drop-sequence");
    case "rename-sequence":
      return [
        ddlStep(
          `alter sequence ${qualify(change.schema, change.from)} rename to ${quoteIdent(change.to)}`,
          "rename-sequence",
          "ddl",
          ACCESS,
        ),
      ];
    case "swap-check":
      return swapCheck(change.schema, change.table, change.name, change.expression, change.kind);
    case "rewrite-values":
      return rewriteValues(change);
    case "alter-column":
      return alterColumn(change.before, change.after, change.schema, change.catalogs);
    case "add-attribute":
      return addAttribute(change);
    case "drop-attribute":
      return [
        ddlStep(
          `alter type ${qualify(change.schema, change.type)} drop attribute ${quoteIdent(change.name)}`,
          "drop-attribute",
          "ddl",
          ACCESS,
        ),
      ];
    case "rename-attribute":
      return [
        ddlStep(
          `alter type ${qualify(change.schema, change.type)} rename attribute ${quoteIdent(change.from)} to ${quoteIdent(change.to)}`,
          "rename-attribute",
          "ddl",
          ACCESS,
        ),
      ];
    case "alter-attribute":
      return [
        ddlStep(
          `alter type ${qualify(change.schema, change.type)} alter attribute ${quoteIdent(change.name)} type ${change.dataType}`,
          "alter-attribute",
          "ddl",
          ACCESS,
        ),
      ];
    case "swap-composite":
      return swapComposite(change);
    case "swap-range":
      return swapRange(change);
    case "rename-type":
      return change.from === change.multirangeFrom
        ? [
            ddlStep(
              `alter type ${qualify(change.schema, change.from)} rename to ${quoteIdent(change.to)}`,
              "rename-enum",
              "ddl",
              ACCESS,
            ),
          ]
        : [
            ddlStep(
              `alter type ${qualify(change.schema, change.from)} rename to ${quoteIdent(change.to)}`,
              "rename-enum",
              "ddl",
              ACCESS,
            ),
            ddlStep(
              `alter type ${qualify(change.schema, change.multirangeFrom)} rename to ${quoteIdent(change.multirangeTo)}`,
              "rename-enum",
              "ddl",
              ACCESS,
            ),
          ];
    case "fill-attribute":
      return [
        ddlStep(
          `update ${qualify(change.schema, change.table)} set ${quoteIdent(change.column)}.${quoteIdent(change.field)} = ${change.expression}`,
          "backfill-expand",
          "backfill",
          ROW,
        ),
      ];
    case "comment-attribute":
      return [
        ddlStep(
          `comment on column ${qualify(change.schema, change.type)}.${quoteIdent(change.field)} is ${change.text === null ? "null" : quoteLiteral(change.text)}`,
          "comment",
          "ddl",
          SHARE_UPDATE,
        ),
      ];
    default:
      return unmet(change);
  }
}

function withObjectComment(
  steps: readonly DdlStep[],
  object: CatalogObject,
  schema: string,
): readonly DdlStep[] {
  if (object.comment === undefined) return steps;
  return [...steps, ...commentChange(object, schema, object.comment)];
}

function withDefinerRevoke(
  steps: readonly DdlStep[],
  object: FunctionObject,
  schema: string,
): readonly DdlStep[] {
  const sql = definerRevokeSql(object, schema);
  if (sql === undefined) return steps;
  return [...steps, ddlStep(sql, "revoke", "ddl", ACCESS)];
}

function commentChange(
  object: CatalogObject,
  schema: string,
  text: string | null,
): readonly DdlStep[] {
  const target = commentTarget(object, schema);
  if (target === undefined) return [];
  const value = text === null ? "null" : quoteLiteral(text);
  return [ddlStep(`comment on ${target} is ${value}`, "comment", "ddl", SHARE_UPDATE)];
}

/**
 * Comments for objects created inside `CREATE TABLE`.
 *
 * Columns and identity sequences have no step of their own on a new table.
 *
 * @param table - Table just created
 * @param catalog - Catalog the plan is building
 * @param schema - Schema name
 * @returns Comment steps, in catalog order
 */
function foldedComments(table: TableObject, catalog: Catalog, schema: string): readonly DdlStep[] {
  const steps: DdlStep[] = [];
  if (table.comment !== undefined) steps.push(...commentChange(table, schema, table.comment));
  for (const object of catalog.objects) {
    if (object.comment === undefined) continue;
    if (object.kind === "column" && object.identity.parent.name === table.identity.name) {
      steps.push(...commentChange(object, schema, object.comment));
    }
    if (
      object.kind === "sequence" &&
      object.dependencies.some(
        (edge) => edge.target.kind === "table" && edge.target.name === table.identity.name,
      )
    ) {
      steps.push(...commentChange(object, schema, object.comment));
    }
  }
  return steps;
}

function commentTarget(object: CatalogObject, schema: string): string | undefined {
  switch (object.kind) {
    case "table":
      return `table ${qualify(schema, object.identity.name)}`;
    case "column":
      return `column ${qualify(schema, object.identity.parent.name)}.${quoteIdent(object.identity.name)}`;
    case "index":
      return `index ${qualify(schema, object.identity.name)}`;
    case "view":
      return `view ${qualify(schema, object.identity.name)}`;
    case "materializedView":
      return `materialized view ${qualify(schema, object.identity.name)}`;
    case "function":
      return `${object.definition.routine === "procedure" ? "procedure" : "function"} ${qualify(schema, object.identity.name)}(${object.identity.argTypes.join(", ")})`;
    case "trigger":
      return `trigger ${quoteIdent(object.identity.name)} on ${qualify(schema, object.identity.parent.name)}`;
    case "sequence":
      return `sequence ${qualify(schema, object.identity.name)}`;
    case "type":
      return `type ${qualify(schema, object.identity.name)}`;
    case "constraint":
      if (
        object.definition.constraintKind !== "check" &&
        object.definition.constraintKind !== "foreignKey" &&
        object.definition.constraintKind !== "exclusion"
      ) {
        return undefined;
      }
      return `constraint ${quoteIdent(object.identity.name)} on ${qualify(schema, object.identity.parent.name)}`;
    case "policy":
      return `policy ${quoteIdent(object.identity.name)} on ${qualify(schema, object.identity.parent.name)}`;
    default:
      return undefined;
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
  const step = ddlStep(sql, kind, "ddl", ACCESS);
  if (!tableIsNew && column.definition.generated?.stored === true) {
    return [{ ...step, weight: "rewrite" }];
  }
  return [step];
}

function addConstraint(constraint: ConstraintObject, schema: string): readonly DdlStep[] {
  const sql = createObjectSql(constraint, schema);
  if (sql === undefined) return [];
  const step = ddlStep(sql, "add-constraint", "ddl", ACCESS);
  if (constraint.definition.constraintKind === "exclusion")
    return [{ ...step, weight: "blocking" }];
  return [step];
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
  const composite = isComposite(object.definition);
  const kind = composite
    ? "create-composite"
    : isRange(object.definition)
      ? "create-range"
      : isDomain(object.definition)
        ? "create-domain"
        : "create-enum";
  const steps: DdlStep[] = [ddlStep(sql, kind, "ddl", ACCESS)];
  if (composite) {
    for (const field of object.definition.fields) {
      if (field.comment === undefined) continue;
      steps.push(
        ddlStep(
          `comment on column ${qualify(schema, object.identity.name)}.${quoteIdent(field.name)} is ${quoteLiteral(field.comment)}`,
          "comment",
          "ddl",
          SHARE_UPDATE,
        ),
      );
    }
  }
  return steps;
}

function addAttribute(change: {
  readonly schema: string;
  readonly type: string;
  readonly name: string;
  readonly dataType: string;
  readonly comment?: string;
}): readonly DdlStep[] {
  const steps: DdlStep[] = [
    ddlStep(
      `alter type ${qualify(change.schema, change.type)} add attribute ${quoteIdent(change.name)} ${change.dataType}`,
      "add-attribute",
      "ddl",
      ACCESS,
    ),
  ];
  if (change.comment !== undefined) {
    steps.push(
      ddlStep(
        `comment on column ${qualify(change.schema, change.type)}.${quoteIdent(change.name)} is ${quoteLiteral(change.comment)}`,
        "comment",
        "ddl",
        SHARE_UPDATE,
      ),
    );
  }
  return steps;
}

function swapComposite(change: {
  readonly schema: string;
  readonly name: string;
  readonly fields: readonly { readonly name: string; readonly dataType: string }[];
  readonly columns: readonly {
    readonly table: string;
    readonly column: string;
    readonly defaultExpression?: string;
  }[];
}): readonly DdlStep[] {
  const fresh = `${change.name}_okm_new`;
  const retired = `${change.name}_okm_old`;
  const body = change.fields
    .map((field) => `${quoteIdent(field.name)} ${field.dataType}`)
    .join(", ");
  const steps: DdlStep[] = [
    ddlStep(
      `create type ${qualify(change.schema, fresh)} as (${body})`,
      "create-composite",
      "ddl",
      ACCESS,
    ),
  ];
  for (const column of change.columns) {
    const table = qualify(change.schema, column.table);
    const columnName = quoteIdent(column.column);
    if (column.defaultExpression !== undefined) {
      steps.push(
        ddlStep(
          `alter table ${table} alter column ${columnName} drop default`,
          "drop-default",
          "ddl",
          ACCESS,
        ),
      );
    }
    steps.push({
      ...ddlStep(
        `alter table ${table} alter column ${columnName} type ${qualify(change.schema, fresh)} using ${columnName}::text::${qualify(change.schema, fresh)}`,
        "set-composite-column",
        "ddl",
        ACCESS,
      ),
      weight: "rewrite",
    });
    if (column.defaultExpression !== undefined) {
      steps.push(
        ddlStep(
          `alter table ${table} alter column ${columnName} set default ${column.defaultExpression}`,
          "set-default",
          "ddl",
          ACCESS,
        ),
      );
    }
  }
  steps.push(
    ddlStep(
      `alter type ${qualify(change.schema, change.name)} rename to ${quoteIdent(retired)}`,
      "rename-enum",
      "ddl",
      ACCESS,
    ),
    ddlStep(
      `alter type ${qualify(change.schema, fresh)} rename to ${quoteIdent(change.name)}`,
      "rename-enum",
      "ddl",
      ACCESS,
    ),
    ddlStep(`drop type ${qualify(change.schema, retired)}`, "drop-composite", "ddl", ACCESS),
  );
  return steps;
}

function swapRange(change: {
  readonly schema: string;
  readonly name: string;
  readonly subtype: string;
  readonly subtypeDiff?: string;
  readonly collation?: string;
  readonly multirange: string;
  readonly columns: readonly {
    readonly table: string;
    readonly column: string;
    readonly defaultExpression?: string;
  }[];
}): readonly DdlStep[] {
  const fresh = `${change.name}_okm_new`;
  const retired = `${change.name}_okm_old`;
  const freshMulti = `${fresh}_multirange`;
  const parts = [`subtype = ${change.subtype}`];
  if (change.subtypeDiff !== undefined) parts.push(`subtype_diff = ${change.subtypeDiff}`);
  if (change.collation !== undefined) parts.push(`collation = ${quoteIdent(change.collation)}`);
  parts.push(`multirange_type_name = ${quoteIdent(freshMulti)}`);
  const steps: DdlStep[] = [
    ddlStep(
      `create type ${qualify(change.schema, fresh)} as range (${parts.join(", ")})`,
      "create-range",
      "ddl",
      ACCESS,
    ),
  ];
  for (const column of change.columns) {
    const table = qualify(change.schema, column.table);
    const columnName = quoteIdent(column.column);
    if (column.defaultExpression !== undefined) {
      steps.push(
        ddlStep(
          `alter table ${table} alter column ${columnName} drop default`,
          "drop-default",
          "ddl",
          ACCESS,
        ),
      );
    }
    steps.push({
      ...ddlStep(
        `alter table ${table} alter column ${columnName} type ${qualify(change.schema, fresh)} using ${columnName}::text::${qualify(change.schema, fresh)}`,
        "set-composite-column",
        "ddl",
        ACCESS,
      ),
      weight: "rewrite",
    });
    if (column.defaultExpression !== undefined) {
      steps.push(
        ddlStep(
          `alter table ${table} alter column ${columnName} set default ${column.defaultExpression}`,
          "set-default",
          "ddl",
          ACCESS,
        ),
      );
    }
  }
  steps.push(
    ddlStep(`drop type ${qualify(change.schema, change.multirange)}`, "drop-enum", "ddl", ACCESS),
    ddlStep(
      `alter type ${qualify(change.schema, change.name)} rename to ${quoteIdent(retired)}`,
      "rename-enum",
      "ddl",
      ACCESS,
    ),
    ddlStep(
      `alter type ${qualify(change.schema, fresh)} rename to ${quoteIdent(change.name)}`,
      "rename-enum",
      "ddl",
      ACCESS,
    ),
    ddlStep(
      `alter type ${qualify(change.schema, freshMulti)} rename to ${quoteIdent(change.multirange)}`,
      "rename-enum",
      "ddl",
      ACCESS,
    ),
    ddlStep(`drop type ${qualify(change.schema, retired)}`, "drop-enum", "ddl", ACCESS),
  );
  return steps;
}

function dropType(object: TypeObject, schema: string): readonly DdlStep[] {
  const sql = dropObjectSql(object, schema);
  if (sql === undefined) return [];
  const kind = isComposite(object.definition)
    ? "drop-composite"
    : isDomain(object.definition)
      ? "drop-domain"
      : "drop-enum";
  const steps: DdlStep[] = [];
  if (isRange(object.definition)) {
    steps.push(
      ddlStep(
        `drop type ${qualify(schema, object.definition.multirange)}`,
        "drop-enum",
        "ddl",
        ACCESS,
      ),
    );
  }
  steps.push(ddlStep(sql, kind, "ddl", ACCESS));
  return steps;
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
  object: FunctionObject | TriggerObject | ViewObject | MaterializedViewObject | SequenceObject,
  schema: string,
  kind: StepKind,
): readonly DdlStep[] {
  const sql = createObjectSql(object, schema);
  if (sql === undefined) return [];
  return [ddlStep(sql, kind, "ddl", ACCESS)];
}

function dropRoutine(
  object: FunctionObject | TriggerObject | ViewObject | MaterializedViewObject | SequenceObject,
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
    const step = ddlStep(sql, kind, "ddl", kind === "validate-constraint" ? SHARE_UPDATE : ACCESS);
    if (kind === "set-column-type" || kind === "set-generated") {
      const stored = after.definition.generated?.stored !== false;
      steps.push(kind === "set-generated" && !stored ? step : { ...step, weight: "rewrite" });
      continue;
    }
    steps.push(step);
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
  const left = before.definition.generated;
  const right = after.definition.generated;
  if (
    left !== undefined &&
    right !== undefined &&
    left.stored === right.stored &&
    left.expression !== right.expression
  ) {
    kinds.push("set-generated");
  }
  if (before.definition.nullable !== after.definition.nullable) {
    kinds.push(after.definition.nullable ? "drop-not-null" : "set-not-null");
  }
  if (validatesNotNull(before, after)) kinds.push("validate-constraint");
  if (before.definition.defaultExpression !== after.definition.defaultExpression) {
    kinds.push(after.definition.defaultExpression === undefined ? "drop-default" : "set-default");
  }
  return kinds;
}

function identityKind(before: ColumnObject, after: ColumnObject): StepKind | undefined {
  const next = after.definition.identity;
  const previous = before.definition.identity;
  if ((previous === undefined) === (next === undefined) && previous?.always === next?.always) {
    return undefined;
  }
  if (next === undefined) return "drop-identity";
  if (previous === undefined) return "add-identity";
  return next.always ? "set-identity-always" : "set-identity-by-default";
}

function identityChangeSql(
  before: ColumnObject,
  after: ColumnObject,
  schema: string,
): string | undefined {
  const next = after.definition.identity;
  const previous = before.definition.identity;
  if ((previous === undefined) === (next === undefined) && previous?.always === next?.always) {
    return undefined;
  }
  const table = qualify(schema, after.identity.parent.name);
  const name = quoteIdent(after.identity.name);
  if (next === undefined) return `alter table ${table} alter column ${name} drop identity`;
  if (previous === undefined) {
    const generated = next.always ? "always" : "by default";
    const parts = [
      next.start === undefined ? "" : `start with ${next.start}`,
      next.increment === undefined ? "" : `increment by ${next.increment}`,
      next.min === undefined ? "" : `minvalue ${next.min}`,
      next.max === undefined ? "" : `maxvalue ${next.max}`,
      next.cache === undefined ? "" : `cache ${next.cache}`,
      next.cycle === true ? "cycle" : "",
    ].filter((part) => part.length > 0);
    const options = parts.length === 0 ? "" : ` (${parts.join(" ")})`;
    return `alter table ${table} alter column ${name} add generated ${generated} as identity${options}`;
  }
  return `alter table ${table} alter column ${name} set generated ${next.always ? "always" : "by default"}`;
}

function swapCheck(
  schema: string,
  tableName: string,
  name: string,
  expression: string,
  kind: "narrow-check" | "widen-check",
): readonly DdlStep[] {
  const table = qualify(schema, tableName);
  const constraint = quoteIdent(name);
  return [
    ddlStep(`alter table ${table} drop constraint ${constraint}`, kind, "ddl", ACCESS),
    ddlStep(
      `alter table ${table} add constraint ${constraint} check (${expression}) not valid`,
      kind,
      "ddl",
      ACCESS,
    ),
    ddlStep(`alter table ${table} validate constraint ${constraint}`, kind, "ddl", SHARE_UPDATE),
  ];
}

function rewriteValues(
  change: Extract<LogicalChange, { readonly op: "rewrite-values" }>,
): readonly DdlStep[] {
  const qualified = qualify(change.schema, change.table);
  const column = quoteIdent(change.column);
  const value = change.to === null ? "null" : quoteLiteral(change.to);
  const compare = change.cast ? `${column}::text` : column;
  const sql = `update ${qualified} set ${column} = ${value} where ${compare} = ${quoteLiteral(change.from)} and ${change.predicate}`;
  return [
    {
      ...ddlStep(sql, change.kind, "backfill", ROW, false),
      backfill: { table: qualified, key: change.key, batch: change.batch },
    },
  ];
}
