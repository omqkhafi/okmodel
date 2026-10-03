/**
 * Undocumented entry for `okmodel/internal`.
 *
 * No stability promise. Dialect authors and the sibling entries import these.
 * Application code imports `table` and `index` from `okmodel/pg`, not the
 * catalog builders here.
 */

/** @internal */
export { catalogError, throwNamed } from "./error.js";
/** @internal */
export { nearestName } from "./nearest.js";
/** @internal */
export { sha256 } from "./sha256.js";

/** @internal */
export {
  BUILT_KINDS,
  CATALOG_VERSION,
  KIND_OPERATIONS,
  OBJECT_KINDS,
  OBJECT_OPERATIONS,
  OWNERS,
  POSTGRES_IDENTIFIER_MAX_BYTES,
  assertIdentifier,
  assertNamespace,
  column,
  constraint,
  deterministicName,
  fitIdentifier,
  identityKey,
  identityLabel,
  identifierLimitApplies,
  index,
  isReservedIdentifier,
  resolveNamespace,
  sameNamespace,
  sameRef,
  sequence,
  staticNamespace,
  table,
  templateNamespace,
  utf8ByteLength,
  type AnchoredIdentity,
  type BuiltKind,
  type Catalog,
  type CatalogEnvelope,
  type CatalogObject,
  type ColumnDefinition,
  type ColumnInput,
  type ColumnObject,
  type ConstraintDefinition,
  type ConstraintInput,
  type ConstraintKind,
  type ConstraintObject,
  type DefaultPrivilegeIdentity,
  type DependencyEdge,
  type ExtensionIdentity,
  type FunctionIdentity,
  type GrantIdentity,
  type GrantObjectRef,
  type IndexDefinition,
  type IndexInput,
  type IndexObject,
  type NamePurpose,
  type Namespace,
  type NamespaceIdentity,
  type ObjectIdentity,
  type ObjectKind,
  type ObjectOperation,
  type ObjectRef,
  type Owner,
  type PartitionMethod,
  type Provenance,
  type ReferentialAction,
  type RoleIdentity,
  type SequenceDefinition,
  type SequenceInput,
  type SequenceObject,
  type TableDefinition,
  type TableInput,
  type TableObject,
} from "./catalog/index.js";
