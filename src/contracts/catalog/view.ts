/**
 * View and materialized view catalog objects.
 *
 * The factories store the record. They do not plan SQL. DDL stays in the
 * dialect, and `view()` / `materializedView()` stay on `okmodel/view`.
 */

import { catalogError } from "../error.js";
import { assertIdentifier, deterministicName, fitIdentifier } from "./identifier.js";
import { assertNamespace, staticNamespace } from "./identity.js";
import { assertProvenance, normaliseEdges } from "./object.js";
import type {
  IndexObject,
  MaterializedViewDefinition,
  MaterializedViewObject,
  Namespace,
  ObjectIdentity,
  ObjectRef,
  Owner,
  Provenance,
  ViewColumn,
  ViewDefinition,
  ViewObject,
} from "./types.js";

/** Input for {@link viewObject}. */
export type ViewInput = {
  readonly namespace?: Namespace;
  readonly name: string;
  readonly columns: readonly ViewColumn[];
  readonly query: string;
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
};

/** Input for {@link materializedViewObject}. */
export type MaterializedViewInput = ViewInput & {
  readonly refresh?: "concurrently";
};

/** Input for {@link materializedViewIndex}. */
export type MaterializedViewIndexInput = {
  readonly parent: ObjectRef;
  readonly name?: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
  readonly nameKey?: string;
  readonly expression?: string;
  readonly predicate?: string;
  readonly owner?: Owner;
  readonly provenance: Provenance;
  /** Retargeted edges. Omitted edges depend on the materialized view. */
  readonly dependencies?: readonly ObjectIdentity[];
};

/**
 * Trims a view query and drops one trailing semicolon.
 *
 * `pg_get_viewdef` and the author's SQL both go through this before they are
 * stored, so two reads of the same reprint compare equal.
 *
 * @param query - Author SQL or a server reprint
 * @returns The stored query text
 */
export function normaliseViewQuery(query: string): string {
  return query.trim().replace(/;\s*$/, "");
}

/**
 * Builds a view record.
 *
 * Identity is `(namespace, name)`. Columns stay in declaration order.
 *
 * @param input - Columns, query, and dependency edges
 * @returns The catalog object
 */
export function viewObject(input: ViewInput): ViewObject {
  const namespace = input.namespace ?? staticNamespace("public");
  const columns = readColumns(input.name, input.columns);
  const query = readQuery(input.name, input.query);
  assertNamespace(namespace);
  assertProvenance(input.provenance);
  const definition: ViewDefinition = { columns, query };
  return {
    kind: "view",
    identity: { kind: "view", namespace, name: input.name },
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges(input.dependencies ?? []),
    provenance: input.provenance,
  };
}

/**
 * Builds a materialized view record.
 *
 * `refresh` is stored only for `"concurrently"`. The object has no replace.
 *
 * @param input - Columns, query, populate mode, and dependency edges
 * @returns The catalog object
 */
export function materializedViewObject(input: MaterializedViewInput): MaterializedViewObject {
  const namespace = input.namespace ?? staticNamespace("public");
  const columns = readColumns(input.name, input.columns);
  const query = readQuery(input.name, input.query);
  assertNamespace(namespace);
  assertProvenance(input.provenance);
  const definition: MaterializedViewDefinition = {
    columns,
    query,
    ...(input.refresh === "concurrently" ? { refresh: "concurrently" as const } : {}),
  };
  return {
    kind: "materializedView",
    identity: { kind: "materializedView", namespace, name: input.name },
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges(input.dependencies ?? []),
    provenance: input.provenance,
  };
}

/**
 * Builds an index owned by a materialized view.
 *
 * The edge points at the view, not at a table. View output columns are not
 * catalog objects, so the index does not depend on column identities.
 *
 * @param input - Parent view, columns, and uniqueness
 * @returns An index envelope
 */
export function materializedViewIndex(input: MaterializedViewIndexInput): IndexObject {
  assertNamespace(input.parent.namespace);
  assertIdentifier(input.parent.name, "index parent");
  assertProvenance(input.provenance);
  const columns = [...input.columns];
  for (const name of columns) assertIdentifier(name, "index column");
  if (columns.length === 0 && input.expression === undefined) {
    catalogError("OKM1020", `Index on ${input.parent.name} needs a column or an expression.`);
  }
  const nameKey = input.nameKey ?? (columns.length > 0 ? columns.join("_") : "expr");
  const name =
    input.name === undefined
      ? deterministicName({ parent: input.parent.name, purpose: "index", nameKey })
      : fitIdentifier(input.name);
  const parentView: ObjectIdentity = {
    kind: "materializedView",
    namespace: input.parent.namespace,
    name: input.parent.name,
  };
  return {
    kind: "index",
    identity: { kind: "index", parent: input.parent, name },
    owner: input.owner ?? "managed",
    definition: {
      columns,
      unique: input.unique === true,
      nameKey,
      ...(input.expression !== undefined ? { expression: input.expression } : {}),
      ...(input.predicate !== undefined ? { predicate: input.predicate } : {}),
    },
    dependencies: normaliseEdges(input.dependencies ?? [parentView]),
    provenance: input.provenance,
  };
}

function readColumns(view: string, columns: readonly ViewColumn[]): readonly ViewColumn[] {
  assertIdentifier(view, "view");
  if (columns.length === 0) catalogError("OKM1020", `View ${view} needs a column.`);
  const seen = new Set<string>();
  return columns.map((column) => {
    assertIdentifier(column.name, `view ${view} column`);
    if (seen.has(column.name)) {
      catalogError("OKM1020", `View ${view} lists column ${column.name} twice.`);
    }
    seen.add(column.name);
    if (column.dataType.length === 0 || /[;'"\\]/.test(column.dataType)) {
      catalogError("OKM1020", `View ${view} column ${column.name} type is not a type name.`);
    }
    return { name: column.name, dataType: column.dataType };
  });
}

function readQuery(view: string, query: string): string {
  const text = normaliseViewQuery(query);
  if (text.length === 0) catalogError("OKM1020", `View ${view} needs a query.`);
  return text;
}
