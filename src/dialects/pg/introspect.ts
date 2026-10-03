/**
 * Reads a Postgres schema into a catalog.
 *
 * Copied partition primary keys and inherited indexes are not objects: a
 * relation that is a child in `pg_inherits` is skipped, and so is an index
 * that is itself inherited (M0-06). Expressions come back from `pg_get_expr`
 * and `pg_get_constraintdef`, which is the database's normalised text (D128).
 */

import { catalog } from "../../contracts/catalog/build.js";
import { enumType } from "../../contracts/catalog/enum.js";
import { staticNamespace } from "../../contracts/catalog/identity.js";
import { column, constraint, index, sequence, table } from "../../contracts/catalog/object.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ObjectIdentity,
  ObjectRef,
  Provenance,
  ReferentialAction,
} from "../../contracts/catalog/types.js";
import { referentialAction } from "../../contracts/catalog/types.js";

/** A connection that can run one query. Parameters are `$1`, `$2`, … */
export type CatalogQuery = {
  /**
   * Runs one query.
   *
   * @param text - SQL
   * @param params - Bound parameters
   * @returns Rows as objects keyed by the select aliases
   */
  query(text: string, params?: readonly string[]): Promise<readonly Record<string, unknown>[]>;
};

const PROVENANCE_NAME = "database";

/**
 * Introspects one concrete schema.
 *
 * Identities use `logical`, not the concrete schema name, so two scratch
 * schemas compare. The default logical namespace is `public`.
 *
 * @param runner - Database connection
 * @param concrete - Schema to read
 * @param logical - Namespace stored on the catalog identities
 * @returns A checked catalog
 */
export async function introspectSchema(
  runner: CatalogQuery,
  concrete: string,
  logical = "public",
): Promise<Catalog> {
  const namespace = staticNamespace(logical);
  const provenance: Provenance = { origin: "file", name: PROVENANCE_NAME };
  const params = [concrete];
  const [tables, columns, constraints, indexes, sequences, enums] = await Promise.all([
    runner.query(TABLES, params),
    runner.query(COLUMNS, params),
    runner.query(CONSTRAINTS, params),
    runner.query(INDEXES, params),
    runner.query(SEQUENCES, params),
    runner.query(ENUMS, params),
  ]);
  const objects: CatalogObject[] = [];
  const parents = new Map<string, ObjectRef>();
  for (const row of tables) {
    const name = text(row, "name");
    const parent: ObjectRef = { namespace, name };
    parents.set(name, parent);
    const method = partitionMethod(text(row, "partstrat"));
    const partColumns = list(text(row, "partcols"));
    objects.push(
      table({
        namespace,
        name,
        provenance,
        ...(method === undefined || partColumns.length === 0
          ? {}
          : { partition: { method, columns: partColumns } }),
      }),
    );
  }
  const sequenceIdentity = new Map<string, ObjectIdentity>();
  for (const row of sequences) {
    const name = text(row, "name");
    const dataType = sequenceType(text(row, "type"));
    const ownedTable = text(row, "owned_table");
    const dependencies: ObjectIdentity[] = [];
    if (ownedTable.length > 0) {
      dependencies.push({ kind: "table", namespace, name: ownedTable });
    }
    const built = sequence({
      namespace,
      name,
      dataType,
      start: numberText(row, "start"),
      increment: numberText(row, "increment"),
      cycle: flag(row, "cycle"),
      provenance,
      ...(dependencies.length > 0 ? { dependencies } : {}),
    });
    sequenceIdentity.set(name, built.identity);
    objects.push(built);
  }
  const enumLabels = new Map<string, string[]>();
  for (const row of enums) {
    const name = text(row, "name");
    const labels = enumLabels.get(name) ?? [];
    labels.push(text(row, "label"));
    enumLabels.set(name, labels);
  }
  for (const [name, labels] of enumLabels) {
    objects.push(enumType({ namespace, name, labels, provenance }));
  }
  for (const row of columns) {
    const parentName = text(row, "parent");
    const parent = parents.get(parentName) ?? { namespace, name: parentName };
    const identity = text(row, "identity");
    const generated = text(row, "generated") === "s";
    const expression = text(row, "expression");
    const sequenceName = text(row, "sequence");
    const dataType = text(row, "type");
    const extra: ObjectIdentity[] = [];
    const owned = sequenceIdentity.get(sequenceName);
    if (owned !== undefined) extra.push(owned);
    if (enumLabels.has(dataType)) {
      extra.push({ kind: "type", namespace, name: dataType });
    }
    const built: ColumnObject = column({
      parent,
      name: text(row, "name"),
      dataType,
      nullable: !flag(row, "not_null"),
      provenance,
      ...(extra.length > 0 ? { dependencies: extra } : {}),
      ...(identity === "a" || identity === "d" ? { identity: { always: identity === "a" } } : {}),
      ...(generated ? { generated: { stored: true, expression } } : {}),
      ...(!generated && identity !== "a" && identity !== "d" && expression.length > 0
        ? { defaultExpression: expression }
        : {}),
    });
    objects.push(built);
  }
  for (const row of constraints) {
    const parentName = text(row, "parent");
    const parent = parents.get(parentName) ?? { namespace, name: parentName };
    const kind = constraintKind(text(row, "contype"));
    const columns = list(text(row, "columns"));
    const expression = kind === "check" ? checkExpression(text(row, "definition")) : "";
    const refTable = text(row, "ref_table");
    const refColumns = list(text(row, "ref_columns"));
    const definition = text(row, "definition");
    const onDelete = actionAfter(definition, "delete");
    const onUpdate = actionAfter(definition, "update");
    objects.push(
      constraint({
        parent,
        constraintKind: kind,
        name: text(row, "name"),
        nameKey: columns.length > 0 ? columns.join("_") : "check",
        columns,
        provenance,
        deferrable: flag(row, "deferrable"),
        initially: flag(row, "deferred") ? "deferred" : "immediate",
        nullsNotDistinct: /nulls not distinct/i.test(definition),
        ...(expression.length > 0 ? { expression } : {}),
        ...(refTable.length > 0
          ? {
              references: {
                parent: { namespace, name: refTable },
                columns: refColumns,
                ...(onDelete !== undefined ? { onDelete } : {}),
                ...(onUpdate !== undefined ? { onUpdate } : {}),
              },
            }
          : {}),
      }),
    );
  }
  for (const row of indexes) {
    const parentName = text(row, "parent");
    const parent = parents.get(parentName) ?? { namespace, name: parentName };
    const columns = list(text(row, "columns"));
    const expression = text(row, "expression");
    const predicate = text(row, "predicate");
    objects.push(
      index({
        parent,
        name: text(row, "name"),
        nameKey: columns.length > 0 ? columns.join("_") : "expr",
        columns,
        unique: flag(row, "is_unique"),
        provenance,
        ...(expression.length > 0 ? { expression } : {}),
        ...(predicate.length > 0 ? { predicate } : {}),
      }),
    );
  }
  return catalog(objects);
}

/**
 * Applies one expression as a check and reads Postgres's reprint.
 *
 * Two authoring spellings of the same predicate compare equal after this.
 * A different predicate does not.
 *
 * @param runner - Database connection
 * @param expression - Check expression without the `CHECK` keyword
 * @returns The reprinted expression, without the `CHECK` keyword
 */
export async function reprintCheck(runner: CatalogQuery, expression: string): Promise<string> {
  await runner.query("drop table if exists okm_expr");
  await runner.query("create table okm_expr (id integer, title text)");
  await runner.query(`alter table okm_expr add constraint okm_expr_check check (${expression})`);
  const rows = await runner.query(
    "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'okm_expr_check'",
  );
  await runner.query("drop table okm_expr");
  return checkExpression(text(rows[0] ?? {}, "definition"));
}

const CHILD = "not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)";

const TABLES = `
  select c.relname as name, pt.partstrat as partstrat,
    (
      select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
      from unnest(pt.partattrs) with ordinality as cols(attnum, ord)
      join pg_attribute a on a.attrelid = c.oid and a.attnum = cols.attnum
    ) as partcols
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_partitioned_table pt on pt.partrelid = c.oid
  where n.nspname = $1
    and c.relkind in ('r', 'p')
    and ${CHILD}
`;

const COLUMNS = `
  select c.relname as parent, a.attname as name,
    case
      when ty.typtype = 'e' and ty.typnamespace = n.oid then ty.typname
      else format_type(a.atttypid, a.atttypmod)
    end as type,
    a.attnotnull as not_null, a.attidentity as identity, a.attgenerated as generated,
    pg_get_expr(ad.adbin, ad.adrelid) as expression,
    (
      select owned.relname
      from pg_depend d
      join pg_class owned on owned.oid = d.objid and owned.relkind = 'S'
      where d.refobjid = c.oid and d.refobjsubid = a.attnum and d.deptype = 'a'
        and d.classid = 'pg_class'::regclass
      limit 1
    ) as sequence
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  join pg_type ty on ty.oid = a.atttypid
  left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
  where n.nspname = $1
    and c.relkind in ('r', 'p')
    and ${CHILD}
`;

const CONSTRAINTS = `
  select rel.relname as parent, con.conname as name, con.contype as contype,
    con.condeferrable as deferrable, con.condeferred as deferred,
    pg_get_constraintdef(con.oid) as definition,
    (
      select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
      from unnest(con.conkey) with ordinality as cols(attnum, ord)
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = cols.attnum
    ) as columns,
    ref.relname as ref_table,
    (
      select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
      from unnest(con.confkey) with ordinality as cols(attnum, ord)
      join pg_attribute a on a.attrelid = con.confrelid and a.attnum = cols.attnum
    ) as ref_columns
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
  left join pg_class ref on ref.oid = con.confrelid
  where n.nspname = $1
    and con.contype in ('p', 'u', 'f', 'c')
    and not exists (select 1 from pg_inherits i where i.inhrelid = rel.oid)
`;

const INDEXES = `
  select tbl.relname as parent, idx.relname as name, i.indisunique as is_unique,
    (
      select coalesce(string_agg(a.attname, ',' order by cols.ord), '')
      from unnest(i.indkey) with ordinality as cols(attnum, ord)
      join pg_attribute a on a.attrelid = tbl.oid and a.attnum = cols.attnum
      where cols.attnum > 0
    ) as columns,
    pg_get_expr(i.indexprs, i.indrelid) as expression,
    pg_get_expr(i.indpred, i.indrelid) as predicate
  from pg_index i
  join pg_class idx on idx.oid = i.indexrelid
  join pg_class tbl on tbl.oid = i.indrelid
  join pg_namespace n on n.oid = tbl.relnamespace
  where n.nspname = $1
    and not i.indisprimary
    and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
    and not exists (select 1 from pg_inherits inh where inh.inhrelid = tbl.oid)
    and not exists (select 1 from pg_inherits inh where inh.inhrelid = idx.oid)
`;

const ENUMS = `
  select t.typname as name, e.enumlabel as label
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  join pg_enum e on e.enumtypid = t.oid
  where n.nspname = $1
    and t.typtype = 'e'
  order by t.typname, e.enumsortorder
`;

const SEQUENCES = `
  select c.relname as name, format_type(s.seqtypid, null) as type,
    s.seqstart::text as start, s.seqincrement::text as increment, s.seqcycle as cycle,
    (
      select owned.relname
      from pg_depend d
      join pg_class owned on owned.oid = d.refobjid and owned.relkind in ('r', 'p')
      where d.objid = c.oid and d.deptype = 'a'
      limit 1
    ) as owned_table
  from pg_sequence s
  join pg_class c on c.oid = s.seqrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1
`;

function partitionMethod(value: string): "range" | "list" | "hash" | undefined {
  if (value === "r") return "range";
  if (value === "l") return "list";
  if (value === "h") return "hash";
  return undefined;
}

function constraintKind(value: string): "primaryKey" | "unique" | "foreignKey" | "check" {
  if (value === "p") return "primaryKey";
  if (value === "u") return "unique";
  if (value === "f") return "foreignKey";
  return "check";
}

function sequenceType(value: string): "smallint" | "integer" | "bigint" {
  if (value === "smallint") return "smallint";
  if (value === "integer") return "integer";
  return "bigint";
}

function checkExpression(definition: string): string {
  return definition.trim().replace(/^check\s+/i, "");
}

function actionAfter(
  definition: string,
  event: "delete" | "update",
): ReferentialAction | undefined {
  const match = new RegExp(`on ${event} ([a-z ]+)`, "i").exec(definition);
  const words = match?.[1]?.trim().toLowerCase() ?? "";
  if (words.length === 0 || words === "no action") return undefined;
  return referentialAction(words);
}

function list(value: string): string[] {
  if (value.length === 0) return [];
  return value.split(",");
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function numberText(row: Record<string, unknown>, key: string): string {
  const value = text(row, key);
  return value.length === 0 ? "1" : value;
}

function flag(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  return value === true || value === "true" || value === "t";
}
