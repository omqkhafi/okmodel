/**
 * Programmatic schema API (D26, D284).
 *
 * `describe` turns a `schema()` result into JSON. `buildCatalog` reads that
 * JSON back into the catalog tooling already plans. Codecs and client
 * generators stay on the schema. They are functions, and the catalog hash
 * does not include them.
 */

import { catalogError } from "../../contracts/error.js";
import { canonicalJson, type Json } from "../../contracts/catalog/json.js";
import { parseCatalog, serializeCatalog } from "../../contracts/catalog/document.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { isPostgresMajor, type PostgresMajor } from "../../dialects/pg/floor.js";
import { LOGICAL_FORMAT, type LogicalIdentity } from "./export.js";
import {
  declaredFloor,
  requiredExtensions,
  schemaMinPostgres,
  type RequiredExtension,
} from "./requirements.js";

/**
 * Namespace `schema()` compiles.
 *
 * `defineConfig({ namespace })` places a catalog after that. Placement is
 * physical, so it is not part of {@link LogicalIdentity}.
 */
const LOGICAL_NAMESPACE = "public";

/**
 * JSON description of one schema.
 *
 * `logical` names the schema. It is not the catalog hash. `catalog` is the
 * catalog document: no functions, and object keys in sorted order.
 * `minPostgres` is the lowest major that supports every feature the schema
 * uses. `extensions` lists each required extension and why it is needed.
 */
export type SchemaDescription = {
  readonly logical: LogicalIdentity;
  readonly catalog: Catalog;
  readonly minPostgres: PostgresMajor;
  readonly extensions: readonly RequiredExtension[];
};

export type { RequiredExtension };

/**
 * Describes a schema as JSON.
 *
 * The logical identity is `public`. Placing the same catalog into another
 * namespace does not change it. The catalog document keeps the namespaces
 * the catalog already has, so the catalog hash still changes with placement.
 *
 * @param schema - A `schema()` result, a prior {@link SchemaDescription}, or any
 *   value that carries its catalog (and optionally a numeric `minPostgres`)
 * @returns A description `JSON.stringify` can store
 */
export function describe(schema: {
  readonly catalog: Catalog;
  readonly requires?: { readonly postgres?: string } | undefined;
  readonly minPostgres?: PostgresMajor;
}): SchemaDescription {
  const source = schemaCatalog(schema);
  const document = JSON.parse(serializeCatalog(source)) as Json;
  const computed = schemaMinPostgres(source, declaredFloor(schema.requires));
  const carried = schema.minPostgres;
  const floor = isPostgresMajor(carried)
    ? (Math.max(carried, computed) as PostgresMajor)
    : computed;
  const extensions = requiredExtensions(source);
  const text = canonicalJson({
    catalog: document,
    extensions,
    logical: {
      format: LOGICAL_FORMAT,
      name: LOGICAL_NAMESPACE,
      namespace: LOGICAL_NAMESPACE,
    },
    minPostgres: floor,
  });
  return JSON.parse(text) as SchemaDescription;
}

/**
 * Builds the catalog from a description.
 *
 * `JSON.parse(JSON.stringify(describe(schema)))` is a valid argument. The
 * result has the same catalog hash as `schema.catalog`.
 *
 * @param description - Description from {@link describe}, including one read back from JSON
 * @returns The catalog `okm` plans
 */
export function buildCatalog(description: SchemaDescription): Catalog {
  if (description === null || typeof description !== "object" || !("catalog" in description)) {
    catalogError("OKM1027", "Catalog document is not an object.");
  }
  const body: unknown = description.catalog;
  if (body === null || typeof body !== "object") {
    catalogError("OKM1027", "Catalog document is not an object.");
  }
  return parseCatalog(JSON.stringify(body));
}

/**
 * Reads the catalog a caller passed to {@link describe}.
 *
 * @param schema - Claimed schema result
 * @returns Its catalog
 */
function schemaCatalog(schema: { readonly catalog: Catalog }): Catalog {
  if (schema === null || typeof schema !== "object") {
    catalogError("OKM1020", "describe() needs the schema() result.");
  }
  const catalog: unknown = schema.catalog;
  if (typeof catalog !== "object" || catalog === null || !("objects" in catalog)) {
    catalogError("OKM1020", "describe() needs the schema() result.");
  }
  return catalog as Catalog;
}
