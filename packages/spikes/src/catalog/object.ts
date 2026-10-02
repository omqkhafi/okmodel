/**
 * One catalog object contract.
 *
 * Every Postgres object the spike models uses the same envelope: kind,
 * identity, owner, definition, dependencies, and provenance. Identity and
 * definition stay kind-specific, because an extension has no namespace and a
 * function's identity includes its argument types.
 */

/** Object kinds this spike builds, orders, and round-trips. */
export const OBJECT_KINDS = [
  "table",
  "column",
  "index",
  "constraint",
  "sequence",
  "extension",
  "view",
  "materialized_view",
  "function",
  "trigger",
  "policy",
  "domain",
  "partition",
  "role",
  "grant",
  "default_privilege",
] as const;

/** A catalog object kind. */
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** Who is allowed to change the object. */
export type Owner = "managed" | "external" | "ignored";

/**
 * A schema name.
 *
 * `template` is true when `name` is a pattern such as `tenant_{id}`.
 * Snapshots keep that pattern. SQL uses a resolved schema.
 */
export type NamespaceName = {
  readonly name: string;
  readonly template: boolean;
};

/** Where an object came from: a file, a trait, or an extension. */
export type Provenance = {
  readonly source: string;
  readonly detail?: string;
};

/** An edge to another object. A column target is column granularity. */
export type DependencyEdge = {
  readonly identity: ObjectIdentity;
};

/** Identity of a table, view, materialized view, sequence, or domain. */
export type SchemaIdentity<
  K extends "table" | "view" | "materialized_view" | "sequence" | "domain",
> = {
  readonly kind: K;
  readonly namespace: NamespaceName;
  readonly name: string;
};

/** Identity of an object that lives on a parent table. */
export type ParentIdentity<
  K extends "column" | "index" | "constraint" | "trigger" | "policy" | "partition",
> = {
  readonly kind: K;
  readonly namespace: NamespaceName;
  readonly parent: string;
  readonly name: string;
};

/** Function identity. Argument types keep overloads distinct. */
export type FunctionIdentity = {
  readonly kind: "function";
  readonly namespace: NamespaceName;
  readonly name: string;
  readonly argTypes: readonly string[];
};

/** Extension identity. Extensions are database-scoped, so there is no namespace. */
export type ExtensionIdentity = {
  readonly kind: "extension";
  readonly name: string;
};

/**
 * Privileges this spike will grant.
 *
 * The list is the SQL keyword, lowercased. It is not a Postgres identifier.
 */
export const GRANT_PRIVILEGES = [
  "select",
  "insert",
  "update",
  "delete",
  "truncate",
  "references",
  "trigger",
  "usage",
  "create",
] as const;

/** One privilege keyword from {@link GRANT_PRIVILEGES}. */
export type GrantPrivilege = (typeof GRANT_PRIVILEGES)[number];

/** What a grant attaches to. */
export const GRANT_OBJECT_KINDS = ["table", "schema", "sequence"] as const;

/** A grant target kind. */
export type GrantObjectKind = (typeof GRANT_OBJECT_KINDS)[number];

/** Object classes `ALTER DEFAULT PRIVILEGES` can name. */
export const DEFAULT_PRIVILEGE_OBJECT_TYPES = [
  "tables",
  "sequences",
  "functions",
  "types",
] as const;

/** One `ALTER DEFAULT PRIVILEGES` object class. */
export type DefaultPrivilegeObjectType = (typeof DEFAULT_PRIVILEGE_OBJECT_TYPES)[number];

/**
 * Role identity.
 *
 * Roles are cluster-wide. The name is the identity; there is no namespace and
 * no database.
 */
export type RoleIdentity = {
  readonly kind: "role";
  readonly name: string;
};

/**
 * Grant identity.
 *
 * Spec section 5.7 names this `(role, object, privilege)`. `parent` is the
 * relation, or empty when the grant is on the schema. `name` repeats the
 * triple so the shared identity key stays unique; it is not a Postgres name.
 */
export type GrantIdentity = {
  readonly kind: "grant";
  readonly namespace: NamespaceName;
  readonly parent: string;
  readonly name: string;
  readonly role: string;
  readonly objectKind: GrantObjectKind;
  readonly privilege: GrantPrivilege;
};

/**
 * Default-privilege identity.
 *
 * One object per privilege. `forRole` is the role whose future objects receive
 * the grant. `role` is the grantee.
 */
export type DefaultPrivilegeIdentity = {
  readonly kind: "default_privilege";
  readonly namespace: NamespaceName;
  readonly name: string;
  readonly forRole: string;
  readonly role: string;
  readonly objectType: DefaultPrivilegeObjectType;
  readonly privilege: GrantPrivilege;
};

/** Stable identity. The variant depends on the kind. */
export type ObjectIdentity =
  | SchemaIdentity<"table">
  | ParentIdentity<"column">
  | ParentIdentity<"index">
  | ParentIdentity<"constraint">
  | SchemaIdentity<"sequence">
  | ExtensionIdentity
  | RoleIdentity
  | GrantIdentity
  | DefaultPrivilegeIdentity
  | SchemaIdentity<"view">
  | SchemaIdentity<"materialized_view">
  | FunctionIdentity
  | ParentIdentity<"trigger">
  | ParentIdentity<"policy">
  | SchemaIdentity<"domain">
  | ParentIdentity<"partition">;

/** How a partitioned table assigns rows. */
export type PartitionMethod = "range" | "list" | "hash";

/** How a table is split, when it is partitioned. */
export type PartitionBy = {
  readonly method: PartitionMethod;
  readonly columns: readonly string[];
};

/** Table definition. Columns, keys, and indexes are their own objects. */
export type TableDefinition = {
  readonly partitionBy?: PartitionBy;
  readonly rowSecurity: boolean;
};

/**
 * Column definition.
 *
 * `defaultSql` is an integer literal in this spike. `generatedSql` is a stored
 * generated expression. A column has at most one of the two.
 */
export type ColumnDefinition = {
  readonly type: string;
  readonly nullable: boolean;
  readonly defaultSql?: string;
  readonly generatedSql?: string;
};

/**
 * Secondary index. Primary keys and unique constraints are constraints.
 *
 * `expression` is an expression index. Column indexes leave it unset.
 * `predicate` is the `WHERE` clause of a partial index, without the keyword.
 */
export type IndexDefinition = {
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly expression?: string;
  readonly predicate?: string;
};

/** Constraint definition shared by primary keys, uniques, foreign keys, and checks. */
export type ConstraintDefinition = {
  readonly constraintKind: "primary_key" | "unique" | "foreign_key" | "check";
  readonly columns: readonly string[];
  readonly references?: {
    readonly table: string;
    readonly columns: readonly string[];
  };
  readonly expression?: string;
  readonly deferrable: boolean;
  readonly initially: "immediate" | "deferred";
  readonly nullsNotDistinct: boolean;
};

/** Sequence definition. */
export type SequenceDefinition = {
  readonly dataType: "int2" | "int4" | "int8";
  readonly start: string;
  readonly increment: string;
};

/**
 * Extension definition.
 *
 * `version` and `schema` are omitted when the plan should accept whatever the
 * server installs. `relocatable` is the server's flag, stored so a schema move
 * can be refused before apply.
 */
export type ExtensionDefinition = {
  readonly name: string;
  readonly version?: string;
  readonly schema?: string;
  readonly relocatable?: boolean;
};

/** Role definition. Passwords stay out of the catalog. */
export type RoleDefinition = {
  readonly login: boolean;
  readonly inherit: boolean;
};

/** Grant definition. The target and the privilege live on the identity. */
export type GrantDefinition = {
  readonly grantable: boolean;
};

/** Default-privilege definition. The target class lives on the identity. */
export type DefaultPrivilegeDefinition = {
  readonly grantable: boolean;
};

/** View definition. `sql` is authoring text, not the drift canonical form. */
export type ViewDefinition = {
  readonly sql: string;
  readonly columns: readonly string[];
};

/** Materialized view definition. Postgres has no `CREATE OR REPLACE` for these. */
export type MaterializedViewDefinition = {
  readonly sql: string;
  readonly columns: readonly string[];
  readonly withData: boolean;
};

/** How a function body is spelled in `CREATE FUNCTION`. */
export type FunctionBodyStyle = "string" | "return" | "atomic";

/** Function definition. Overload identity lives on {@link FunctionIdentity}. */
export type FunctionDefinition = {
  readonly args: readonly { readonly name: string; readonly type: string }[];
  readonly returns: string;
  readonly language: "sql" | "plpgsql";
  readonly volatility: "immutable" | "stable" | "volatile";
  readonly body: string;
  readonly bodyStyle: FunctionBodyStyle;
};

/** Trigger definition. */
export type TriggerDefinition = {
  readonly timing: "before" | "after";
  readonly events: readonly ("insert" | "update" | "delete")[];
  readonly level: "row" | "statement";
  readonly function: string;
  readonly functionArgTypes: readonly string[];
};

/** Row-level security policy. */
export type PolicyDefinition = {
  readonly command: "select" | "insert" | "update" | "delete" | "all";
  readonly permissive: boolean;
  readonly using: string;
  readonly check: string;
};

/** Domain definition. Check expressions are authoring text. */
export type DomainDefinition = {
  readonly baseType: string;
  readonly notNull: boolean;
  readonly checkSql?: string;
};

/**
 * One partition of a partitioned table.
 *
 * Range partitions use `from` and `to` (integers or timestamptz literals).
 * List partitions use `values`. Hash partitions use `modulus` and `remainder`.
 * `method` defaults to range when it is omitted, which is the P03 shape.
 */
export type PartitionDefinition = {
  readonly parent: string;
  readonly from: string;
  readonly to: string;
  readonly method?: PartitionMethod;
  readonly values?: readonly string[];
  readonly modulus?: number;
  readonly remainder?: number;
};

/** Shared fields on every catalog object. */
type Envelope<K extends ObjectKind, I extends ObjectIdentity, D> = {
  readonly kind: K;
  readonly identity: I;
  readonly owner: Owner;
  readonly definition: D;
  readonly dependencies: readonly DependencyEdge[];
  readonly provenance: Provenance;
};

/** A table, possibly partitioned. */
export type TableObject = Envelope<"table", SchemaIdentity<"table">, TableDefinition>;

/** A column of a table. */
export type ColumnObject = Envelope<"column", ParentIdentity<"column">, ColumnDefinition>;

/** A secondary index. */
export type IndexObject = Envelope<"index", ParentIdentity<"index">, IndexDefinition>;

/** A table constraint. */
export type ConstraintObject = Envelope<
  "constraint",
  ParentIdentity<"constraint">,
  ConstraintDefinition
>;

/** A sequence. */
export type SequenceObject = Envelope<"sequence", SchemaIdentity<"sequence">, SequenceDefinition>;

/** An extension. */
export type ExtensionObject = Envelope<"extension", ExtensionIdentity, ExtensionDefinition>;

/** A cluster role. */
export type RoleObject = Envelope<"role", RoleIdentity, RoleDefinition>;

/** A privilege on one object. */
export type GrantObject = Envelope<"grant", GrantIdentity, GrantDefinition>;

/** One default privilege for objects a role creates later. */
export type DefaultPrivilegeObject = Envelope<
  "default_privilege",
  DefaultPrivilegeIdentity,
  DefaultPrivilegeDefinition
>;

/** A view. */
export type ViewObject = Envelope<"view", SchemaIdentity<"view">, ViewDefinition>;

/** A materialized view. */
export type MaterializedViewObject = Envelope<
  "materialized_view",
  SchemaIdentity<"materialized_view">,
  MaterializedViewDefinition
>;

/** A function. */
export type FunctionObject = Envelope<"function", FunctionIdentity, FunctionDefinition>;

/** A trigger. */
export type TriggerObject = Envelope<"trigger", ParentIdentity<"trigger">, TriggerDefinition>;

/** A policy. */
export type PolicyObject = Envelope<"policy", ParentIdentity<"policy">, PolicyDefinition>;

/** A domain. */
export type DomainObject = Envelope<"domain", SchemaIdentity<"domain">, DomainDefinition>;

/** A partition of a partitioned table. */
export type PartitionObject = Envelope<
  "partition",
  ParentIdentity<"partition">,
  PartitionDefinition
>;

/**
 * One catalog object.
 *
 * The envelope is the contract. `identity` and `definition` are the kind's
 * payload. A partitioned table is a {@link TableObject} plus {@link PartitionObject}
 * children, not a second contract.
 */
export type CatalogObject =
  | TableObject
  | ColumnObject
  | IndexObject
  | ConstraintObject
  | SequenceObject
  | ExtensionObject
  | RoleObject
  | GrantObject
  | DefaultPrivilegeObject
  | ViewObject
  | MaterializedViewObject
  | FunctionObject
  | TriggerObject
  | PolicyObject
  | DomainObject
  | PartitionObject;

/** Raised when a catalog, identifier, or render input breaks a spike rule. */
export class CatalogError extends Error {
  /**
   * @param message - What failed
   */
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

/**
 * A concrete schema name.
 *
 * @param name - Schema name stored in the catalog
 * @returns A namespace that is not a template
 */
export function staticNamespace(name: string): NamespaceName {
  return { name, template: false };
}

/**
 * A namespace template such as `tenant_{id}`.
 *
 * @param pattern - Pattern containing the `{id}` placeholder
 * @returns A template namespace
 */
export function templateNamespace(pattern: string): NamespaceName {
  if (!pattern.includes("{id}")) {
    throw new CatalogError(`Namespace template ${pattern} has no {id} placeholder.`);
  }
  return { name: pattern, template: true };
}

/**
 * Resolves a namespace for one tenant id.
 *
 * Static namespaces return their name. Templates substitute `{id}` after the
 * id passes the sanitizer (`[a-z0-9_]`). The resolved name must fit in 63 bytes.
 *
 * @param namespace - Logical namespace
 * @param id - Tenant id. Ignored for a static namespace
 * @returns The schema name to emit
 */
export function resolveNamespace(namespace: NamespaceName, id = ""): string {
  if (!namespace.template) return namespace.name;
  if (!/^[a-z0-9_]+$/.test(id)) {
    throw new CatalogError(`Tenant id ${id} is not [a-z0-9_].`);
  }
  const resolved = namespace.name.replaceAll("{id}", id);
  if (utf8Bytes(resolved) > 63) {
    throw new CatalogError(`Resolved namespace ${resolved} exceeds 63 bytes.`);
  }
  return resolved;
}

/**
 * Namespace of an identity, if the kind has one.
 *
 * @param identity - Object identity
 * @returns The namespace, or `undefined` for an extension or a role
 */
export function namespaceOf(identity: ObjectIdentity): NamespaceName | undefined {
  if (identity.kind === "extension" || identity.kind === "role") return undefined;
  return identity.namespace;
}

/**
 * Parent table name, if the kind has one.
 *
 * @param identity - Object identity
 * @returns The parent name, or `undefined` when the object is not parented
 */
export function parentOf(identity: ObjectIdentity): string | undefined {
  switch (identity.kind) {
    case "column":
    case "index":
    case "constraint":
    case "trigger":
    case "policy":
    case "partition":
    case "grant":
      return identity.parent;
    default:
      return undefined;
  }
}

/**
 * Identity `name` for a grant.
 *
 * The shared key is `(kind, namespace, parent, name)`. The name carries the
 * grantee and the privilege so two grants on one table stay distinct.
 *
 * @param role - Grantee
 * @param objectKind - Table, schema, or sequence
 * @param privilege - Privilege keyword
 * @returns The identity name
 */
export function grantIdentityName(
  role: string,
  objectKind: GrantObjectKind,
  privilege: GrantPrivilege,
): string {
  return `${objectKind}:${role}:${privilege}`;
}

/**
 * Identity `name` for one default privilege.
 *
 * @param forRole - Role that will create the objects
 * @param objectType - Object class the default applies to
 * @param role - Grantee
 * @param privilege - Privilege keyword
 * @returns The identity name
 */
export function defaultPrivilegeIdentityName(
  forRole: string,
  objectType: DefaultPrivilegeObjectType,
  role: string,
  privilege: GrantPrivilege,
): string {
  return `${forRole}:${objectType}:${role}:${privilege}`;
}

/**
 * Accepts a privilege keyword.
 *
 * @param privilege - Candidate keyword
 * @returns The same keyword when it is in {@link GRANT_PRIVILEGES}
 */
export function assertPrivilege(privilege: string): GrantPrivilege {
  if (!(GRANT_PRIVILEGES as readonly string[]).includes(privilege)) {
    throw new CatalogError(`Privilege ${privilege} is not in the spike allowlist.`);
  }
  return privilege as GrantPrivilege;
}

/**
 * Function argument types, if the identity is a function.
 *
 * @param identity - Object identity
 * @returns Argument types, or `undefined` for every other kind
 */
export function argTypesOf(identity: ObjectIdentity): readonly string[] | undefined {
  if (identity.kind === "function") return identity.argTypes;
  return undefined;
}

/**
 * UTF-8 byte length of a string.
 *
 * @param value - Text to measure
 * @returns Byte length
 */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
