/**
 * Postgres DDL for a catalog.
 *
 * Planning and scratch comparison both render through here, so a statement
 * has one spelling.
 */

import { isComposite } from "../../contracts/catalog/composite.js";
import { isDomain } from "../../contracts/catalog/enum.js";
import { isRange } from "../../contracts/catalog/range.js";
import { isGeneratedPolicy } from "../../contracts/catalog/policy.js";
import { fitIdentifier, printedIdentifier } from "../../contracts/catalog/identifier.js";
import { identityKey } from "../../contracts/catalog/identity.js";
import { creationOrder } from "../../contracts/catalog/document.js";
import {
  identitySequence,
  ownedByView,
  uniqueBeforeForeignKey,
} from "../../contracts/catalog/plan-order.js";

export { identitySequence, ownedByView, uniqueBeforeForeignKey };
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ConstraintObject,
  EventTriggerObject,
  FunctionObject,
  IndexElement,
  IndexObject,
  MaterializedViewObject,
  PolicyObject,
  SequenceObject,
  TableObject,
  TriggerObject,
  TypeObject,
  ViewObject,
} from "../../contracts/catalog/types.js";
import { quoteLiteral } from "./quote.js";

/**
 * Quotes one identifier.
 *
 * @param name - Identifier already checked by the catalog
 * @returns A double-quoted identifier
 */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const ARRAY_TAIL = /(?:\[\])+$/;

/**
 * Spells a column or domain type the statement can run.
 *
 * A name the catalog owns as a type object (an enum or a domain) goes through
 * {@link printedIdentifier}, so a mixed-case name, a space, a quote, or SQL text
 * in it stays one quoted name. A quoted name is schema-qualified when `schema`
 * is given. A bare lowercase name is unchanged, so existing plans keep their
 * text. Any other spelling is the stored builder type and is returned as written.
 *
 * @param dataType - Stored type, with a `[]` tail for an array
 * @param owns - Whether a name is a type the catalog owns
 * @param schema - Concrete schema, or `undefined` for a bare quoted name
 * @returns The type as SQL
 */
export function typeRef(
  dataType: string,
  owns: (name: string) => boolean,
  schema?: string,
): string {
  const tail = ARRAY_TAIL.exec(dataType)?.[0] ?? "";
  const scalar = dataType.slice(0, dataType.length - tail.length);
  if (!owns(scalar)) return dataType;
  const printed = printedIdentifier(scalar);
  if (schema === undefined || printed === scalar) return `${printed}${tail}`;
  return `${qualify(schema, scalar)}${tail}`;
}

/**
 * The type of one column as SQL.
 *
 * @param column - Column whose edges name an enum or domain it uses
 * @param schema - Concrete schema name
 * @returns The type, quoted and qualified when the column uses an enum or domain
 */
export function columnType(column: ColumnObject, schema: string): string {
  return typeRef(
    column.definition.dataType,
    (name) =>
      column.dependencies.some((edge) => edge.target.kind === "type" && edge.target.name === name),
    schema,
  );
}

/**
 * Renders a catalog as create statements in dependency order.
 *
 * Columns and primary keys are folded into `CREATE TABLE`. An identity
 * sequence is created by the column, not as its own statement.
 *
 * @param source - Catalog to apply
 * @param schema - Concrete schema name
 * @returns SQL statements
 */
export function renderCatalog(source: Catalog, schema: string): readonly string[] {
  const folded = foldedKeys(source);
  const statements: string[] = [];
  const ordered = creationOrder(source);
  const created = uniqueBeforeForeignKey(ordered);
  for (const object of ordered) {
    if (object.kind !== "type" || object.owner === "ignored") continue;
    const sql = createObjectSql(object, schema);
    if (sql !== undefined) statements.push(sql);
  }
  for (const object of created) {
    if (
      object.kind === "type" ||
      object.kind === "function" ||
      object.kind === "trigger" ||
      object.kind === "view" ||
      object.kind === "materializedView" ||
      object.kind === "policy" ||
      ownedByView(object)
    ) {
      continue;
    }
    if (object.owner === "ignored") continue;
    const key = identityKey(object.identity);
    if (object.kind === "table") {
      statements.push(createTableSql(object, source, schema));
      continue;
    }
    if (folded.has(key)) continue;
    const sql = createObjectSql(object, schema);
    if (sql !== undefined) statements.push(sql);
  }
  for (const object of created) {
    if (object.kind !== "policy" || object.owner === "ignored") continue;
    for (const step of policyCreatePlan(object, schema)) statements.push(step.sql);
  }
  for (const kind of ["function", "trigger"] as const) {
    for (const object of ordered) {
      if (object.kind !== kind || object.owner === "ignored") continue;
      const sql = createObjectSql(object, schema);
      if (sql !== undefined) statements.push(sql);
    }
  }
  for (const kind of ["view", "materializedView"] as const) {
    for (const object of ordered) {
      if (object.kind !== kind || object.owner === "ignored") continue;
      const sql = createObjectSql(object, schema);
      if (sql !== undefined) statements.push(sql);
    }
  }
  for (const object of ordered) {
    if (!ownedByView(object) || object.owner === "ignored") continue;
    const sql = createObjectSql(object, schema);
    if (sql !== undefined) statements.push(sql);
  }
  return statements;
}

/**
 * SQL that drops one object.
 *
 * A column or constraint drop is an `ALTER TABLE`. Dropping a table does not
 * use `CASCADE`.
 *
 * @param object - Object to drop
 * @param schema - Concrete schema name
 * @returns The statement, or `undefined` when the object is not dropped alone
 */
export function dropObjectSql(object: CatalogObject, schema: string): string | undefined {
  if (object.owner === "ignored") return undefined;
  switch (object.kind) {
    case "table":
      return `drop table ${qualify(schema, object.identity.name)}`;
    case "column":
      return `alter table ${qualify(schema, object.identity.parent.name)} drop column ${quoteIdent(object.identity.name)}`;
    case "index":
      return `drop index ${qualify(schema, object.identity.name)}`;
    case "constraint":
      return `alter table ${qualify(schema, object.identity.parent.name)} drop constraint ${quoteIdent(object.identity.name)}`;
    case "sequence":
      return `drop sequence ${qualify(schema, object.identity.name)}`;
    case "type":
      return `drop type ${qualify(schema, object.identity.name)}`;
    case "extension":
      return `drop extension ${quoteIdent(object.identity.name)}`;
    case "function":
      return `drop ${object.definition.routine === "procedure" ? "procedure" : "function"} ${qualify(schema, object.identity.name)}(${object.identity.argTypes.join(", ")})`;
    case "trigger":
      return `drop trigger ${quoteIdent(object.identity.name)} on ${qualify(schema, object.identity.parent.name)}`;
    case "eventTrigger":
      return `drop event trigger ${quoteIdent(object.identity.name)}`;
    case "view":
      return `drop view ${qualify(schema, object.identity.name)}`;
    case "materializedView":
      return `drop materialized view ${qualify(schema, object.identity.name)}`;
    default:
      return undefined;
  }
}

/**
 * SQL that creates one object that is not folded into a new table.
 *
 * @param object - Object to create
 * @param schema - Concrete schema name
 * @returns The statement
 */
export function createObjectSql(object: CatalogObject, schema: string): string | undefined {
  switch (object.kind) {
    case "column":
      return `alter table ${qualify(schema, object.identity.parent.name)} add column ${columnSql(object, schema)}`;
    case "index":
      return createIndexSql(object, schema);
    case "constraint":
      return `alter table ${qualify(schema, object.identity.parent.name)} add constraint ${quoteIdent(object.identity.name)} ${constraintBody(object, schema)}`;
    case "sequence":
      return createSequenceSql(object, schema);
    case "type":
      return createTypeSql(object, schema);
    case "extension":
      return createExtensionSql(object);
    case "function":
      return functionSql(object, schema, false);
    case "trigger":
      return triggerSql(object, schema);
    case "eventTrigger":
      return eventTriggerSql(object);
    case "view":
      return viewSql(object, schema, false);
    case "materializedView":
      return materializedViewSql(object, schema);
    case "table":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * `CREATE` or `CREATE OR REPLACE` for one function.
 *
 * A compatible signature change uses replace. The body is the stored source,
 * or the `BEGIN ATOMIC` block when the function is atomic.
 *
 * @param object - Function to render
 * @param schema - Concrete schema name
 * @param replace - `CREATE OR REPLACE` when true
 * @returns The statement
 */
export function functionSql(object: FunctionObject, schema: string, replace: boolean): string {
  const definition = object.definition;
  const procedure = definition.routine === "procedure";
  const args = definition.arguments
    .map((argument) => {
      const mode = argument.mode === undefined || argument.mode === "in" ? "" : ` ${argument.mode}`;
      const fallback = argument.default === undefined ? "" : ` default ${argument.default}`;
      return `${quoteIdent(argument.name)}${mode} ${argument.type}${fallback}`;
    })
    .join(", ");
  const word = procedure ? "procedure" : "function";
  const head = `${replace ? "create or replace" : "create"} ${word} ${qualify(schema, object.identity.name)}(${args})`;
  const security = ` security ${definition.security}`;
  const path =
    definition.searchPath === undefined ? "" : ` set search_path to ${definition.searchPath}`;
  const tail = procedure
    ? `language ${definition.language}${security}${path}`
    : `returns ${definition.returns} language ${definition.language} ${definition.volatility}${security}${path}`;
  if (definition.atomic) return `${head} ${tail} ${definition.body}`;
  return `${head} ${tail} as ${dollarQuote(definition.body)}`;
}

/**
 * `REVOKE EXECUTE ... FROM PUBLIC` for a security definer routine.
 *
 * Procedures and functions both get it. Absent when the routine is invoker.
 *
 * @param object - Routine being created or replaced
 * @param schema - Concrete schema name
 * @returns The revoke, or `undefined` for an invoker
 */
export function definerRevokeSql(object: FunctionObject, schema: string): string | undefined {
  if (object.definition.security !== "definer") return undefined;
  const word = object.definition.routine === "procedure" ? "procedure" : "function";
  return `revoke execute on ${word} ${qualify(schema, object.identity.name)}(${object.identity.argTypes.join(", ")}) from public`;
}

/**
 * `CREATE` or `CREATE OR REPLACE` for one view.
 *
 * Appending columns is replace. The query is the stored text.
 *
 * @param object - View to render
 * @param schema - Concrete schema name
 * @param replace - `CREATE OR REPLACE` when true
 * @returns The statement
 */
export function viewSql(object: ViewObject, schema: string, replace: boolean): string {
  const verb = replace ? "create or replace view" : "create view";
  const options: string[] = [];
  if (object.definition.securityInvoker === true) options.push("security_invoker = true");
  if (object.definition.securityBarrier === true) options.push("security_barrier = true");
  const withOptions = options.length > 0 ? ` with (${options.join(", ")})` : "";
  const check = object.definition.checkOption;
  const tail =
    check === "local"
      ? " with local check option"
      : check === "cascaded"
        ? " with cascaded check option"
        : "";
  return `${verb} ${qualify(schema, object.identity.name)}${withOptions} as ${object.definition.query}${tail}`;
}

/** One policy statement and the planner kind that classifies it. */
export type PolicyPlanStep = {
  readonly sql: string;
  readonly kind:
    | "enable-rls"
    | "create-policy"
    | "alter-policy"
    | "policy-public"
    | "drop-policy"
    | "disable-rls";
};

/** Whether row security is enabled and forced on a table. */
export type RlsState = {
  readonly enable: boolean;
  readonly force: boolean;
};

/**
 * `ENABLE`, `FORCE`, and `CREATE POLICY` for one policy.
 *
 * The `all` command policy also enables and forces row-level security.
 * The `select` policy is the unscoped read. Names are the stored identity.
 *
 * @param object - Policy to create
 * @param schema - Concrete schema name
 * @returns Statements in apply order
 */
export function policyCreatePlan(object: PolicyObject, schema: string): readonly PolicyPlanStep[] {
  if (!isGeneratedPolicy(object)) {
    return [
      {
        sql: policySql(object, schema, "create"),
        kind:
          roleClause(object.definition.roles) === " to public" ? "policy-public" : "create-policy",
      },
    ];
  }
  const table = qualify(schema, object.identity.parent.name);
  const name = quoteIdent(object.identity.name);
  const command = object.definition.command === "all" ? "all" : "select";
  const check =
    object.definition.command === "all" ? ` with check ${object.definition.expression}` : "";
  const create: PolicyPlanStep = {
    sql: `create policy ${name} on ${table} as permissive for ${command} using ${object.definition.expression}${check}`,
    kind: "create-policy",
  };
  if (object.definition.command !== "all") return [create];
  return [
    { sql: `alter table ${table} enable row level security`, kind: "enable-rls" },
    { sql: `alter table ${table} force row level security`, kind: "enable-rls" },
    create,
  ];
}

/**
 * `ALTER POLICY` for `TO`, `USING`, and `WITH CHECK`.
 *
 * `AS` and `FOR` are not altered here. Those drop and create the policy.
 *
 * @param object - Policy after the change
 * @param schema - Concrete schema name
 * @returns The alter statement
 */
export function policyAlterPlan(object: PolicyObject, schema: string): readonly PolicyPlanStep[] {
  return [
    {
      sql: policySql(object, schema, "alter"),
      kind: roleClause(object.definition.roles) === " to public" ? "policy-public" : "alter-policy",
    },
  ];
}

/**
 * Enable, force, disable, and no-force statements for one table.
 *
 * Tightening is enable then force. Lowering is no-force then disable.
 * A legacy `all` policy that already emits those statements is not passed here.
 *
 * @param table - SQL table name
 * @param schema - Concrete schema name
 * @param before - State in the previous catalog
 * @param after - State in the next catalog
 * @returns Statements in apply order
 */
export function rlsTogglePlan(
  table: string,
  schema: string,
  before: RlsState,
  after: RlsState,
): readonly PolicyPlanStep[] {
  const name = qualify(schema, table);
  const steps: PolicyPlanStep[] = [];
  if (!before.enable && after.enable) {
    steps.push({ sql: `alter table ${name} enable row level security`, kind: "enable-rls" });
  }
  if (!before.force && after.force) {
    steps.push({ sql: `alter table ${name} force row level security`, kind: "enable-rls" });
  }
  if (before.force && !after.force) {
    steps.push({ sql: `alter table ${name} no force row level security`, kind: "disable-rls" });
  }
  if (before.enable && !after.enable) {
    steps.push({ sql: `alter table ${name} disable row level security`, kind: "disable-rls" });
  }
  return steps;
}

function policySql(object: PolicyObject, schema: string, verb: "create" | "alter"): string {
  const definition = object.definition;
  const name = quoteIdent(object.identity.name);
  const table = qualify(schema, object.identity.parent.name);
  const head =
    verb === "create"
      ? `create policy ${name} on ${table} as ${definition.restrictive === true ? "restrictive" : "permissive"} for ${definition.command}`
      : `alter policy ${name} on ${table}`;
  const using = definition.checkOnly === true ? "" : ` using (${definition.expression})`;
  const check =
    definition.check !== undefined
      ? ` with check (${definition.check})`
      : definition.checkOnly === true
        ? ` with check (${definition.expression})`
        : "";
  return `${head}${roleClause(definition.roles)}${using}${check}`;
}

function roleClause(roles: readonly string[] | undefined): string {
  if (roles === undefined || roles.length === 0) return " to public";
  return ` to ${roles.map(roleSql).join(", ")}`;
}

function roleSql(name: string): string {
  return name.toLowerCase() === "public" ? "public" : quoteIdent(name);
}

/**
 * `DROP POLICY`, and for the `all` command policy `NO FORCE` and `DISABLE`.
 *
 * @param object - Policy to drop
 * @param schema - Concrete schema name
 * @returns Statements in apply order
 */
export function policyDropPlan(object: PolicyObject, schema: string): readonly PolicyPlanStep[] {
  const table = qualify(schema, object.identity.parent.name);
  const drop: PolicyPlanStep = {
    sql: `drop policy ${quoteIdent(object.identity.name)} on ${table}`,
    kind: "drop-policy",
  };
  if (!isGeneratedPolicy(object) || object.definition.command !== "all") return [drop];
  return [
    drop,
    { sql: `alter table ${table} no force row level security`, kind: "disable-rls" },
    { sql: `alter table ${table} disable row level security`, kind: "disable-rls" },
  ];
}

/**
 * `CREATE MATERIALIZED VIEW ... WITH NO DATA`.
 *
 * Populate is a separate planned step. This statement does not read the table.
 *
 * @param object - Materialized view to render
 * @param schema - Concrete schema name
 * @returns The statement
 */
export function materializedViewSql(object: MaterializedViewObject, schema: string): string {
  const definition = object.definition;
  const using =
    definition.using !== undefined && definition.using !== "heap"
      ? ` using ${definition.using}`
      : "";
  const storage =
    definition.storage !== undefined && definition.storage.length > 0
      ? ` with (${definition.storage.map(([key, value]) => `${key} = ${value}`).join(", ")})`
      : "";
  const tablespace =
    definition.tablespace !== undefined ? ` tablespace ${quoteIdent(definition.tablespace)}` : "";
  return `create materialized view ${qualify(schema, object.identity.name)}${using}${storage}${tablespace} as ${definition.query} with no data`;
}

/**
 * `REFRESH MATERIALIZED VIEW`.
 *
 * A view created `WITH NO DATA` is empty, and Postgres rejects `CONCURRENTLY`
 * until it has been populated once. The plan's populate step passes
 * `populated: false`. A later refresh uses `CONCURRENTLY` when the declaration
 * asked for it.
 *
 * @param object - Materialized view to refresh
 * @param schema - Concrete schema name
 * @param populated - `true` when the view already holds rows
 * @returns The statement
 */
export function refreshMaterializedViewSql(
  object: MaterializedViewObject,
  schema: string,
  populated = false,
): string {
  const concurrently =
    populated && object.definition.refresh === "concurrently" ? " concurrently" : "";
  return `refresh materialized view${concurrently} ${qualify(schema, object.identity.name)}`;
}

function triggerSql(object: TriggerObject, schema: string): string {
  const definition = object.definition;
  const timing = definition.timing === "instead" ? "instead of" : definition.timing;
  const events = definition.events
    .map((event) => {
      if (event !== "update" || definition.updateOf === undefined) return event;
      return `update of ${definition.updateOf.map((column) => quoteIdent(column)).join(", ")}`;
    })
    .join(" or ");
  const when = definition.when === undefined ? "" : ` when (${definition.when})`;
  const referencing = transitionSql(definition.referencing);
  const args = definition.calls.argTypes.join(", ");
  const fn = `${qualify(schema, definition.calls.name)}(${args})`;
  return `create trigger ${quoteIdent(object.identity.name)} ${timing} ${events} on ${qualify(schema, object.identity.parent.name)}${referencing} for each ${definition.level}${when} execute function ${fn}`;
}

function transitionSql(
  referencing: { readonly old?: string; readonly new?: string } | undefined,
): string {
  if (referencing === undefined) return "";
  const parts: string[] = [];
  if (referencing.old !== undefined) parts.push(`old table as ${quoteIdent(referencing.old)}`);
  if (referencing.new !== undefined) parts.push(`new table as ${quoteIdent(referencing.new)}`);
  return parts.length === 0 ? "" : ` referencing ${parts.join(" ")}`;
}

function eventTriggerSql(object: EventTriggerObject): string {
  const definition = object.definition;
  const fnSchema =
    definition.calls.namespace.form === "static" ? definition.calls.namespace.name : "public";
  const tags =
    definition.tags === undefined || definition.tags.length === 0
      ? ""
      : ` when tag in (${definition.tags.map((tag) => quoteLiteral(tag)).join(", ")})`;
  return `create event trigger ${quoteIdent(object.identity.name)} on ${definition.event}${tags} execute function ${qualify(fnSchema, definition.calls.name)}()`;
}

/**
 * `ALTER EVENT TRIGGER` for the enabled mode.
 *
 * `origin` is `ENABLE` with no suffix.
 *
 * @param name - Event trigger name
 * @param enabled - Stored mode
 * @returns The statement
 */
export function alterEventTriggerSql(
  name: string,
  enabled: "origin" | "disabled" | "replica" | "always",
): string {
  const mode =
    enabled === "disabled"
      ? "disable"
      : enabled === "replica"
        ? "enable replica"
        : enabled === "always"
          ? "enable always"
          : "enable";
  return `alter event trigger ${quoteIdent(name)} ${mode}`;
}

/**
 * `ALTER EVENT TRIGGER ... RENAME TO`.
 *
 * @param from - Current name
 * @param to - New name
 * @returns The statement
 */
export function renameEventTriggerSql(from: string, to: string): string {
  return `alter event trigger ${quoteIdent(from)} rename to ${quoteIdent(to)}`;
}

/**
 * `ALTER ... OWNER TO` for a function or an event trigger.
 *
 * @param sql - The object the statement names, already qualified
 * @param owner - Role name
 * @returns The statement
 */
export function ownerSql(
  kind: "function" | "event trigger" | "table",
  sql: string,
  owner: string,
): string {
  return `alter ${kind} ${sql} owner to ${quoteIdent(owner)}`;
}

function dollarQuote(body: string): string {
  let tag = "okm";
  while (body.includes(`$${tag}$`)) tag = `${tag}_`;
  return `$${tag}$${body}$${tag}$`;
}

/**
 * Whether the plan must validate a NOT NULL constraint the column already has.
 *
 * PostgreSQL 18 can hold `NOT NULL … NOT VALID`. When the schema says NOT NULL,
 * the constraint is validated in place. When it says nullable, `DROP NOT NULL`
 * removes the constraint, so no separate statement is needed.
 *
 * @param before - Column already applied
 * @param after - Column the plan must reach
 * @returns `true` when `VALIDATE CONSTRAINT` is the change
 */
export function validatesNotNull(before: ColumnObject, after: ColumnObject): boolean {
  return (
    before.definition.unvalidatedNotNull !== undefined &&
    !before.definition.nullable &&
    !after.definition.nullable &&
    after.definition.unvalidatedNotNull === undefined
  );
}

/**
 * In-place column changes: type, nullability, validation, and default.
 *
 * @param before - Column already applied
 * @param after - Column the plan must reach
 * @param schema - Concrete schema name
 * @returns Statements, empty when the definitions match
 */
export function alterColumnSql(
  before: ColumnObject,
  after: ColumnObject,
  schema: string,
): readonly string[] {
  const statements: string[] = [];
  const table = qualify(schema, after.identity.parent.name);
  const name = quoteIdent(after.identity.name);
  const typeChanged = before.definition.dataType !== after.definition.dataType;
  const collationChanged = before.definition.collation !== after.definition.collation;
  if (typeChanged || collationChanged) {
    const type = columnType(after, schema);
    const using = typeChanged ? ` using ${name}::${type}` : "";
    statements.push(
      `alter table ${table} alter column ${name} set data type ${type}${collateSql(after.definition.collation)}${using}`,
    );
  }
  if (before.definition.nullable !== after.definition.nullable) {
    statements.push(
      `alter table ${table} alter column ${name} ${after.definition.nullable ? "drop not null" : "set not null"}`,
    );
  }
  if (validatesNotNull(before, after)) {
    const constraint = quoteIdent(before.definition.unvalidatedNotNull ?? "");
    statements.push(`alter table ${table} validate constraint ${constraint}`);
  }
  const beforeGenerated = before.definition.generated;
  const afterGenerated = after.definition.generated;
  if (
    beforeGenerated !== undefined &&
    afterGenerated !== undefined &&
    beforeGenerated.expression !== afterGenerated.expression
  ) {
    statements.push(
      `alter table ${table} alter column ${name} set expression as (${afterGenerated.expression})`,
    );
  }
  if (before.definition.defaultExpression !== after.definition.defaultExpression) {
    statements.push(
      after.definition.defaultExpression === undefined
        ? `alter table ${table} alter column ${name} drop default`
        : `alter table ${table} alter column ${name} set default ${after.definition.defaultExpression}`,
    );
  }
  return statements;
}

function foldedKeys(source: Catalog): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const object of source.objects) {
    if (object.kind === "column") keys.add(identityKey(object.identity));
    if (object.kind === "constraint" && object.definition.constraintKind === "primaryKey") {
      keys.add(identityKey(object.identity));
    }
    if (object.kind === "sequence" && identitySequence(object, source)) {
      keys.add(identityKey(object.identity));
    }
  }
  return keys;
}

/**
 * `CREATE TABLE` for one table, including its columns and primary key.
 *
 * @param tableObject - Table to create
 * @param source - Catalog that holds the columns
 * @param schema - Concrete schema name
 * @returns The statement
 */
export function createTableSql(tableObject: TableObject, source: Catalog, schema: string): string {
  const parent = tableObject.identity.name;
  const columns = source.objects.filter(
    (object): object is ColumnObject =>
      object.kind === "column" && object.identity.parent.name === parent,
  );
  // Generated columns follow the plain columns. The list otherwise stays in
  // identity-key order, so a table with no generated column keeps its SQL.
  const listed = generatedLast(columns);
  const primary = source.objects.find(
    (object): object is ConstraintObject =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "primaryKey" &&
      object.identity.parent.name === parent,
  );
  const lines = listed.map((column) => columnSql(column, schema));
  if (primary !== undefined) {
    const cols = keyList(
      primary.definition.columns,
      primary.definition.withoutOverlaps,
      "without overlaps",
    );
    lines.push(`constraint ${quoteIdent(primary.identity.name)} primary key (${cols})`);
  }
  const partition = tableObject.definition.partition;
  const tail =
    partition === undefined
      ? ""
      : ` partition by ${partition.method} (${partition.columns.map((name) => quoteIdent(name)).join(", ")})`;
  return `create table ${qualify(schema, parent)} (\n  ${lines.join(",\n  ")}\n)${tail}`;
}

/**
 * Puts generated columns after the plain columns of the same list.
 *
 * Each group keeps the order it already had. A table with no generated
 * column returns that list unchanged.
 *
 * @param columns - Columns of one table, in identity-key order
 * @returns The list written into `create table`
 */
function generatedLast(columns: readonly ColumnObject[]): readonly ColumnObject[] {
  if (!columns.some((column) => column.definition.generated !== undefined)) return columns;
  const plain: ColumnObject[] = [];
  const after: ColumnObject[] = [];
  for (const column of columns) {
    if (column.definition.generated === undefined) plain.push(column);
    else after.push(column);
  }
  return plain.concat(after);
}

function collateSql(collation: string | undefined): string {
  if (collation === undefined) return "";
  return ` collate ${quoteIdent(collation)}`;
}

function keyList(
  columns: readonly string[],
  marked: true | undefined,
  keyword: "without overlaps" | "period",
): string {
  if (marked !== true || columns.length === 0)
    return columns.map((name) => quoteIdent(name)).join(", ");
  const head = columns.slice(0, -1).map((name) => quoteIdent(name));
  const last = columns[columns.length - 1] ?? "";
  const tail =
    keyword === "period" ? `period ${quoteIdent(last)}` : `${quoteIdent(last)} without overlaps`;
  return [...head, tail].join(", ");
}

function createTypeSql(object: TypeObject, schema: string): string {
  if (isRange(object.definition)) {
    const definition = object.definition;
    const parts = [`subtype = ${sqlTypeName(definition.subtype)}`];
    if (definition.subtypeDiff !== undefined) {
      parts.push(`subtype_diff = ${sqlTypeName(definition.subtypeDiff)}`);
    }
    if (definition.collation !== undefined)
      parts.push(`collation = ${quoteIdent(definition.collation)}`);
    parts.push(`multirange_type_name = ${quoteIdent(definition.multirange)}`);
    return `create type ${qualify(schema, object.identity.name)} as range (${parts.join(", ")})`;
  }
  if (isComposite(object.definition)) {
    const body = object.definition.fields
      .map((field) => `${quoteIdent(field.name)} ${field.dataType}`)
      .join(", ");
    return `create type ${qualify(schema, object.identity.name)} as (${body})`;
  }
  if (isDomain(object.definition)) {
    const name = object.identity.name;
    const constraint = quoteIdent(fitIdentifier(`${name}_check`));
    const base = typeRef(
      object.definition.base,
      (owned) =>
        object.dependencies.some(
          (edge) => edge.target.kind === "type" && edge.target.name === owned,
        ),
      schema,
    );
    return `create domain ${qualify(schema, name)} as ${base} constraint ${constraint} check (${object.definition.check})`;
  }
  const labels = object.definition.labels.map((label) => quoteLiteral(label)).join(", ");
  return `create type ${qualify(schema, object.identity.name)} as enum (${labels})`;
}

function columnSql(column: ColumnObject, schema: string): string {
  const definition = column.definition;
  let sql = `${quoteIdent(column.identity.name)} ${columnType(column, schema)}${collateSql(definition.collation)}`;
  if (definition.identity !== undefined) {
    sql += identityClause(definition.identity);
  } else if (definition.generated !== undefined) {
    const kind = definition.generated.stored ? "stored" : "virtual";
    sql += ` generated always as (${definition.generated.expression}) ${kind}`;
  }
  if (!definition.nullable) sql += " not null";
  if (definition.defaultExpression !== undefined) sql += ` default ${definition.defaultExpression}`;
  return sql;
}

/** CREATE INDEX text for one catalog index. The planner owns CONCURRENTLY. */
export function createIndexSql(object: IndexObject, schema: string): string {
  const definition = object.definition;
  const unique = definition.unique ? "unique " : "";
  const where = definition.predicate === undefined ? "" : ` where ${definition.predicate}`;
  const expression = definition.expression;
  const name = quoteIdent(object.identity.name);
  const on = qualify(schema, object.identity.parent.name);
  const storage = indexStorageSql(definition.storage);
  if (
    expression !== undefined &&
    expression.startsWith("using ") &&
    definition.method === undefined &&
    definition.elements === undefined
  ) {
    return `create ${unique}index ${name} on ${on} ${expression}${storage}${where}`;
  }
  const method =
    definition.method !== undefined && definition.method !== "btree"
      ? ` using ${definition.method}`
      : "";
  const keys = indexKeys(definition);
  const include =
    definition.include !== undefined && definition.include.length > 0
      ? ` include (${definition.include.map((column) => quoteIdent(column)).join(", ")})`
      : "";
  const nulls = definition.nullsNotDistinct === true ? " nulls not distinct" : "";
  return `create ${unique}index ${name} on ${on}${method} (${keys})${include}${nulls}${storage}${where}`;
}

function indexKeys(definition: IndexObject["definition"]): string {
  const expression =
    definition.expression !== undefined && !definition.expression.startsWith("using ")
      ? `(${definition.expression})`
      : undefined;
  if (definition.elements !== undefined && definition.elements.length > 0) {
    const keys = definition.elements.map(indexElementSql).join(", ");
    return expression === undefined ? keys : `${keys}, ${expression}`;
  }
  const columns = definition.columns.map((column) => quoteIdent(column));
  if (expression !== undefined) {
    return columns.length > 0 ? `${columns.join(", ")}, ${expression}` : expression;
  }
  return columns.join(", ");
}

function indexElementSql(element: IndexElement): string {
  const base =
    element.expression !== undefined ? `(${element.expression})` : quoteIdent(element.column ?? "");
  const opclass = element.opclass !== undefined ? ` ${element.opclass}` : "";
  const order = element.order === "desc" ? " desc" : "";
  const nulls =
    element.nulls === "first" ? " nulls first" : element.nulls === "last" ? " nulls last" : "";
  return `${base}${opclass}${order}${nulls}`;
}

function indexStorageSql(storage: IndexObject["definition"]["storage"]): string {
  if (storage === undefined) return "";
  const parts = Object.keys(storage)
    .sort()
    .map((key) => `${key}=${storage[key]}`);
  return parts.length === 0 ? "" : ` with (${parts.join(", ")})`;
}

function createExtensionSql(object: CatalogObject & { readonly kind: "extension" }): string {
  const version = object.definition.version;
  const pinned =
    version !== undefined && /^\d+(?:\.\d+)*$/.test(version)
      ? ` version ${quoteLiteral(version)}`
      : "";
  return `create extension ${quoteIdent(object.identity.name)} schema ${quoteIdent(object.definition.schema)}${pinned}`;
}

function identityClause(identity: {
  readonly always: boolean;
  readonly start?: string;
  readonly increment?: string;
  readonly min?: string;
  readonly max?: string;
  readonly cache?: string;
  readonly cycle?: boolean;
}): string {
  const generated = identity.always ? "always" : "by default";
  const parts = [
    identity.start === undefined ? "" : `start with ${identity.start}`,
    identity.increment === undefined ? "" : `increment by ${identity.increment}`,
    identity.min === undefined ? "" : `minvalue ${identity.min}`,
    identity.max === undefined ? "" : `maxvalue ${identity.max}`,
    identity.cache === undefined ? "" : `cache ${identity.cache}`,
    identity.cycle === true ? "cycle" : "",
  ].filter((part) => part.length > 0);
  const options = parts.length === 0 ? "" : ` (${parts.join(" ")})`;
  return ` generated ${generated} as identity${options}`;
}

function createSequenceSql(object: SequenceObject, schema: string): string {
  const definition = object.definition;
  const cycle = definition.cycle ? " cycle" : "";
  const min = definition.min === undefined ? "" : ` minvalue ${definition.min}`;
  const max = definition.max === undefined ? "" : ` maxvalue ${definition.max}`;
  const cache = definition.cache === undefined ? "" : ` cache ${definition.cache}`;
  return `create sequence ${qualify(schema, object.identity.name)} as ${definition.dataType} start ${definition.start} increment ${definition.increment}${min}${max}${cache}${cycle}`;
}

/**
 * Schema a foreign key points at.
 *
 * A key inside one namespace uses `schema`, so a scratch replay can retarget
 * it. A key whose target namespace differs keeps that namespace.
 */
function referenceSchema(object: ConstraintObject, schema: string): string {
  const references = object.definition.references;
  if (references === undefined) return schema;
  const target = references.parent.namespace;
  const parent = object.identity.parent.namespace;
  if (target.form === "static" && parent.form === "static" && target.name !== parent.name) {
    return target.name;
  }
  return schema;
}

function sqlTypeName(name: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name;
  return quoteIdent(name);
}

function constraintBody(object: ConstraintObject, schema: string): string {
  const definition = object.definition;
  const columns = definition.columns.map((name) => quoteIdent(name)).join(", ");
  switch (definition.constraintKind) {
    case "primaryKey":
      return `primary key (${keyList(definition.columns, definition.withoutOverlaps, "without overlaps")})`;
    case "exclusion":
      return exclusionBody(definition);
    case "unique": {
      const nulls = definition.nullsNotDistinct ? " nulls not distinct" : "";
      return `unique${nulls} (${columns})${deferClause(definition)}`;
    }
    case "check": {
      const enforced = definition.enforced === false ? " not enforced" : "";
      return `check (${definition.expression ?? "true"})${enforced}${deferClause(definition)}`;
    }
    case "foreignKey": {
      const references = definition.references;
      const local = keyList(definition.columns, definition.period, "period");
      const remote =
        references === undefined ? "" : keyList(references.columns, definition.period, "period");
      const target =
        references === undefined
          ? ""
          : ` references ${qualify(referenceSchema(object, schema), references.parent.name)} (${remote})`;
      const listed = references?.onDeleteColumns;
      const list =
        listed !== undefined && listed.length > 0
          ? ` (${listed.map((name) => quoteIdent(name)).join(", ")})`
          : "";
      const onDelete =
        references?.onDelete === undefined ? "" : ` on delete ${references.onDelete}${list}`;
      const onUpdate =
        references?.onUpdate === undefined ? "" : ` on update ${references.onUpdate}`;
      const match = references?.match === "full" ? " match full" : "";
      return `foreign key (${local})${target}${match}${onDelete}${onUpdate}${deferClause(definition)}`;
    }
    default:
      return definition.constraintKind;
  }
}

function exclusionBody(definition: ConstraintObject["definition"]): string {
  const elements = definition.exclusion ?? [];
  const keys = elements
    .map((element) => {
      const target = element.expression ?? quoteIdent(element.column ?? "");
      const operator =
        element.operator === "eq" ? "=" : element.operator === "overlaps" ? "&&" : "-|-";
      return `${target} with ${operator}`;
    })
    .join(", ");
  const where =
    definition.expression === undefined || definition.expression.length === 0
      ? ""
      : ` where (${definition.expression})`;
  return `exclude using gist (${keys})${where}${deferClause(definition)}`;
}

function deferClause(definition: ConstraintObject["definition"]): string {
  if (!definition.deferrable) return "";
  return ` deferrable initially ${definition.initially}`;
}

/**
 * Quotes a schema-qualified name.
 *
 * @param schema - Concrete schema name
 * @param name - Object name
 * @returns `"schema"."name"`
 */
export function qualify(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}
