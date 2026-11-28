/**
 * Constraint and index names `schema()` already knows, without the catalog compiler.
 *
 * Mapped database errors, `sync`, and the unindexed-computed warning read this
 * index. A featureless app never loads `catalog-compile.ts` for those paths.
 * The full document stays on the first `.catalog` read and on drift when no
 * artifact hash is available.
 */

import type { ConstraintInput, IndexInput } from "../../contracts/catalog/object.js";
import { deterministicName, fitIdentifier } from "../../contracts/catalog/identifier.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import type { CatalogCompileInput, CompileTable } from "./catalog-draft.js";

/**
 * One constraint or index the error mapper can name.
 *
 * `name` is the SQL name Postgres reports. `nameKey` is the declared reason.
 */
export type ConstraintRow = {
  readonly table: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly nameKey: string;
  readonly kind: "constraint" | "index";
  /** An expression index. The warning then stays silent for that table. */
  readonly expression: boolean;
  readonly constraintKind?: ConstraintInput["constraintKind"];
};

type ColumnStateFacts = {
  readonly nullable: boolean;
  readonly defaultSql: string | undefined;
  readonly identity: unknown;
  readonly generated: unknown;
  readonly seriesDraft: unknown;
  readonly unique: unknown;
  readonly picklist: { readonly check: boolean } | undefined;
};

type Facts = {
  readonly rows: readonly ConstraintRow[];
  readonly omit: ReadonlySet<string>;
  readonly input: CatalogCompileInput;
};

const facts = new WeakMap<object, Facts>();

/**
 * Stores the index for one `schema()` result.
 *
 * The key is the object `schema()` returns. A later read does not compile the catalog.
 *
 * @param schema - The object `schema()` returns
 * @param input - Descriptors captured while the query model was built
 */
export function rememberSchemaFacts(schema: object, input: CatalogCompileInput): void {
  const rows: ConstraintRow[] = [];
  const omit = new Set<string>();
  for (const item of input.prepared) collectTable(rows, omit, item);
  for (const foreignKey of input.foreignKeys)
    pushConstraint(rows, foreignKey.parent.name, foreignKey);
  facts.set(schema, { rows, omit, input });
}

/**
 * Rows for a schema `rememberSchemaFacts` stored.
 *
 * @param schema - The object passed to `connect` or `mapPostgresError`
 * @returns The rows, or `undefined` when this object is not a `schema()` result
 */
export function constraintRows(schema: object): readonly ConstraintRow[] | undefined {
  return facts.get(schema)?.rows;
}

/**
 * Whether a column can be left out of an insert because the database fills it.
 *
 * @param schema - The connected schema
 * @param table - SQL table name
 * @param column - SQL column name
 * @returns `true` or `false` when the schema was registered, otherwise `undefined`
 */
export function columnOmissible(
  schema: object,
  table: string,
  column: string,
): boolean | undefined {
  const held = facts.get(schema);
  if (held === undefined) return undefined;
  return held.omit.has(`${table}\0${column}`);
}

/**
 * Descriptors drift compiles when no artifact hash is available.
 *
 * @param schema - The connected schema
 * @returns The compile input, or `undefined` when the schema was not registered
 */
export function compileInputOf(schema: object): CatalogCompileInput | undefined {
  return facts.get(schema)?.input;
}

/**
 * A catalog stored as a data property, not the lazy `schema().catalog` getter.
 *
 * Reading the getter loads the compiler. Callers that already hold a catalog
 * object, such as a test fixture, keep that path.
 *
 * @param schema - Object that may carry `catalog`
 * @returns The catalog, or `undefined` when the property is a getter or absent
 */
export function dataCatalog(schema: object): Catalog | undefined {
  const desc = Object.getOwnPropertyDescriptor(schema, "catalog");
  if (desc === undefined || typeof desc.get === "function") return undefined;
  const value: unknown = desc.value;
  if (typeof value !== "object" || value === null || !("objects" in value)) return undefined;
  return value as Catalog;
}

function collectTable(rows: ConstraintRow[], omit: Set<string>, item: CompileTable): void {
  for (const column of item.columns) {
    const state = column.state as ColumnStateFacts;
    if (
      state.nullable ||
      state.defaultSql !== undefined ||
      state.identity !== undefined ||
      state.generated !== undefined ||
      state.seriesDraft !== undefined
    ) {
      omit.add(`${item.sqlName}\0${column.sqlName}`);
    }
    if (state.unique !== undefined) {
      pushConstraint(rows, item.sqlName, {
        parent: item.parent,
        constraintKind: "unique",
        columns: [column.sqlName],
        nameKey: column.sqlName,
        provenance: column.provenance,
      });
    }
    if (state.picklist?.check === true) {
      pushConstraint(rows, item.sqlName, {
        parent: item.parent,
        constraintKind: "check",
        columns: [column.sqlName],
        nameKey: column.sqlName,
        provenance: column.provenance,
      });
    }
  }
  if (item.primaryKey !== undefined) pushConstraint(rows, item.sqlName, item.primaryKey);
  for (const exclusion of item.exclusions) pushConstraint(rows, item.sqlName, exclusion);
  for (const unique of item.namedUniques) pushConstraint(rows, item.sqlName, unique);
  for (const index of item.indexes) pushIndex(rows, item.sqlName, index);
  for (const check of item.checks) pushConstraint(rows, item.sqlName, check.input);
}

function pushConstraint(rows: ConstraintRow[], parent: string, input: ConstraintInput): void {
  const columns = [...(input.columns ?? [])];
  const fallback = input.constraintKind === "primaryKey" ? "pkey" : columns.join("_");
  const nameKey =
    input.nameKey !== undefined && input.nameKey.length > 0 ? input.nameKey : fallback;
  const name =
    input.name === undefined
      ? deterministicName({
          parent,
          purpose: input.constraintKind,
          nameKey: input.constraintKind === "check" ? nameKey : fallback,
        })
      : fitIdentifier(input.name);
  rows.push({
    table: parent,
    name,
    columns,
    nameKey,
    kind: "constraint",
    expression: false,
    constraintKind: input.constraintKind,
  });
}

function pushIndex(rows: ConstraintRow[], parent: string, input: IndexInput): void {
  const columns = [...(input.columns ?? [])];
  const nameKey = input.nameKey ?? (columns.length > 0 ? columns.join("_") : "expr");
  const name =
    input.name === undefined
      ? deterministicName({ parent, purpose: "index", nameKey })
      : input.name;
  rows.push({
    table: parent,
    name,
    columns,
    nameKey,
    kind: "index",
    expression: input.expression !== undefined,
  });
}
