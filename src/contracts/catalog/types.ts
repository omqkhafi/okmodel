/**
 * Catalog kinds, identity, and the shared envelope.
 *
 * Every object uses one envelope (kind, identity, owner, definition,
 * dependencies, provenance). Kinds other than table, column, index,
 * constraint, sequence, and type (enum) are named here so a later prompt
 * can fill them in without changing the envelope.
 */

/** Who may change an object. `ignored` is invisible to diffs. */
export const OWNERS = ["managed", "external", "ignored"] as const;

/** Ownership stored on every catalog object. */
export type Owner = (typeof OWNERS)[number];

/**
 * Object kinds from spec section 5.7.
 *
 * Built in this layer: table, column, index, constraint, sequence, and type.
 * A type object is an enum: ordered labels, and no other form.
 */
export const OBJECT_KINDS = [
  "table",
  "column",
  "index",
  "constraint",
  "sequence",
  "view",
  "materializedView",
  "type",
  "function",
  "trigger",
  "policy",
  "extension",
  "role",
  "grant",
  "defaultPrivilege",
] as const;

/** A catalog object kind. */
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** Kinds that have factories in this layer. */
export const BUILT_KINDS = ["table", "column", "index", "constraint", "sequence", "type"] as const;

/** A kind this layer can construct. */
export type BuiltKind = (typeof BUILT_KINDS)[number];

/**
 * Lifecycle operations a kind declares.
 *
 * Spec section 5.7: create, replace when compatible, alter, drop, and
 * recreate-with-dependents.
 */
export const OBJECT_OPERATIONS = [
  "create",
  "replace",
  "alter",
  "drop",
  "recreateWithDependents",
] as const;

/** One lifecycle operation. */
export type ObjectOperation = (typeof OBJECT_OPERATIONS)[number];

/**
 * Operations each kind declares.
 *
 * Roles are created and altered in place and are never dropped (D119).
 * Materialized views have no replace. Grants and default privileges are
 * declared so the map covers section 5.7; those objects are not built here.
 */
export const KIND_OPERATIONS: { readonly [K in ObjectKind]: readonly ObjectOperation[] } = {
  table: ["create", "alter", "drop", "recreateWithDependents"],
  column: ["create", "alter", "drop", "recreateWithDependents"],
  index: ["create", "drop", "recreateWithDependents"],
  constraint: ["create", "alter", "drop", "recreateWithDependents"],
  sequence: ["create", "alter", "drop"],
  view: ["create", "replace", "drop", "recreateWithDependents"],
  materializedView: ["create", "drop", "recreateWithDependents"],
  type: ["create", "alter", "drop"],
  function: ["create", "replace", "drop", "recreateWithDependents"],
  trigger: ["create", "drop", "recreateWithDependents"],
  policy: ["create", "alter", "drop"],
  extension: ["create", "alter", "drop"],
  role: ["create", "alter"],
  grant: ["create", "drop"],
  defaultPrivilege: ["create", "alter", "drop"],
};

/**
 * A schema name.
 *
 * `static` is a concrete schema. `template` keeps a pattern such as
 * `tenant_{id}`. Snapshots and diffs store the template.
 */
export type Namespace =
  | { readonly form: "static"; readonly name: string }
  | { readonly form: "template"; readonly pattern: string };

/**
 * A table (or other namespace-qualified parent) inside a namespace.
 *
 * The namespace may be a template. It is not resolved here.
 */
export type ObjectRef = {
  readonly namespace: Namespace;
  readonly name: string;
};

/** Identity of a table, view, materialized view, sequence, or type. */
export type NamespaceIdentity = {
  readonly kind: "table" | "view" | "materializedView" | "sequence" | "type";
  readonly namespace: Namespace;
  readonly name: string;
};

/**
 * Identity of an object that lives on a parent table.
 *
 * Columns, indexes, and constraints use `(parent, name)`. Triggers and
 * policies use `(table, name)`, the same shape.
 */
export type AnchoredIdentity = {
  readonly kind: "column" | "index" | "constraint" | "trigger" | "policy";
  readonly parent: ObjectRef;
  readonly name: string;
};

/** Function identity. Argument types keep overloads distinct. */
export type FunctionIdentity = {
  readonly kind: "function";
  readonly namespace: Namespace;
  readonly name: string;
  readonly argTypes: readonly string[];
};

/**
 * Grant identity.
 *
 * The key is `(role, object, privilege)`. It is not a stored identifier and
 * is exempt from the dialect length limit (D119).
 */
export type GrantIdentity = {
  readonly kind: "grant";
  readonly role: string;
  readonly object: GrantObjectRef;
  readonly privilege: string;
};

/** What a grant attaches to. `namespace` is the schema itself. */
export type GrantObjectRef = {
  readonly kind: "table" | "sequence" | "namespace";
  readonly namespace: Namespace;
  readonly name: string;
};

/**
 * Default-privilege identity.
 *
 * The key is `(forRole, namespace, objectKind, grantee, privilege)`. It is
 * exempt from the dialect length limit (D119).
 */
export type DefaultPrivilegeIdentity = {
  readonly kind: "defaultPrivilege";
  readonly forRole: string;
  readonly namespace: Namespace;
  readonly objectKind: string;
  readonly grantee: string;
  readonly privilege: string;
};

/** Role identity. Roles are cluster objects and have no namespace. */
export type RoleIdentity = {
  readonly kind: "role";
  readonly name: string;
};

/** Extension identity. Extensions are database-scoped and have no namespace. */
export type ExtensionIdentity = {
  readonly kind: "extension";
  readonly name: string;
};

/** Stable identity. The variant depends on the kind. */
export type ObjectIdentity =
  | NamespaceIdentity
  | AnchoredIdentity
  | FunctionIdentity
  | GrantIdentity
  | DefaultPrivilegeIdentity
  | RoleIdentity
  | ExtensionIdentity;

/**
 * Where an object, a query, or a rule came from.
 *
 * `source` is the authoring location (`schema.ts:12`). It is recorded when
 * the object is defined and is not part of the catalog hash.
 */
export type Provenance = {
  readonly origin: "file" | "trait" | "extension";
  readonly name: string;
  readonly source?: string;
};

/**
 * An edge to another object.
 *
 * A target whose kind is `column` is column granularity. Any other kind is
 * object granularity.
 */
export type DependencyEdge = {
  readonly target: ObjectIdentity;
};

/** How a partitioned table assigns rows. */
export type PartitionMethod = "range" | "list" | "hash";

/** Table definition. Columns, indexes, and constraints are their own objects. */
export type TableDefinition = {
  readonly partition?: {
    readonly method: PartitionMethod;
    readonly columns: readonly string[];
  };
};

/**
 * Column definition.
 *
 * `dataType` is the type name (`uuid`, `text`, `varchar(200)`), not a SQL
 * expression. At most one of `defaultExpression`, `identity`, and `generated`
 * is set.
 */
export type ColumnDefinition = {
  readonly dataType: string;
  readonly nullable: boolean;
  readonly defaultExpression?: string;
  readonly identity?: { readonly always: boolean };
  readonly generated?: { readonly stored: boolean; readonly expression: string };
  /**
   * Collation name, such as `C`.
   *
   * Absent when the column uses the type's default collation. A client
   * generator is not stored here.
   */
  readonly collation?: string;
};

/**
 * Index definition.
 *
 * `nameKey` is the stable token the name was generated from. It does not
 * follow a later field rename. Column order is significant.
 */
export type IndexDefinition = {
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly nameKey: string;
  readonly predicate?: string;
  readonly expression?: string;
};

/** Constraint family. */
export type ConstraintKind = "primaryKey" | "unique" | "foreignKey" | "check";

/**
 * What Postgres does when a referenced row changes.
 *
 * Stored on the foreign key so `onDelete` and `onUpdate` survive compile.
 */
export const REFERENTIAL_ACTIONS = [
  "cascade",
  "no action",
  "restrict",
  "set default",
  "set null",
] as const;

/** One referential action. */
export type ReferentialAction = (typeof REFERENTIAL_ACTIONS)[number];

/**
 * Returns the action when `value` is one this catalog stores.
 *
 * @param value - Author or document text
 * @returns The action, or `undefined` when it is not in the list
 */
export function referentialAction(value: string): ReferentialAction | undefined {
  for (const action of REFERENTIAL_ACTIONS) {
    if (action === value) {
      return action;
    }
  }
  return undefined;
}

/** Constraint definition. `nameKey` stays put when a field is renamed. */
export type ConstraintDefinition = {
  readonly constraintKind: ConstraintKind;
  readonly columns: readonly string[];
  readonly nameKey: string;
  readonly deferrable: boolean;
  readonly initially: "immediate" | "deferred";
  readonly nullsNotDistinct: boolean;
  readonly expression?: string;
  readonly references?: {
    readonly parent: ObjectRef;
    readonly columns: readonly string[];
    readonly onDelete?: ReferentialAction;
    readonly onUpdate?: ReferentialAction;
  };
};

/**
 * Enum definition.
 *
 * `labels` is the stored order. That order is part of the catalog hash.
 * Domains are not represented here.
 */
export type TypeDefinition = {
  readonly labels: readonly string[];
};

/** Sequence definition. Start and increment are decimal integers. */
export type SequenceDefinition = {
  readonly dataType: "smallint" | "integer" | "bigint";
  readonly start: string;
  readonly increment: string;
  readonly cycle: boolean;
};

/** Shared fields on every catalog object. */
export type CatalogEnvelope<K extends ObjectKind, I extends ObjectIdentity, D> = {
  readonly kind: K;
  readonly identity: I;
  readonly owner: Owner;
  readonly definition: D;
  readonly dependencies: readonly DependencyEdge[];
  readonly provenance: Provenance;
};

/** A table, possibly partitioned. Copied partition keys are not objects. */
export type TableObject = CatalogEnvelope<
  "table",
  NamespaceIdentity & { readonly kind: "table" },
  TableDefinition
>;

/** A column of a table. */
export type ColumnObject = CatalogEnvelope<
  "column",
  AnchoredIdentity & { readonly kind: "column" },
  ColumnDefinition
>;

/** A secondary index. */
export type IndexObject = CatalogEnvelope<
  "index",
  AnchoredIdentity & { readonly kind: "index" },
  IndexDefinition
>;

/** A table constraint. */
export type ConstraintObject = CatalogEnvelope<
  "constraint",
  AnchoredIdentity & { readonly kind: "constraint" },
  ConstraintDefinition
>;

/** A sequence. */
export type SequenceObject = CatalogEnvelope<
  "sequence",
  NamespaceIdentity & { readonly kind: "sequence" },
  SequenceDefinition
>;

/** An enum. Identity is `(namespace, name)`. */
export type TypeObject = CatalogEnvelope<
  "type",
  NamespaceIdentity & { readonly kind: "type" },
  TypeDefinition
>;

/**
 * One built catalog object.
 *
 * Views, functions, triggers, extensions, roles, grants, and default
 * privileges use {@link CatalogEnvelope} when they are built. They are not
 * part of this union yet.
 */
export type CatalogObject =
  | TableObject
  | ColumnObject
  | IndexObject
  | ConstraintObject
  | SequenceObject
  | TypeObject;

/** Format version stored in the serialized catalog. */
export const CATALOG_VERSION = 1;

/** A catalog document. Object order is identity-key order. */
export type Catalog = {
  readonly version: typeof CATALOG_VERSION;
  readonly objects: readonly CatalogObject[];
};
