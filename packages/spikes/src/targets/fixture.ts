/**
 * A small catalog the target spike migrates and provisions.
 *
 * Two versions: `items(id, name)` and the same table plus `note`. The P07
 * planner turns one into the other. Snapshots are `renderCatalog` of head.
 */

import type {
  CatalogObject,
  NamespaceName,
  ObjectIdentity,
  Provenance,
} from "../catalog/object.js";

const provenance: Provenance = { source: "spike" };

/**
 * Catalog with `items(id, name)` and a primary key.
 *
 * @param namespace - Logical namespace, static or `tenant_{id}`
 * @returns Managed objects
 */
export function itemsCatalog(namespace: NamespaceName): readonly CatalogObject[] {
  return tableWithColumns(namespace, ["id", "name"]);
}

/**
 * Catalog with `items(id, name, note)`.
 *
 * @param namespace - Logical namespace
 * @returns Managed objects
 */
export function itemsCatalogWithNote(namespace: NamespaceName): readonly CatalogObject[] {
  return tableWithColumns(namespace, ["id", "name", "note"]);
}

function tableWithColumns(
  namespace: NamespaceName,
  columns: readonly string[],
): readonly CatalogObject[] {
  const tableId: ObjectIdentity = { kind: "table", namespace, name: "items" };
  const table: CatalogObject = {
    kind: "table",
    identity: tableId,
    owner: "managed",
    definition: { rowSecurity: false },
    dependencies: [],
    provenance,
  };
  const columnObjects = columns.map((name): CatalogObject => {
    return {
      kind: "column",
      identity: { kind: "column", namespace, parent: "items", name },
      owner: "managed",
      definition: { type: name === "id" ? "int8" : "text", nullable: false },
      dependencies: [{ identity: tableId }],
      provenance,
    };
  });
  const primaryKey: CatalogObject = {
    kind: "constraint",
    identity: { kind: "constraint", namespace, parent: "items", name: "items_pkey" },
    owner: "managed",
    definition: {
      constraintKind: "primary_key",
      columns: ["id"],
      deferrable: false,
      initially: "immediate",
      nullsNotDistinct: false,
    },
    dependencies: [{ identity: tableId }],
    provenance,
  };
  return [table, ...columnObjects, primaryKey];
}

/**
 * `roles(id, label)` for `reference` rows.
 *
 * @param namespace - Logical namespace
 * @returns Managed objects
 */
export function rolesCatalog(namespace: NamespaceName): readonly CatalogObject[] {
  const tableId: ObjectIdentity = { kind: "table", namespace, name: "roles" };
  const table: CatalogObject = {
    kind: "table",
    identity: tableId,
    owner: "managed",
    definition: { rowSecurity: false },
    dependencies: [],
    provenance,
  };
  const columns = ["id", "label"].map((name): CatalogObject => {
    return {
      kind: "column",
      identity: { kind: "column", namespace, parent: "roles", name },
      owner: "managed",
      definition: { type: "text", nullable: false },
      dependencies: [{ identity: tableId }],
      provenance,
    };
  });
  const primaryKey: CatalogObject = {
    kind: "constraint",
    identity: { kind: "constraint", namespace, parent: "roles", name: "roles_pkey" },
    owner: "managed",
    definition: {
      constraintKind: "primary_key",
      columns: ["id"],
      deferrable: false,
      initially: "immediate",
      nullsNotDistinct: false,
    },
    dependencies: [{ identity: tableId }],
    provenance,
  };
  return [table, ...columns, primaryKey];
}
