/**
 * Catalog spike. Nothing here is part of the published `okmodel` package.
 */

export {
  catalogHash,
  canonicalJson,
  identityKey,
  measureCatalogHash,
  objectHash,
  sha256,
} from "./catalog/canonical.js";
export { catalogFromFixture } from "./catalog/fixture.js";
export { assertCatalog, creationOrder, dropOrder, recreatePlan } from "./catalog/graph.js";
export { fitIdentifier, POSTGRES_IDENTIFIER_MAX_BYTES } from "./catalog/identifier.js";
export { introspectObjects } from "./catalog/introspect.js";
export { diffNormalized, mismatchesFor, normalizedKey } from "./catalog/normalize.js";
export {
  OBJECT_KINDS,
  resolveNamespace,
  staticNamespace,
  templateNamespace,
  utf8Bytes,
  type CatalogObject,
  type ObjectKind,
} from "./catalog/object.js";
export { renderCatalog, renderDrop, type NamespaceBinding } from "./catalog/render.js";
export { roundTrip, type RoundTripReport } from "./catalog/round-trip.js";
export { extensionCatalog, sampleCatalog } from "./catalog/sample.js";
