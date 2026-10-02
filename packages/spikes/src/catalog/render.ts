/**
 * DDL for a catalog.
 *
 * Statements follow create order. Columns and primary keys are folded into
 * `CREATE TABLE`. Everything else is its own statement. Names are
 * schema-qualified. `external` and `ignored` objects are not emitted.
 */

import { creationOrder, dropOrder, assertCatalog } from "./graph.js";
import {
  CatalogError,
  type CatalogObject,
  type ColumnObject,
  type ConstraintObject,
  type DefaultPrivilegeObject,
  type ExtensionObject,
  type GrantObject,
  type NamespaceName,
  type RoleObject,
} from "./object.js";
import { quoteIdent, quoteLiteral } from "./sql.js";

/** Maps a logical namespace onto the schema used for one apply. */
export type NamespaceBinding = {
  readonly logical: NamespaceName;
  readonly concrete: string;
};

/**
 * Renders `CREATE` statements for managed objects.
 *
 * `partial` allows a subset whose dependencies already exist. The migration
 * planner uses that to render one create at a time.
 *
 * @param objects - Catalog
 * @param bindings - Logical namespace to concrete schema
 * @param options - Set `partial` to skip the dependency-existence check
 * @returns SQL statements in create order
 */
export function renderCatalog(
  objects: readonly CatalogObject[],
  bindings: readonly NamespaceBinding[],
  options?: { readonly partial?: boolean },
): readonly string[] {
  assertCatalog(objects, options);
  const managed = objects.filter((object) => object.owner === "managed");
  const statements: string[] = [];
  for (const object of creationOrder(managed)) {
    statements.push(...emit(object, managed, bindings));
  }
  return statements;
}

/**
 * Renders `DROP` statements for managed objects.
 *
 * Columns and primary keys are omitted: `DROP TABLE` removes them. The
 * remaining statements follow drop order and never use `CASCADE`.
 *
 * @param objects - Catalog
 * @param bindings - Logical namespace to concrete schema
 * @returns SQL statements in drop order
 */
export function renderDrop(
  objects: readonly CatalogObject[],
  bindings: readonly NamespaceBinding[],
): readonly string[] {
  assertCatalog(objects);
  const managed = objects.filter((object) => object.owner === "managed");
  const statements: string[] = [];
  for (const object of dropOrder(managed)) {
    const statement = emitDrop(object, bindings);
    if (statement !== undefined) statements.push(statement);
  }
  return statements;
}

function emit(
  object: CatalogObject,
  objects: readonly CatalogObject[],
  bindings: readonly NamespaceBinding[],
): readonly string[] {
  switch (object.kind) {
    case "column":
      return [];
    case "table":
      return emitTable(object, objects, bindings);
    case "constraint":
      return emitConstraint(object, bindings);
    case "index":
      return [emitIndex(object, bindings)];
    case "sequence":
      return [emitSequence(object, bindings)];
    case "domain":
      return [emitDomain(object, bindings)];
    case "partition":
      return [emitPartition(object, bindings)];
    case "function":
      return [emitFunction(object, bindings)];
    case "trigger":
      return [emitTrigger(object, bindings)];
    case "view":
      return [emitView(object, bindings)];
    case "materialized_view":
      return [emitMaterializedView(object, bindings)];
    case "policy":
      return [emitPolicy(object, bindings)];
    case "extension":
      return [createExtensionSql(object)];
    case "role":
      return [roleSql(object, "create")];
    case "grant":
      return [grantSql(object, bindings, "grant")];
    case "default_privilege":
      return [defaultPrivilegeSql(object, bindings, "grant")];
    default:
      return assertNever(object);
  }
}

function emitDrop(
  object: CatalogObject,
  bindings: readonly NamespaceBinding[],
): string | undefined {
  switch (object.kind) {
    case "column":
      return undefined;
    case "constraint":
      if (object.definition.constraintKind === "primary_key") return undefined;
      return `alter table ${qualify(object.identity.namespace, object.identity.parent, bindings)} drop constraint ${quoteIdent(object.identity.name)}`;
    case "index":
      return `drop index ${qualify(object.identity.namespace, object.identity.name, bindings)}`;
    case "table":
    case "partition":
      return `drop table ${qualify(object.identity.namespace, object.identity.name, bindings)}`;
    case "sequence":
      return `drop sequence ${qualify(object.identity.namespace, object.identity.name, bindings)}`;
    case "domain":
      return `drop domain ${qualify(object.identity.namespace, object.identity.name, bindings)}`;
    case "function":
      return `drop function ${qualify(object.identity.namespace, object.identity.name, bindings)}(${object.identity.argTypes.join(", ")})`;
    case "trigger":
      return `drop trigger ${quoteIdent(object.identity.name)} on ${qualify(object.identity.namespace, object.identity.parent, bindings)}`;
    case "view":
      return `drop view ${qualify(object.identity.namespace, object.identity.name, bindings)}`;
    case "materialized_view":
      return `drop materialized view ${qualify(object.identity.namespace, object.identity.name, bindings)}`;
    case "policy":
      return `drop policy ${quoteIdent(object.identity.name)} on ${qualify(object.identity.namespace, object.identity.parent, bindings)}`;
    case "extension":
      return `drop extension ${quoteIdent(object.identity.name)}`;
    case "role":
      return roleSql(object, "drop");
    case "grant":
      return grantSql(object, bindings, "revoke");
    case "default_privilege":
      return defaultPrivilegeSql(object, bindings, "revoke");
    default:
      return assertNever(object);
  }
}

function emitTable(
  table: Extract<CatalogObject, { kind: "table" }>,
  objects: readonly CatalogObject[],
  bindings: readonly NamespaceBinding[],
): readonly string[] {
  const columns = objects
    .filter(
      (object): object is ColumnObject =>
        object.kind === "column" &&
        object.identity.parent === table.identity.name &&
        object.identity.namespace.name === table.identity.namespace.name,
    )
    .sort((left, right) => left.identity.name.localeCompare(right.identity.name));
  if (columns.length === 0) {
    throw new CatalogError(`Table ${table.identity.name} has no columns.`);
  }
  const lines = columns.map((column) => {
    if (column.definition.generatedSql !== undefined) {
      const nullable = column.definition.nullable ? "" : " not null";
      return `${quoteIdent(column.identity.name)} ${column.definition.type} generated always as (${column.definition.generatedSql}) stored${nullable}`;
    }
    const nullable = column.definition.nullable ? "" : " not null";
    const defaultSql =
      column.definition.defaultSql === undefined ? "" : ` default ${column.definition.defaultSql}`;
    return `${quoteIdent(column.identity.name)} ${column.definition.type}${nullable}${defaultSql}`;
  });
  const primaryKey = objects.find(
    (object): object is ConstraintObject =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "primary_key" &&
      object.identity.parent === table.identity.name &&
      object.identity.namespace.name === table.identity.namespace.name,
  );
  if (primaryKey !== undefined) {
    const cols = primaryKey.definition.columns.map((column) => quoteIdent(column)).join(", ");
    lines.push(`constraint ${quoteIdent(primaryKey.identity.name)} primary key (${cols})`);
  }
  const partition = table.definition.partitionBy;
  const partitionSql =
    partition === undefined
      ? ""
      : ` partition by ${partition.method} (${partition.columns.map((column) => quoteIdent(column)).join(", ")})`;
  const create = `create table ${qualify(table.identity.namespace, table.identity.name, bindings)} (\n${lines.join(",\n")}\n)${partitionSql}`;
  if (!table.definition.rowSecurity) return [create];
  return [
    create,
    `alter table ${qualify(table.identity.namespace, table.identity.name, bindings)} enable row level security`,
  ];
}

function emitConstraint(
  constraint: ConstraintObject,
  bindings: readonly NamespaceBinding[],
): readonly string[] {
  if (constraint.definition.constraintKind === "primary_key") return [];
  const table = qualify(constraint.identity.namespace, constraint.identity.parent, bindings);
  const columns = constraint.definition.columns.map((column) => quoteIdent(column)).join(", ");
  let body: string;
  switch (constraint.definition.constraintKind) {
    case "unique": {
      const nulls = constraint.definition.nullsNotDistinct ? " nulls not distinct" : "";
      body = `unique${nulls} (${columns})`;
      break;
    }
    case "foreign_key": {
      const references = constraint.definition.references;
      if (references === undefined)
        throw new CatalogError(`${constraint.identity.name} has no references.`);
      const target = qualify(constraint.identity.namespace, references.table, bindings);
      const refColumns = references.columns.map((column) => quoteIdent(column)).join(", ");
      body = `foreign key (${columns}) references ${target} (${refColumns})`;
      break;
    }
    case "check": {
      if (constraint.definition.expression === undefined) {
        throw new CatalogError(`${constraint.identity.name} has no expression.`);
      }
      body = `check (${constraint.definition.expression})`;
      break;
    }
  }
  const defer = constraint.definition.deferrable
    ? ` deferrable initially ${constraint.definition.initially}`
    : "";
  return [
    `alter table ${table} add constraint ${quoteIdent(constraint.identity.name)} ${body}${defer}`,
  ];
}

function emitIndex(
  index: Extract<CatalogObject, { kind: "index" }>,
  bindings: readonly NamespaceBinding[],
): string {
  const unique = index.definition.unique ? "unique " : "";
  const keys =
    index.definition.expression === undefined
      ? index.definition.columns.map((column) => quoteIdent(column)).join(", ")
      : `(${index.definition.expression})`;
  const table = qualify(index.identity.namespace, index.identity.parent, bindings);
  const where =
    index.definition.predicate === undefined ? "" : ` where (${index.definition.predicate})`;
  return `create ${unique}index ${quoteIdent(index.identity.name)} on ${table} (${keys})${where}`;
}

/**
 * `CREATE ROLE`, `ALTER ROLE`, or `DROP ROLE`.
 *
 * @param role - Role object
 * @param mode - Which statement
 * @returns One statement
 */
export function roleSql(role: RoleObject, mode: "create" | "alter" | "drop"): string {
  const name = quoteIdent(role.identity.name);
  if (mode === "drop") return `drop role ${name}`;
  const login = role.definition.login ? "login" : "nologin";
  const inherit = role.definition.inherit ? "inherit" : "noinherit";
  const verb = mode === "create" ? "create role" : "alter role";
  return `${verb} ${name} ${login} ${inherit}`;
}

/**
 * `CREATE EXTENSION`, including version and schema when the catalog sets them.
 *
 * @param extension - Extension object
 * @returns One statement
 */
export function createExtensionSql(extension: ExtensionObject): string {
  const version =
    extension.definition.version === undefined
      ? ""
      : ` version ${quoteLiteral(extension.definition.version)}`;
  const schema =
    extension.definition.schema === undefined
      ? ""
      : ` schema ${quoteIdent(extension.definition.schema)}`;
  return `create extension ${quoteIdent(extension.identity.name)}${version}${schema}`;
}

/**
 * `ALTER EXTENSION` for a version raise, a schema move, or both.
 *
 * A schema move is emitted even when `relocatable` is false. Postgres rejects
 * that statement. The planner does not know the server flag unless the catalog
 * stored it, and this spike records the refusal from the server.
 *
 * @param before - Extension already installed
 * @param after - Target extension
 * @returns Statements. Empty when version and schema are unchanged
 */
export function alterExtensionSql(
  before: ExtensionObject,
  after: ExtensionObject,
): readonly string[] {
  const name = quoteIdent(after.identity.name);
  const statements: string[] = [];
  if ((before.definition.version ?? "") !== (after.definition.version ?? "")) {
    if (after.definition.version === undefined) {
      throw new CatalogError(`Extension ${after.identity.name} cannot drop its version.`);
    }
    statements.push(`alter extension ${name} update to ${quoteLiteral(after.definition.version)}`);
  }
  if ((before.definition.schema ?? "") !== (after.definition.schema ?? "")) {
    if (after.definition.schema === undefined) {
      throw new CatalogError(`Extension ${after.identity.name} cannot drop its schema.`);
    }
    statements.push(`alter extension ${name} set schema ${quoteIdent(after.definition.schema)}`);
  }
  return statements;
}

/**
 * `GRANT` or `REVOKE` for one privilege.
 *
 * @param grant - Grant object
 * @param bindings - Logical namespace to concrete schema
 * @param mode - Grant or revoke
 * @returns One statement
 */
export function grantSql(
  grant: GrantObject,
  bindings: readonly NamespaceBinding[],
  mode: "grant" | "revoke",
): string {
  const privilege = grant.identity.privilege;
  const role = quoteIdent(grant.identity.role);
  const target = grantTarget(grant, bindings);
  const option = mode === "grant" && grant.definition.grantable ? " with grant option" : "";
  const verb = mode === "grant" ? "grant" : "revoke";
  const tail = mode === "grant" ? `to ${role}${option}` : `from ${role}`;
  return `${verb} ${privilege} on ${target} ${tail}`;
}

/**
 * `ALTER DEFAULT PRIVILEGES` grant or revoke.
 *
 * @param privilege - Default privilege
 * @param bindings - Logical namespace to concrete schema
 * @param mode - Grant or revoke
 * @returns One statement
 */
export function defaultPrivilegeSql(
  privilege: DefaultPrivilegeObject,
  bindings: readonly NamespaceBinding[],
  mode: "grant" | "revoke",
): string {
  const schema = quoteIdent(concreteSchema(privilege.identity.namespace, bindings));
  const verb = mode === "grant" ? "grant" : "revoke";
  const direction = mode === "grant" ? "to" : "from";
  const option = mode === "grant" && privilege.definition.grantable ? " with grant option" : "";
  return `alter default privileges for role ${quoteIdent(privilege.identity.forRole)} in schema ${schema} ${verb} ${privilege.identity.privilege} on ${privilege.identity.objectType} ${direction} ${quoteIdent(privilege.identity.role)}${option}`;
}

function emitSequence(
  sequence: Extract<CatalogObject, { kind: "sequence" }>,
  bindings: readonly NamespaceBinding[],
): string {
  const name = qualify(sequence.identity.namespace, sequence.identity.name, bindings);
  return `create sequence ${name} as ${sequence.definition.dataType} start with ${sequence.definition.start} increment by ${sequence.definition.increment}`;
}

function emitDomain(
  domain: Extract<CatalogObject, { kind: "domain" }>,
  bindings: readonly NamespaceBinding[],
): string {
  const name = qualify(domain.identity.namespace, domain.identity.name, bindings);
  const notNull = domain.definition.notNull ? " not null" : "";
  const check =
    domain.definition.checkSql === undefined
      ? ""
      : ` constraint ${quoteIdent(`${domain.identity.name}_check`)} check (${domain.definition.checkSql})`;
  return `create domain ${name} as ${domain.definition.baseType}${notNull}${check}`;
}

function emitPartition(
  partition: Extract<CatalogObject, { kind: "partition" }>,
  bindings: readonly NamespaceBinding[],
): string {
  const name = qualify(partition.identity.namespace, partition.identity.name, bindings);
  const parent = qualify(partition.identity.namespace, partition.definition.parent, bindings);
  const method = partition.definition.method ?? "range";
  if (method === "list") {
    const values = partition.definition.values ?? [];
    if (values.length === 0) {
      throw new CatalogError(`Partition ${partition.identity.name} has no list values.`);
    }
    if (values.some((value) => !/^-?\d+$/.test(value))) {
      throw new CatalogError(`Partition ${partition.identity.name} list values must be integers.`);
    }
    return `create table ${name} partition of ${parent} for values in (${values.join(", ")})`;
  }
  if (method === "hash") {
    const modulus = partition.definition.modulus;
    const remainder = partition.definition.remainder;
    if (modulus === undefined || remainder === undefined) {
      throw new CatalogError(`Partition ${partition.identity.name} needs modulus and remainder.`);
    }
    return `create table ${name} partition of ${parent} for values with (modulus ${String(modulus)}, remainder ${String(remainder)})`;
  }
  const from = partition.definition.from;
  const to = partition.definition.to;
  if (/^-?\d+$/.test(from) && /^-?\d+$/.test(to)) {
    return `create table ${name} partition of ${parent} for values from (${from}) to (${to})`;
  }
  if (!isTimestampLiteral(from) || !isTimestampLiteral(to)) {
    throw new CatalogError(
      `Partition ${partition.identity.name} bounds are not integers or timestamps.`,
    );
  }
  return `create table ${name} partition of ${parent} for values from (${quoteTimestamp(from)}) to (${quoteTimestamp(to)})`;
}

function isTimestampLiteral(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}$/.test(value);
}

function quoteTimestamp(value: string): string {
  return `'${value}'`;
}

function emitFunction(
  fn: Extract<CatalogObject, { kind: "function" }>,
  bindings: readonly NamespaceBinding[],
): string {
  const args = fn.definition.args.map((arg) => `${quoteIdent(arg.name)} ${arg.type}`).join(", ");
  const name = qualify(fn.identity.namespace, fn.identity.name, bindings);
  const volatility = fn.definition.volatility;
  const head = `create function ${name}(${args}) returns ${fn.definition.returns} language ${fn.definition.language} ${volatility}`;
  const body = bindSql(fn.definition.body, fn.identity.namespace, bindings);
  switch (fn.definition.bodyStyle) {
    case "string":
      if (body.includes("$okm$"))
        throw new CatalogError(`Function ${fn.identity.name} body contains $okm$.`);
      return `${head}\nas $okm$\n${body}\n$okm$`;
    case "return":
      return `${head}\nreturn ${body}`;
    case "atomic":
      return `${head}\nbegin atomic\n${body}\nend`;
    default:
      return assertNever(fn.definition.bodyStyle);
  }
}

function emitTrigger(
  trigger: Extract<CatalogObject, { kind: "trigger" }>,
  bindings: readonly NamespaceBinding[],
): string {
  const events = [...trigger.definition.events].sort().join(" or ");
  const table = qualify(trigger.identity.namespace, trigger.identity.parent, bindings);
  const fn = qualify(trigger.identity.namespace, trigger.definition.function, bindings);
  const args = trigger.definition.functionArgTypes.join(", ");
  const level = trigger.definition.level === "row" ? "row" : "statement";
  return `create trigger ${quoteIdent(trigger.identity.name)} ${trigger.definition.timing} ${events} on ${table} for each ${level} execute function ${fn}(${args})`;
}

function emitView(
  view: Extract<CatalogObject, { kind: "view" }>,
  bindings: readonly NamespaceBinding[],
): string {
  const name = qualify(view.identity.namespace, view.identity.name, bindings);
  const sql = bindSql(view.definition.sql, view.identity.namespace, bindings);
  return `create view ${name} as ${sql}`;
}

function emitMaterializedView(
  view: Extract<CatalogObject, { kind: "materialized_view" }>,
  bindings: readonly NamespaceBinding[],
): string {
  const name = qualify(view.identity.namespace, view.identity.name, bindings);
  const sql = bindSql(view.definition.sql, view.identity.namespace, bindings);
  const data = view.definition.withData ? "with data" : "with no data";
  return `create materialized view ${name} as ${sql} ${data}`;
}

function emitPolicy(
  policy: Extract<CatalogObject, { kind: "policy" }>,
  bindings: readonly NamespaceBinding[],
): string {
  const table = qualify(policy.identity.namespace, policy.identity.parent, bindings);
  const permissive = policy.definition.permissive ? "permissive" : "restrictive";
  const command = policy.definition.command;
  const using = policy.definition.using === "" ? "" : ` using (${policy.definition.using})`;
  const check = policy.definition.check === "" ? "" : ` with check (${policy.definition.check})`;
  return `create policy ${quoteIdent(policy.identity.name)} on ${table} as ${permissive} for ${command}${using}${check}`;
}

function grantTarget(grant: GrantObject, bindings: readonly NamespaceBinding[]): string {
  if (grant.identity.objectKind === "schema") {
    return `schema ${quoteIdent(concreteSchema(grant.identity.namespace, bindings))}`;
  }
  const relation = qualify(grant.identity.namespace, grant.identity.parent, bindings);
  return `${grant.identity.objectKind} ${relation}`;
}

function qualify(
  namespace: NamespaceName,
  name: string,
  bindings: readonly NamespaceBinding[],
): string {
  return `${quoteIdent(concreteSchema(namespace, bindings))}.${quoteIdent(name)}`;
}

function bindSql(
  sql: string,
  namespace: NamespaceName,
  bindings: readonly NamespaceBinding[],
): string {
  return sql.replaceAll(
    quoteIdent(namespace.name),
    quoteIdent(concreteSchema(namespace, bindings)),
  );
}

function concreteSchema(namespace: NamespaceName, bindings: readonly NamespaceBinding[]): string {
  const binding = bindings.find(
    (item) => item.logical.name === namespace.name && item.logical.template === namespace.template,
  );
  if (binding === undefined) throw new CatalogError(`No binding for namespace ${namespace.name}.`);
  if (!/^[a-z_][a-z0-9_]*$/.test(binding.concrete)) {
    throw new CatalogError(`Concrete schema ${binding.concrete} is not a plain identifier.`);
  }
  return binding.concrete;
}

function assertNever(value: never): never {
  throw new CatalogError(`Unexpected value ${JSON.stringify(value)}`);
}
