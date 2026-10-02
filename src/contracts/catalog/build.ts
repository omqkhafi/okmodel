/**
 * Assembles a catalog document.
 *
 * Parsing and serialising stay in the document module. `schema()` needs this
 * check and not the parser.
 */

import { catalogError } from "../error.js";
import { identityKey, identityLabel } from "./identity.js";
import { compareText } from "./object.js";
import { indexObjects, orderIndexed } from "./order.js";
import { CATALOG_VERSION, type Catalog, type CatalogObject } from "./types.js";

/**
 * Checks a set of objects and returns them in identity-key order.
 *
 * Duplicate identities are OKM1023. A foreign key whose target is missing is
 * OKM1021. A dependency cycle is OKM1026. A self-edge or a missing target is
 * OKM1020.
 *
 * @param objects - Built objects, in any order
 * @returns A catalog document
 */
export function catalog(objects: readonly CatalogObject[]): Catalog {
  for (const object of objects) {
    if (object.kind !== object.identity.kind) {
      catalogError("OKM1020", `${identityLabel(object.identity)} has kind ${object.kind}.`);
    }
  }
  const indexed = indexObjects(objects);
  const keys = new Set<string>();
  for (const item of indexed) {
    keys.add(item.key);
  }
  assertForeignKeys(objects, keys);
  orderIndexed(indexed);
  const sorted = [...indexed].sort((left, right) => compareText(left.key, right.key));
  return { version: CATALOG_VERSION, objects: sorted.map((item) => item.object) };
}

function assertForeignKeys(objects: readonly CatalogObject[], keys: ReadonlySet<string>): void {
  for (const object of objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "foreignKey") {
      continue;
    }
    const references = object.definition.references;
    if (references === undefined) {
      catalogError("OKM1021", `Foreign key ${object.identity.name} is missing its target.`);
    }
    const tableKey = identityKey({
      kind: "table",
      namespace: references.parent.namespace,
      name: references.parent.name,
    });
    if (!keys.has(tableKey)) {
      catalogError(
        "OKM1021",
        `Foreign key ${object.identity.name} references missing table ${references.parent.name}.`,
      );
    }
    for (const name of references.columns) {
      const columnKey = identityKey({ kind: "column", parent: references.parent, name });
      if (!keys.has(columnKey)) {
        catalogError(
          "OKM1021",
          `Foreign key ${object.identity.name} references missing column ${name}.`,
        );
      }
    }
  }
}
