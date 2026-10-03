/**
 * Times hash, canonical form, and topological order on the 200-table fixture.
 *
 * Prints one sample. No ceiling.
 */

import { generateFixture, type SchemaFixture } from "../packages/harness/src/fixtures.js";
import {
  catalog,
  catalogHash,
  creationOrder,
  serializeCatalog,
} from "../src/contracts/catalog/document.js";
import {
  column,
  constraint,
  index,
  staticNamespace,
  table,
  type CatalogObject,
} from "../src/contracts/internal.js";
import { sha256 } from "../src/contracts/sha256.js";
import { utf8ByteLength } from "../src/contracts/utf8.js";

const provenance = { origin: "file" as const, name: "fixture" };

/**
 * Median of five timed calls, after ten warmups.
 *
 * @param run - Work to time
 * @returns Median milliseconds
 */
function medianMs(run: () => void): number {
  for (let warmup = 0; warmup < 10; warmup += 1) {
    run();
  }
  const times: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    const started = performance.now();
    run();
    times.push(performance.now() - started);
  }
  times.sort((left, right) => left - right);
  return times[2] ?? 0;
}

function catalogFromFixture(fixture: SchemaFixture): readonly CatalogObject[] {
  const namespace = staticNamespace("public");
  const objects: CatalogObject[] = [];
  for (const item of fixture.tables) {
    const parent = { namespace, name: item.name };
    objects.push(table({ namespace, name: item.name, provenance }));
    for (const field of item.columns) {
      objects.push(
        column({
          parent,
          name: field.name,
          dataType: field.type,
          nullable: field.nullable,
          provenance,
        }),
      );
    }
    objects.push(
      constraint({
        parent,
        constraintKind: "primaryKey",
        columns: item.primaryKey,
        provenance,
      }),
    );
    for (const foreignKey of item.foreignKeys) {
      objects.push(
        constraint({
          parent,
          constraintKind: "foreignKey",
          columns: foreignKey.columns,
          nameKey: foreignKey.name,
          references: {
            parent: { namespace, name: foreignKey.refTable },
            columns: foreignKey.refColumns,
          },
          provenance,
        }),
      );
    }
    for (const unique of item.uniques) {
      objects.push(
        constraint({
          parent,
          constraintKind: "unique",
          columns: unique.columns,
          nameKey: unique.name,
          provenance,
        }),
      );
    }
    for (const secondary of item.indexes) {
      objects.push(
        index({
          parent,
          columns: secondary.columns,
          unique: secondary.unique,
          nameKey: secondary.name,
          provenance,
        }),
      );
    }
  }
  return objects;
}

const fixture = generateFixture({ seed: 1, tables: 200 });
const built = catalog(catalogFromFixture(fixture));
const text = serializeCatalog(built);
const report = {
  tables: fixture.tableCount,
  objects: built.objects.length,
  canonicalBytes: utf8ByteLength(text),
  canonicalMs: medianMs(() => {
    serializeCatalog(built);
  }),
  hashMs: medianMs(() => {
    sha256(text);
  }),
  catalogHashMs: medianMs(() => {
    catalogHash(built);
  }),
  orderMs: medianMs(() => {
    creationOrder(built);
  }),
};

console.log(
  `catalog-bench: ${String(report.tables)} tables, ${String(report.objects)} objects, canonical ${String(report.canonicalBytes)} bytes`,
);
console.log(
  `catalog-bench: canonical ${report.canonicalMs.toFixed(3)} ms, hash ${report.hashMs.toFixed(3)} ms, catalog hash ${report.catalogHashMs.toFixed(3)} ms, order ${report.orderMs.toFixed(3)} ms`,
);
