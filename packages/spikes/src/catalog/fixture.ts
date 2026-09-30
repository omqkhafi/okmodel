/**
 * Turns a harness schema fixture into catalog objects.
 *
 * Tables, columns, primary keys, foreign keys, and indexes use the one contract.
 * Fixture unique indexes stay indexes, matching the fixture DDL.
 */

import { type FixtureTable, type SchemaFixture } from "@okmodel/harness/fixtures";

import { type CatalogObject, type NamespaceName, type Provenance } from "./object.js";

const provenance: Provenance = { source: "fixture" };

/**
 * Builds catalog objects for a fixture.
 *
 * @param fixture - Neutral description from the harness
 * @param namespace - Logical namespace stored on every object
 * @returns Tables, columns, keys, and indexes
 */
export function catalogFromFixture(
  fixture: SchemaFixture,
  namespace: NamespaceName,
): readonly CatalogObject[] {
  const objects: CatalogObject[] = [];
  for (const table of fixture.tables) {
    objects.push(...objectsForTable(table, namespace));
  }
  return objects;
}

function objectsForTable(table: FixtureTable, namespace: NamespaceName): readonly CatalogObject[] {
  const tableIdentity = { kind: "table" as const, namespace, name: table.name };
  const objects: CatalogObject[] = [
    {
      kind: "table",
      identity: tableIdentity,
      owner: "managed",
      definition: { rowSecurity: false },
      dependencies: [],
      provenance,
    },
  ];
  for (const column of table.columns) {
    objects.push({
      kind: "column",
      identity: { kind: "column", namespace, parent: table.name, name: column.name },
      owner: "managed",
      definition: { type: column.type, nullable: column.nullable },
      dependencies: [{ identity: tableIdentity }],
      provenance,
    });
  }
  objects.push({
    kind: "constraint",
    identity: { kind: "constraint", namespace, parent: table.name, name: `${table.name}_pkey` },
    owner: "managed",
    definition: {
      constraintKind: "primary_key",
      columns: table.primaryKey,
      deferrable: false,
      initially: "immediate",
      nullsNotDistinct: false,
    },
    dependencies: [{ identity: tableIdentity }],
    provenance,
  });
  for (const foreignKey of table.foreignKeys) {
    objects.push({
      kind: "constraint",
      identity: { kind: "constraint", namespace, parent: table.name, name: foreignKey.name },
      owner: "managed",
      definition: {
        constraintKind: "foreign_key",
        columns: foreignKey.columns,
        references: { table: foreignKey.refTable, columns: foreignKey.refColumns },
        deferrable: false,
        initially: "immediate",
        nullsNotDistinct: false,
      },
      dependencies: [
        { identity: tableIdentity },
        { identity: { kind: "table", namespace, name: foreignKey.refTable } },
      ],
      provenance,
    });
  }
  for (const unique of table.uniques) {
    objects.push(index(namespace, table.name, unique.name, unique.columns, true, tableIdentity));
  }
  for (const secondary of table.indexes) {
    objects.push(
      index(
        namespace,
        table.name,
        secondary.name,
        secondary.columns,
        secondary.unique,
        tableIdentity,
      ),
    );
  }
  return objects;
}

function index(
  namespace: NamespaceName,
  parent: string,
  name: string,
  columns: readonly string[],
  unique: boolean,
  tableIdentity: Extract<CatalogObject, { kind: "table" }>["identity"],
): CatalogObject {
  return {
    kind: "index",
    identity: { kind: "index", namespace, parent, name },
    owner: "managed",
    definition: { columns, unique },
    dependencies: [{ identity: tableIdentity }],
    provenance,
  };
}
