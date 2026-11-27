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
 * A type object is an enum (ordered labels) or a domain (base type and check).
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

/**
 * What a grant attaches to.
 *
 * `namespace` is the schema itself. A function's `name` is `name(argTypes)`
 * so overloads stay distinct without a second field. The key is not a stored
 * identifier (D119).
 */
export type GrantObjectRef = {
  readonly kind:
    | "table"
    | "view"
    | "materializedView"
    | "sequence"
    | "function"
    | "namespace"
    | "type";
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

/**
 * Canonical extension record.
 *
 * `version` is an exact pin (`1.6`) or a floor (`>=0.7`). Absent means
 * unpinned: the installed version is information and drift ignores it.
 */
export type ExtensionDefinition = {
  /** Schema the extension is installed in. */
  readonly schema: string;
  /** Whether `ALTER EXTENSION … SET SCHEMA` is allowed. */
  readonly relocatable: boolean;
  readonly version?: string;
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

/**
 * Table-level row security when no policy carries it.
 *
 * Absent means row security is off. Policies carry enable and force when
 * the table has any, so this is set only for a table with no policy.
 */
export type RowSecurity = {
  readonly enable: boolean;
  readonly force: boolean;
};

/** Table definition. Columns, indexes, and constraints are their own objects. */
export type TableDefinition = {
  readonly partition?: {
    readonly method: PartitionMethod;
    readonly columns: readonly string[];
  };
  /** Enable and force when the table has no policy. Absent means off. */
  readonly rowSecurity?: RowSecurity;
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
  readonly identity?: {
    readonly always: boolean;
    readonly start?: string;
    readonly increment?: string;
    readonly min?: string;
    readonly max?: string;
    readonly cache?: string;
    readonly cycle?: boolean;
  };
  /**
   * Counter series for a number people see.
   *
   * Absent on a native sequence and on every column that is not one.
   * A schema that does not use it keeps the previous column hash.
   */
  readonly series?: SeriesDefinition;
  readonly generated?: { readonly stored: boolean; readonly expression: string };
  /**
   * Collation name, such as `C`.
   *
   * Absent when the column uses the type's default collation. A client
   * generator is not stored here.
   */
  readonly collation?: string;
  /**
   * Name of a NOT NULL constraint that is not validated.
   *
   * Introspection sets it on PostgreSQL 18 when `nullable` is false and the
   * constraint is `NOT VALID`, so rows with NULL may still exist. Absent
   * otherwise, and never set on a nullable column. A schema does not declare
   * it. The planner validates the constraint when the schema says NOT NULL.
   */
  readonly unvalidatedNotNull?: string;
};

/**
 * Index definition.
 *
 * `nameKey` is the stable token the name was generated from. It does not
 * follow a later field rename. Column order is significant.
 */
/**
 * One key of an index that is not a plain ascending column.
 *
 * A column key sets `column`. An expression key sets `expression`. `order`,
 * `nulls`, and `opclass` are present only when they are not the btree default.
 */
export type IndexElement = {
  readonly column?: string;
  readonly expression?: string;
  readonly order?: "desc";
  readonly nulls?: "first" | "last";
  readonly opclass?: string;
};

/**
 * Storage parameters, as Postgres reports them.
 *
 * Keys are sorted. Values are the text `reloptions` uses (`90`, `on`, `off`),
 * so a round trip matches `pg_get_indexdef`.
 */
export type IndexStorage = Readonly<Record<string, string>>;

export type IndexDefinition = {
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly nameKey: string;
  readonly predicate?: string;
  readonly expression?: string;
  /** Absent means btree. A btree index does not store the method. */
  readonly method?: string;
  /** Covering columns. Absent when the index has none. */
  readonly include?: readonly string[];
  /** Keys that are not a plain ascending column list. */
  readonly elements?: readonly IndexElement[];
  readonly storage?: IndexStorage;
  /** PostgreSQL 15. Absent means nulls are distinct. */
  readonly nullsNotDistinct?: boolean;
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
  /**
   * `false` when the check is `NOT ENFORCED`.
   *
   * Absent means enforced. PostgreSQL 18 stores that state.
   */
  readonly enforced?: boolean;
  readonly expression?: string;
  readonly references?: {
    readonly parent: ObjectRef;
    readonly columns: readonly string[];
    readonly onDelete?: ReferentialAction;
    readonly onUpdate?: ReferentialAction;
    /** `full` is `MATCH FULL`. Absent is `MATCH SIMPLE`. */
    readonly match?: "full";
    /**
     * Columns cleared by `ON DELETE SET NULL` or `SET DEFAULT`.
     *
     * Absent when the action names no column list. PostgreSQL accepts the
     * list only on delete.
     */
    readonly onDeleteColumns?: readonly string[];
  };
};

/**
 * Enum definition.
 *
 * `labels` is the stored order. That order is part of the catalog hash.
 */
export type EnumDefinition = {
  readonly labels: readonly string[];
};

/**
 * Domain definition.
 *
 * `base` is the Postgres type the domain is created over. `check` is the
 * domain check, stored as written. A later base type is refused (OKM1020).
 */
export type DomainDefinition = {
  readonly base: string;
  readonly check: string;
};

/**
 * One field of a composite type.
 *
 * `nullable` is the author's rule. PostgreSQL stores no NOT NULL on an
 * attribute; the column check is what enforces it.
 */
export type CompositeFieldDefinition = {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly comment?: string;
};

/**
 * Composite definition.
 *
 * `fields` is catalog order. The planner compares fields by name, so a
 * reorder alone is not a migration.
 */
export type CompositeDefinition = {
  readonly fields: readonly CompositeFieldDefinition[];
};

/** A catalog type: an enum, a domain, or a composite. */
export type TypeDefinition = EnumDefinition | DomainDefinition | CompositeDefinition;

/** How a counter series starts again. A string is one calendar unit. */
export type SeriesReset =
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "year"
  | {
      readonly every: number;
      readonly unit: "day" | "week" | "month" | "quarter" | "year";
      readonly from: string;
    };

/**
 * One counter series, stored on the column that shows the number.
 *
 * `counter` is always true. A native sequence is a sequence object instead.
 */
export type SeriesDefinition = {
  readonly name: string;
  readonly as: "smallint" | "integer" | "bigint";
  readonly start: string;
  readonly increment: string;
  readonly counter: true;
  readonly min?: string;
  readonly max?: string;
  readonly cache?: string;
  readonly cycle?: boolean;
  readonly reset?: SeriesReset;
  readonly at?: string;
  readonly by?: string;
  readonly byType?: string;
  readonly scope?: readonly { readonly name: string; readonly type: string }[];
  readonly when?: string;
  readonly moves?: "renumber";
  readonly comment?: string;
};

/** Sequence definition. Start and increment are decimal integers. */
export type SequenceDefinition = {
  readonly dataType: "smallint" | "integer" | "bigint";
  readonly start: string;
  readonly increment: string;
  readonly cycle: boolean;
  /** Present only when it is not the PostgreSQL default for this increment. */
  readonly min?: string;
  readonly max?: string;
  readonly cache?: string;
};

/** Shared fields on every catalog object. */
export type CatalogEnvelope<K extends ObjectKind, I extends ObjectIdentity, D> = {
  readonly kind: K;
  readonly identity: I;
  readonly owner: Owner;
  readonly definition: D;
  readonly dependencies: readonly DependencyEdge[];
  readonly provenance: Provenance;
  /**
   * Comment text, verbatim.
   *
   * Absent means the comment is not managed. It is never trimmed.
   */
  readonly comment?: string;
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
 * An extension.
 *
 * The record is identity, schema, relocatable, and version. Core stores it
 * and does not interpret it. The extension object produces it.
 */
export type ExtensionObject = CatalogEnvelope<"extension", ExtensionIdentity, ExtensionDefinition>;

/** One function language. */
export type FunctionLanguage = "sql" | "plpgsql";

/** One volatility. */
export type FunctionVolatility = "volatile" | "stable" | "immutable";

/** `SECURITY INVOKER` or `SECURITY DEFINER`. */
export type FunctionSecurity = "invoker" | "definer";

/** One argument. The name is not part of the identity. */
export type FunctionArgument = {
  readonly name: string;
  readonly type: string;
};

/**
 * Function definition.
 *
 * The body of a plpgsql or plain SQL function is the source Postgres stores
 * (`prosrc`). A `LANGUAGE sql` body that starts with `BEGIN ATOMIC` is marked
 * `atomic`: Postgres reprints that body and leaves `prosrc` empty.
 */
export type FunctionDefinition = {
  readonly arguments: readonly FunctionArgument[];
  readonly returns: string;
  readonly language: FunctionLanguage;
  readonly volatility: FunctionVolatility;
  readonly security: FunctionSecurity;
  readonly body: string;
  readonly searchPath?: string;
  readonly atomic?: true;
};

/** One trigger timing. */
export type TriggerTiming = "before" | "after" | "instead";

/** One trigger event. Stored order is insert, update, delete, truncate. */
export type TriggerEvent = "insert" | "update" | "delete" | "truncate";

/** One trigger level. */
export type TriggerLevel = "row" | "statement";

/** The function a trigger calls. Argument types keep an overload distinct. */
export type TriggerCall = {
  readonly namespace: Namespace;
  readonly name: string;
  readonly argTypes: readonly string[];
};

/**
 * Trigger definition.
 *
 * `updateOf` lists SQL column names for `UPDATE OF`. `when` is the predicate
 * text. The table and the function are dependency edges.
 */
export type TriggerDefinition = {
  readonly timing: TriggerTiming;
  readonly events: readonly TriggerEvent[];
  readonly level: TriggerLevel;
  readonly calls: TriggerCall;
  readonly updateOf?: readonly string[];
  readonly when?: string;
};

/** A function. Identity is `(schema, name, argTypes[])`. */
export type FunctionObject = CatalogEnvelope<"function", FunctionIdentity, FunctionDefinition>;

/** A trigger. Identity is `(table, name)`. */
export type TriggerObject = CatalogEnvelope<
  "trigger",
  AnchoredIdentity & { readonly kind: "trigger" },
  TriggerDefinition
>;

/** One output column of a view or materialized view. */
export type ViewColumn = {
  readonly name: string;
  readonly dataType: string;
  /** Absent means the column comment is not managed. */
  readonly comment?: string;
};

/**
 * View definition.
 *
 * `query` is the server reprint when one has been read (`pg_get_viewdef`),
 * and the author's SQL until then. Column dependencies are separate edges.
 */
export type ViewDefinition = {
  readonly columns: readonly ViewColumn[];
  readonly query: string;
  /**
   * `WITH (security_invoker = true)`.
   *
   * The default for every view. Omitted only for `{ definer: reason }`.
   */
  readonly securityInvoker?: true;
  /** `WITH (security_barrier = true)`. Set for a definer view, and when `barrier` is set. */
  readonly securityBarrier?: true;
  /** `WITH [LOCAL | CASCADED] CHECK OPTION`. Absent when the view has none. */
  readonly checkOption?: "local" | "cascaded";
};

/**
 * Materialized view definition.
 *
 * There is no replace. `refresh` is the populate mode. Postgres does not
 * store it; introspection leaves it unset.
 */
export type MaterializedViewDefinition = {
  readonly columns: readonly ViewColumn[];
  readonly query: string;
  readonly refresh?: "concurrently";
  /**
   * Skip the plan's populate step.
   *
   * Postgres does not store this. Introspection leaves it unset, and plan
   * comparison ignores it.
   */
  readonly populate?: "later";
  /** Access method. Omitted for the default heap, which Postgres does not need named. */
  readonly using?: string;
  /** Storage parameters, in the order they are written. */
  readonly storage?: readonly (readonly [string, string])[];
  /** Tablespace, when it is not the database default. */
  readonly tablespace?: string;
};

/** A view. Identity is `(namespace, name)`. */
export type ViewObject = CatalogEnvelope<
  "view",
  NamespaceIdentity & { readonly kind: "view" },
  ViewDefinition
>;

/** A materialized view. Identity is `(namespace, name)`. */
export type MaterializedViewObject = CatalogEnvelope<
  "materializedView",
  NamespaceIdentity & { readonly kind: "materializedView" },
  MaterializedViewDefinition
>;

/**
 * Role definition.
 *
 * Only `login` and `inherit` are altered in place. A password is not stored.
 */
export type RoleDefinition = {
  readonly login: boolean;
  readonly inherit: boolean;
};

/**
 * Grant definition.
 *
 * The privilege is the identity. `GRANT OPTION` is not in this version.
 */
export type GrantDefinition = Record<string, never>;

/**
 * Default-privilege definition.
 *
 * The key is the identity. The statement is `ALTER DEFAULT PRIVILEGES`.
 */
export type DefaultPrivilegeDefinition = Record<string, never>;

/** A role. Identity is the name. Roles are never dropped (D119). */
export type RoleObject = CatalogEnvelope<"role", RoleIdentity, RoleDefinition>;

/** A grant. Identity is `(role, object, privilege)`. */
export type GrantObject = CatalogEnvelope<"grant", GrantIdentity, GrantDefinition>;

/** A default privilege. Identity is `(forRole, namespace, objectKind, grantee, privilege)`. */
export type DefaultPrivilegeObject = CatalogEnvelope<
  "defaultPrivilege",
  DefaultPrivilegeIdentity,
  DefaultPrivilegeDefinition
>;

/** Which statements a policy covers. `all` is every command. */
export type PolicyCommand = "all" | "select" | "insert" | "update" | "delete";

/**
 * One row-level security policy.
 *
 * `expression` is the `USING` text. For `all` it is also the `WITH CHECK`
 * text when `check` is absent. `force` is true when the table is
 * `FORCE ROW LEVEL SECURITY`. Optional fields are absent on the policies
 * `rlsTenancy` emits, so those catalogs keep their hash.
 */
export type PolicyDefinition = {
  readonly command: PolicyCommand;
  readonly expression: string;
  readonly force: boolean;
  /** Present only for a restrictive policy. Absent means permissive. */
  readonly restrictive?: true;
  /**
   * Role names in `TO`. Absent means `PUBLIC` for a policy the author wrote
   * as public, and means no `TO` clause for a generated tenancy policy.
   */
  readonly roles?: readonly string[];
  /** `WITH CHECK` when it differs from `USING`. */
  readonly check?: string;
  /** `INSERT`: `expression` is the `WITH CHECK` text and there is no `USING`. */
  readonly checkOnly?: true;
  /** The policy is stored while row security on the table is off. */
  readonly disabled?: true;
};

/** A policy. Identity is `(parent, name)`. */
export type PolicyObject = CatalogEnvelope<
  "policy",
  AnchoredIdentity & { readonly kind: "policy" },
  PolicyDefinition
>;

/**
 * One built catalog object.
 */
export type CatalogObject =
  | TableObject
  | ColumnObject
  | IndexObject
  | ConstraintObject
  | SequenceObject
  | TypeObject
  | ExtensionObject
  | FunctionObject
  | TriggerObject
  | ViewObject
  | MaterializedViewObject
  | RoleObject
  | GrantObject
  | DefaultPrivilegeObject
  | PolicyObject;

/** Format version stored in the serialized catalog. */
export const CATALOG_VERSION = 1;

/** A catalog document. Object order is identity-key order. */
export type Catalog = {
  readonly version: typeof CATALOG_VERSION;
  readonly objects: readonly CatalogObject[];
};
