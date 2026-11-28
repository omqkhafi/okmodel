/**
 * SQL for a partition plan.
 *
 * A new parent uses `partition of`. A live parent uses a standalone table, a
 * validated check, and `attach partition`. Conversion does that to the existing
 * table inside one transaction. This module is not on the query path.
 */

import { identitySequenceName } from "../../contracts/catalog/identifier.js";
import type {
  Catalog,
  ColumnObject,
  ConstraintObject,
  IndexObject,
  PartitionChild,
  TableObject,
} from "../../contracts/catalog/types.js";
import type { StepKind } from "../step-class.js";
import {
  createIndexSql,
  createObjectSql,
  createTableSql,
  policyCreatePlan,
  qualify,
  quoteIdent,
} from "./ddl.js";
import { boundCheck, boundSql, childName } from "./partition-compile.js";
import { quoteLiteral } from "./quote.js";

/** One statement the lowering turns into a plan step. */
export type PartitionStatement = {
  readonly sql: string;
  readonly kind: StepKind;
  readonly lock: string;
  readonly transactional?: boolean;
  readonly weight?: "blocking";
};

const ACCESS = "ACCESS EXCLUSIVE";
const SHARE_UPDATE = "SHARE UPDATE EXCLUSIVE";
const CHECK = "okm_partition_bound";

/**
 * `partition of` statements for a parent this plan is creating.
 *
 * The parent is not live, so `partition of` does not take a lock anyone else holds.
 *
 * @param table - Parent being created
 * @param catalog - Catalog that holds its columns
 * @param schema - Concrete schema
 * @returns One statement per child. Empty when another tool owns the children
 */
export function newChildStatements(
  table: TableObject,
  catalog: Catalog,
  schema: string,
): readonly PartitionStatement[] {
  const partition = table.definition.partition;
  if (partition === undefined || partition.ownership === "external") return [];
  const dataType = keyType(table, catalog);
  const parent = qualify(schema, table.identity.name);
  return (partition.children ?? []).map((child) => ({
    sql: `create table ${qualify(schema, childName(table.identity.name, child.suffix))} partition of ${parent} ${boundSql(child.bound, dataType)}`,
    kind: "create-table" as const,
    lock: ACCESS,
  }));
}

/**
 * Standalone table, check, and attach for children of a parent that already exists.
 *
 * @param table - Live partitioned parent
 * @param catalog - Catalog that holds its columns
 * @param schema - Concrete schema
 * @param children - Children the declaration has and the database does not
 * @returns Statements in apply order
 */
export function liveAttachStatements(
  table: TableObject,
  catalog: Catalog,
  schema: string,
  children: readonly PartitionChild[],
): readonly PartitionStatement[] {
  const dataType = keyType(table, catalog);
  const parent = qualify(schema, table.identity.name);
  const relation = regclass(schema, table.identity.name);
  const types = keyTypes(table, catalog);
  const columns = table.definition.partition?.columns ?? [];
  const steps: PartitionStatement[] = [];
  for (const child of children) {
    const name = childName(table.identity.name, child.suffix);
    const qualified = qualify(schema, name);
    steps.push({
      sql: `create table ${qualified} (like ${parent} including defaults including constraints including indexes excluding identity)`,
      kind: "create-table",
      lock: ACCESS,
    });
    const check = boundCheck(columns, types, child.bound, relation);
    if (check !== "true") {
      steps.push({
        sql: `alter table ${qualified} add constraint ${quoteIdent(CHECK)} check (${check}) not valid`,
        kind: "add-constraint",
        lock: SHARE_UPDATE,
      });
      steps.push({
        sql: `alter table ${qualified} validate constraint ${quoteIdent(CHECK)}`,
        kind: "validate-constraint",
        lock: SHARE_UPDATE,
      });
    }
    steps.push({
      sql: `alter table ${parent} attach partition ${qualified} ${boundSql(child.bound, dataType)}`,
      kind: "attach-partition",
      lock: SHARE_UPDATE,
    });
    if (check !== "true") {
      steps.push({
        sql: `alter table ${qualified} drop constraint ${quoteIdent(CHECK)}`,
        kind: "drop-constraint",
        lock: SHARE_UPDATE,
      });
    }
  }
  return steps;
}

/**
 * Converts a plain table into the first declared partition.
 *
 * The first statement is a marker the apply runner counts before it begins a
 * transaction. Rows outside that partition refuse with OKM1932 and take no lock.
 *
 * @param table - Declared partitioned table
 * @param after - Catalog the declaration compiled
 * @param before - Catalog read from the plain table
 * @param schema - Concrete schema
 * @param attach - Child the existing rows must fit
 * @param others - Children created empty on the new parent
 * @returns The conversion, with the attach marked blocking
 */
export function conversionStatements(
  table: TableObject,
  after: Catalog,
  before: Catalog,
  schema: string,
  attach: PartitionChild,
  others: readonly PartitionChild[],
): readonly PartitionStatement[] {
  const name = table.identity.name;
  const temp = tempName(name);
  const child = childName(name, attach.suffix);
  const dataType = keyType(table, after);
  const types = keyTypes(table, after);
  const columns = table.definition.partition?.columns ?? [];
  const check = boundCheck(columns, types, attach.bound, regclass(schema, temp));
  const outside =
    attach.bound.kind === "default"
      ? "false"
      : attach.bound.kind === "hash"
        ? "true"
        : `not (${check})`;
  const marker = `/* okm-partition-rows ${qualify(schema, name)} | ${outside} */ `;
  const steps: PartitionStatement[] = [];
  let marked = false;
  const mark = (statement: PartitionStatement): PartitionStatement => {
    if (marked) return statement;
    marked = true;
    return { ...statement, sql: `${marker}${statement.sql}` };
  };
  for (const index of indexesOf(before, name)) {
    steps.push({
      sql: `alter index ${qualify(schema, index.identity.name)} rename to ${quoteIdent(renamed(child, index.identity.name))}`,
      kind: "rename-index",
      lock: SHARE_UPDATE,
    });
  }
  for (const constraint of constraintsOf(before, name)) {
    if (constraint.definition.constraintKind === "check") continue;
    steps.push({
      sql: `alter table ${qualify(schema, name)} rename constraint ${quoteIdent(constraint.identity.name)} to ${quoteIdent(renamed(child, constraint.identity.name))}`,
      kind: "rename-constraint",
      lock: ACCESS,
    });
  }
  for (const column of identityColumns(before, name)) {
    steps.push({
      sql: `alter table ${qualify(schema, name)} alter column ${quoteIdent(column.identity.name)} drop identity`,
      kind: "drop-identity",
      lock: ACCESS,
    });
  }
  const created = createTableSql(table, after, schema).replace(
    qualify(schema, name),
    qualify(schema, temp),
  );
  steps.push(mark({ sql: created, kind: "create-table", lock: ACCESS }));
  for (const index of indexesOf(before, name)) {
    const sql = createIndexSql(index, schema)
      .replace(qualify(schema, name), qualify(schema, temp))
      .replace(` on ${qualify(schema, temp)}`, ` on only ${qualify(schema, temp)}`);
    steps.push({ sql, kind: "create-index", lock: SHARE_UPDATE });
  }
  const attached = qualify(schema, name);
  if (check !== "true") {
    steps.push({
      sql: `alter table ${attached} add constraint ${quoteIdent(CHECK)} check (${check}) not valid`,
      kind: "add-constraint",
      lock: SHARE_UPDATE,
    });
    steps.push({
      sql: `alter table ${attached} validate constraint ${quoteIdent(CHECK)}`,
      kind: "validate-constraint",
      lock: SHARE_UPDATE,
    });
  }
  steps.push({
    sql: `alter table ${qualify(schema, temp)} attach partition ${attached} ${boundSql(attach.bound, dataType)}`,
    kind: "attach-partition",
    lock: ACCESS,
    weight: "blocking",
  });
  for (const other of others) {
    steps.push({
      sql: `create table ${qualify(schema, childName(name, other.suffix))} partition of ${qualify(schema, temp)} ${boundSql(other.bound, dataType)}`,
      kind: "create-table",
      lock: ACCESS,
    });
  }
  steps.push({
    sql: `alter table ${attached} rename to ${quoteIdent(child)}`,
    kind: "rename-table",
    lock: ACCESS,
  });
  steps.push({
    sql: `alter table ${qualify(schema, temp)} rename to ${quoteIdent(name)}`,
    kind: "rename-table",
    lock: ACCESS,
  });
  for (const column of identityColumns(after, name)) {
    const born = identitySequenceName(temp, column.identity.name);
    const want = identitySequenceName(name, column.identity.name);
    steps.push({
      sql: `alter sequence ${qualify(schema, born)} rename to ${quoteIdent(want)}`,
      kind: "rename-sequence",
      lock: ACCESS,
    });
    const qualified = qualify(schema, want);
    const max = `(select max(${quoteIdent(column.identity.name)}) from ${qualify(schema, name)})`;
    steps.push({
      sql: `select setval(${quoteLiteral(qualified)}, coalesce(${max}, 1), ${max} is not null)`,
      kind: "alter-sequence",
      lock: "ACCESS SHARE",
    });
  }
  if (check !== "true") {
    steps.push({
      sql: `alter table ${qualify(schema, child)} drop constraint ${quoteIdent(CHECK)}`,
      kind: "drop-constraint",
      lock: SHARE_UPDATE,
    });
  }
  steps.push(...moveDependents(before, schema, name, child));
  return steps;
}

/**
 * `create index on only` plus one concurrent index per child, then attach.
 *
 * @param index - Parent index
 * @param schema - Concrete schema
 * @param children - Child table names
 * @returns The parent index, then each child index and its attach
 */
export function partitionedIndexStatements(
  index: IndexObject,
  schema: string,
  children: readonly string[],
): readonly PartitionStatement[] {
  const parentSql = createIndexSql(index, schema).replace(
    ` on ${qualify(schema, index.identity.parent.name)}`,
    ` on only ${qualify(schema, index.identity.parent.name)}`,
  );
  const steps: PartitionStatement[] = [
    { sql: parentSql, kind: "create-index", lock: SHARE_UPDATE },
  ];
  for (const child of children) {
    const indexName = renamed(child, index.identity.name);
    const sql = createIndexSql(index, schema)
      .replace(quoteIdent(index.identity.name), quoteIdent(indexName))
      .replace(qualify(schema, index.identity.parent.name), qualify(schema, child))
      .replace(/^create unique index /i, "create unique index concurrently ")
      .replace(/^create index /i, "create index concurrently ");
    steps.push({
      sql,
      kind: "create-index",
      lock: SHARE_UPDATE,
      transactional: false,
    });
    steps.push({
      sql: `alter index ${qualify(schema, index.identity.name)} attach partition ${qualify(schema, indexName)}`,
      kind: "attach-partition",
      lock: SHARE_UPDATE,
    });
  }
  return steps;
}

function moveDependents(
  before: Catalog,
  schema: string,
  parent: string,
  child: string,
): readonly PartitionStatement[] {
  const steps: PartitionStatement[] = [];
  const table = before.objects.find(
    (object): object is TableObject => object.kind === "table" && object.identity.name === parent,
  );
  if (table?.definition.rowSecurity?.enable === true) {
    steps.push({
      sql: `alter table ${qualify(schema, parent)} enable row level security`,
      kind: "enable-rls",
      lock: SHARE_UPDATE,
    });
    if (table.definition.rowSecurity.force) {
      steps.push({
        sql: `alter table ${qualify(schema, parent)} force row level security`,
        kind: "enable-rls",
        lock: SHARE_UPDATE,
      });
    }
    steps.push({
      sql: `alter table ${qualify(schema, child)} disable row level security`,
      kind: "disable-rls",
      lock: SHARE_UPDATE,
    });
  }
  if (table?.comment !== undefined) {
    steps.push({
      sql: `comment on table ${qualify(schema, parent)} is ${quoteLiteral(table.comment)}`,
      kind: "comment",
      lock: SHARE_UPDATE,
    });
  }
  for (const object of before.objects) {
    if (
      object.kind === "column" &&
      object.identity.parent.name === parent &&
      object.comment !== undefined
    ) {
      steps.push({
        sql: `comment on column ${qualify(schema, parent)}.${quoteIdent(object.identity.name)} is ${quoteLiteral(object.comment)}`,
        kind: "comment",
        lock: SHARE_UPDATE,
      });
    }
    if (object.kind === "policy" && object.identity.parent.name === parent) {
      for (const planned of policyCreatePlan(object, schema)) {
        steps.push({ sql: planned.sql, kind: planned.kind, lock: SHARE_UPDATE });
      }
      steps.push({
        sql: `drop policy ${quoteIdent(object.identity.name)} on ${qualify(schema, child)}`,
        kind: "drop-policy",
        lock: SHARE_UPDATE,
      });
    }
    if (object.kind === "trigger" && object.identity.parent.name === parent) {
      const sql = createObjectSql(object, schema);
      if (sql !== undefined) steps.push({ sql, kind: "create-trigger", lock: SHARE_UPDATE });
      steps.push({
        sql: `drop trigger ${quoteIdent(object.identity.name)} on ${qualify(schema, child)}`,
        kind: "drop-trigger",
        lock: SHARE_UPDATE,
      });
    }
  }
  return steps;
}

function keyType(table: TableObject, catalog: Catalog): string {
  return keyTypes(table, catalog)[0] ?? "text";
}

function keyTypes(table: TableObject, catalog: Catalog): readonly string[] {
  const names = table.definition.partition?.columns ?? [];
  return names.map((name) => {
    const column = catalog.objects.find(
      (object): object is ColumnObject =>
        object.kind === "column" &&
        object.identity.parent.name === table.identity.name &&
        object.identity.name === name,
    );
    return column?.definition.dataType ?? "text";
  });
}

function indexesOf(catalog: Catalog, table: string): readonly IndexObject[] {
  return catalog.objects.filter(
    (object): object is IndexObject =>
      object.kind === "index" && object.identity.parent.name === table,
  );
}

function constraintsOf(catalog: Catalog, table: string): readonly ConstraintObject[] {
  return catalog.objects.filter(
    (object): object is ConstraintObject =>
      object.kind === "constraint" && object.identity.parent.name === table,
  );
}

function identityColumns(catalog: Catalog, table: string): readonly ColumnObject[] {
  return catalog.objects.filter(
    (object): object is ColumnObject =>
      object.kind === "column" &&
      object.identity.parent.name === table &&
      object.definition.identity !== undefined,
  );
}

function regclass(schema: string, table: string): string {
  return `${quoteLiteral(`${quoteIdent(schema)}.${quoteIdent(table)}`)}::regclass`;
}

function tempName(table: string): string {
  const name = `${table.slice(0, 54)}__okm_p`;
  return name.length > 63 ? name.slice(0, 63) : name;
}

function renamed(prefix: string, name: string): string {
  const joined = `${prefix}_${name}`;
  return joined.length > 63 ? joined.slice(0, 63) : joined;
}
