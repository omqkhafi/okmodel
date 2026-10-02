/**
 * Catalog contract for the runtime entry: envelope, identity, and names.
 *
 * Document checks, serialisation, parsing, hashing, and dependency order live
 * in `document.ts` and `order.ts`. They are tooling and are not re-exported
 * from the package entry.
 */

export {
  BUILT_KINDS,
  CATALOG_VERSION,
  KIND_OPERATIONS,
  OBJECT_KINDS,
  OBJECT_OPERATIONS,
  OWNERS,
  type AnchoredIdentity,
  type BuiltKind,
  type Catalog,
  type CatalogEnvelope,
  type CatalogObject,
  type ColumnDefinition,
  type ColumnObject,
  type ConstraintDefinition,
  type ConstraintKind,
  type ConstraintObject,
  type DefaultPrivilegeIdentity,
  type DependencyEdge,
  type ExtensionIdentity,
  type FunctionIdentity,
  type GrantIdentity,
  type GrantObjectRef,
  type IndexDefinition,
  type IndexObject,
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
  type SequenceObject,
  type TableDefinition,
  type TableObject,
} from "./types.js";

export {
  assertNamespace,
  identityKey,
  identityLabel,
  identifierLimitApplies,
  resolveNamespace,
  sameNamespace,
  sameRef,
  staticNamespace,
  templateNamespace,
} from "./identity.js";

export {
  POSTGRES_IDENTIFIER_MAX_BYTES,
  assertIdentifier,
  deterministicName,
  fitIdentifier,
  isReservedIdentifier,
  utf8ByteLength,
  type NamePurpose,
} from "./identifier.js";

export {
  column,
  constraint,
  index,
  sequence,
  table,
  type ColumnInput,
  type ConstraintInput,
  type IndexInput,
  type SequenceInput,
  type TableInput,
} from "./object.js";
