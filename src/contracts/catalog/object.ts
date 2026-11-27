/**
 * Factories for the built catalog kinds.
 *
 * Each factory stores ownership, a normalised definition, and dependency
 * edges. Constraint and index names are generated from a stable key and then
 * left alone.
 */

import { catalogError } from "../error.js";
import {
  deterministicName,
  assertIdentifier,
  assertStoredText,
  fitIdentifier,
} from "./identifier.js";
import { assertNamespace, identityKey } from "./identity.js";
import {
  referentialAction,
  type AnchoredIdentity,
  type ColumnDefinition,
  type ColumnObject,
  type ConstraintDefinition,
  type ConstraintKind,
  type ConstraintObject,
  type DependencyEdge,
  type IndexDefinition,
  type IndexElement,
  type IndexObject,
  type IndexStorage,
  type Namespace,
  type NamespaceIdentity,
  type ObjectIdentity,
  type ObjectRef,
  type Owner,
  type Provenance,
  type ReferentialAction,
  type SequenceDefinition,
  type SequenceObject,
  type SeriesDefinition,
  type TableDefinition,
  type TableObject,
} from "./types.js";

/** Fields every factory accepts. */
type CommonInput = {
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
  /** Stored on the envelope. Absent means the comment is not managed. */
  readonly comment?: string | undefined;
};

/** Input for {@link table}. */
export type TableInput = CommonInput & {
  readonly namespace: Namespace;
  readonly name: string;
  readonly partition?: TableDefinition["partition"];
  /** Enable and force when the table has no policy. */
  readonly rowSecurity?: TableDefinition["rowSecurity"];
};

/** Input for {@link column}. */
export type ColumnInput = CommonInput & {
  readonly parent: ObjectRef;
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly defaultExpression?: string;
  readonly collation?: string;
  readonly identity?: {
    readonly always: boolean;
    readonly start?: string;
    readonly increment?: string;
    readonly min?: string;
    readonly max?: string;
    readonly cache?: string;
    readonly cycle?: boolean;
  };
  readonly series?: SeriesDefinition;
  readonly generated?: { readonly stored: boolean; readonly expression: string };
};

/** Input for {@link index}. */
export type IndexInput = CommonInput & {
  readonly parent: ObjectRef;
  readonly name?: string | undefined;
  readonly nameKey?: string;
  readonly columns?: readonly string[];
  readonly unique?: boolean;
  readonly predicate?: string | undefined;
  readonly expression?: string | undefined;
  readonly method?: string | undefined;
  readonly include?: readonly string[] | undefined;
  readonly elements?: readonly IndexElement[] | undefined;
  readonly storage?: IndexStorage | undefined;
  readonly nullsNotDistinct?: boolean | undefined;
};

/** Input for {@link constraint}. */
export type ConstraintInput = CommonInput & {
  readonly parent: ObjectRef;
  readonly constraintKind: ConstraintKind;
  readonly name?: string;
  readonly nameKey?: string;
  readonly columns?: readonly string[];
  readonly expression?: string;
  readonly references?: {
    readonly parent: ObjectRef;
    readonly columns: readonly string[];
    readonly onDelete?: ReferentialAction;
    readonly onUpdate?: ReferentialAction;
    readonly match?: "full";
    readonly onDeleteColumns?: readonly string[];
  };
  readonly deferrable?: boolean;
  readonly initially?: "immediate" | "deferred";
  readonly nullsNotDistinct?: boolean;
};

/** Input for {@link sequence}. */
export type SequenceInput = CommonInput & {
  readonly namespace: Namespace;
  readonly name: string;
  readonly dataType?: SequenceDefinition["dataType"];
  readonly start?: string;
  readonly increment?: string;
  readonly cycle?: boolean;
  readonly min?: string;
  readonly max?: string;
  readonly cache?: string;
};

/**
 * Builds a table object.
 *
 * A partitioned table sets `partition`. Copied partition primary keys and
 * inherited indexes are not created; they are not catalog objects.
 *
 * @param input - Name, namespace, ownership, and optional partition
 * @returns A table envelope
 */
export function table(input: TableInput): TableObject {
  assertNamespace(input.namespace);
  assertIdentifier(input.name, "table");
  assertProvenance(input.provenance);
  const identity: NamespaceIdentity & { readonly kind: "table" } = {
    kind: "table",
    namespace: input.namespace,
    name: input.name,
  };
  const definition: TableDefinition = {
    ...(input.partition === undefined ? {} : { partition: copyPartition(input.partition) }),
    ...(input.rowSecurity === undefined ? {} : { rowSecurity: { ...input.rowSecurity } }),
  };
  return objectOf("table", identity, input, definition, input.dependencies ?? []);
}

/**
 * Builds a column object.
 *
 * The column depends on its parent table. Extra dependencies (a sequence, for
 * example) are kept.
 *
 * @param input - Parent, name, type, and nullability
 * @returns A column envelope
 */
export function column(input: ColumnInput): ColumnObject {
  assertNamespace(input.parent.namespace);
  assertIdentifier(input.name, "column");
  assertIdentifier(input.parent.name, "column parent");
  assertProvenance(input.provenance);
  assertStoredText(input.dataType, "column type");
  if (input.dataType.length === 0) {
    catalogError("OKM1020", `Column ${input.name} has no data type.`);
  }
  const modes = [
    input.defaultExpression !== undefined,
    input.identity !== undefined,
    input.generated !== undefined,
  ].filter(Boolean).length;
  if (modes > 1) {
    catalogError(
      "OKM1020",
      `Column ${input.name} sets more than one of default, identity, and generated. Set only one.`,
    );
  }
  if (input.defaultExpression !== undefined) {
    assertStoredText(input.defaultExpression, "column default");
  }
  if (input.collation !== undefined) {
    assertStoredText(input.collation, "column collation");
    if (input.collation.length === 0) {
      catalogError("OKM1020", `Column ${input.name} has an empty collation.`);
    }
  }
  if (input.generated !== undefined) {
    assertStoredText(input.generated.expression, "column generated expression");
  }
  const identity: AnchoredIdentity & { readonly kind: "column" } = {
    kind: "column",
    parent: input.parent,
    name: input.name,
  };
  const definition: ColumnDefinition = {
    dataType: input.dataType,
    nullable: input.nullable,
    ...(input.defaultExpression !== undefined
      ? { defaultExpression: input.defaultExpression }
      : {}),
    ...(input.collation !== undefined ? { collation: input.collation } : {}),
    ...(input.identity !== undefined ? { identity: identityFields(input.identity) } : {}),
    ...(input.series !== undefined ? { series: input.series } : {}),
    ...(input.generated !== undefined
      ? {
          generated: {
            stored: input.generated.stored,
            expression: input.generated.expression,
          },
        }
      : {}),
  };
  return objectOf("column", identity, input, definition, [
    tableIdentity(input.parent),
    ...(input.dependencies ?? []),
  ]);
}

/**
 * Builds an index object.
 *
 * The stored name comes from {@link deterministicName} unless `name` is set.
 * An explicit name is stored as given, including one past 63 bytes, so tooling
 * can refuse it. A generated name is still fitted. `nameKey` is what a later
 * rename must keep passing.
 *
 * @param input - Parent, columns, and the stable name key
 * @returns An index envelope
 */
export function index(input: IndexInput): IndexObject {
  assertNamespace(input.parent.namespace);
  assertIdentifier(input.parent.name, "index parent");
  assertProvenance(input.provenance);
  const columns = [...(input.columns ?? [])];
  for (const name of columns) {
    assertIdentifier(name, "index column");
  }
  if (columns.length === 0 && input.expression === undefined) {
    catalogError("OKM1020", `Index on ${input.parent.name} needs a column or an expression.`);
  }
  if (input.predicate !== undefined) {
    assertStoredText(input.predicate, "index predicate");
  }
  if (input.expression !== undefined) {
    assertStoredText(input.expression, "index expression");
  }
  const nameKey = input.nameKey ?? (columns.length > 0 ? columns.join("_") : "expr");
  assertIdentifierTextKey(nameKey);
  const name =
    input.name === undefined
      ? deterministicName({ parent: input.parent.name, purpose: "index", nameKey })
      : explicitIndexName(input.name);
  const identity: AnchoredIdentity & { readonly kind: "index" } = {
    kind: "index",
    parent: input.parent,
    name,
  };
  const definition: IndexDefinition = {
    columns,
    unique: input.unique ?? false,
    nameKey,
  };
  assignIndex(definition, input);
  return objectOf("index", identity, input, definition, [
    tableIdentity(input.parent),
    ...columns.map((columnName) => columnIdentity(input.parent, columnName)),
    ...(input.dependencies ?? []),
  ]);
}

/**
 * Builds a constraint object.
 *
 * Primary key names are `{parent}_pkey` and do not include column names.
 * Unique and foreign-key names use every SQL column. Checks use `nameKey`,
 * which stays fixed when a field is renamed. `nameKey` is always stored.
 *
 * @param input - Parent, kind, columns, and the stable name key
 * @returns A constraint envelope
 */
export function constraint(input: ConstraintInput): ConstraintObject {
  assertNamespace(input.parent.namespace);
  assertIdentifier(input.parent.name, "constraint parent");
  assertProvenance(input.provenance);
  const columns = [...(input.columns ?? [])];
  for (const name of columns) {
    assertIdentifier(name, "constraint column");
  }
  const deferrable = input.deferrable ?? false;
  const initially = input.initially ?? "immediate";
  if (initially === "deferred" && !deferrable) {
    catalogError(
      "OKM1020",
      `Constraint on ${input.parent.name} is initially deferred but not deferrable.`,
    );
  }
  const nullsNotDistinct = input.nullsNotDistinct ?? false;
  if (
    nullsNotDistinct &&
    input.constraintKind !== "primaryKey" &&
    input.constraintKind !== "unique"
  ) {
    catalogError(
      "OKM1020",
      `Constraint on ${input.parent.name} sets nullsNotDistinct on ${input.constraintKind}. nullsNotDistinct applies only to a primary key or a unique constraint.`,
    );
  }
  if (input.constraintKind === "foreignKey") {
    if (
      input.references === undefined ||
      input.references.columns.length === 0 ||
      columns.length === 0
    ) {
      catalogError(
        "OKM1021",
        `Foreign key on ${input.parent.name} is missing its target. Use foreignKeys or references().`,
      );
    }
  } else if (input.constraintKind === "check") {
    if (input.expression === undefined || input.expression.length === 0) {
      catalogError("OKM1020", `Check on ${input.parent.name} needs an expression.`);
    }
  } else if (columns.length === 0) {
    catalogError("OKM1020", `${input.constraintKind} on ${input.parent.name} needs a column.`);
  }
  if (input.expression !== undefined) {
    assertStoredText(input.expression, "constraint expression");
  }
  const references = input.references;
  if (references !== undefined) {
    assertNamespace(references.parent.namespace);
    assertIdentifier(references.parent.name, "referenced table");
    for (const name of references.columns) {
      assertIdentifier(name, "referenced column");
    }
    assertAction(references.onDelete, input.parent.name);
    assertAction(references.onUpdate, input.parent.name);
  }
  if (
    input.constraintKind === "check" &&
    columns.length === 0 &&
    (input.nameKey === undefined || input.nameKey.length === 0)
  ) {
    catalogError("OKM1020", `Check on ${input.parent.name} needs a name key.`);
  }
  const nameKey = input.nameKey ?? defaultNameKey(input.constraintKind, columns);
  assertIdentifierTextKey(nameKey);
  const name =
    input.name === undefined
      ? deterministicName({
          parent: input.parent.name,
          purpose: input.constraintKind,
          nameKey:
            input.constraintKind === "check"
              ? nameKey
              : defaultNameKey(input.constraintKind, columns),
        })
      : fitIdentifier(input.name);
  const identity: AnchoredIdentity & { readonly kind: "constraint" } = {
    kind: "constraint",
    parent: input.parent,
    name,
  };
  const definition: ConstraintDefinition = {
    constraintKind: input.constraintKind,
    columns,
    nameKey,
    deferrable,
    initially,
    nullsNotDistinct,
    ...(input.expression !== undefined ? { expression: input.expression } : {}),
    ...(references !== undefined
      ? {
          references: {
            parent: references.parent,
            columns: [...references.columns],
            ...(references.onDelete !== undefined ? { onDelete: references.onDelete } : {}),
            ...(references.onUpdate !== undefined ? { onUpdate: references.onUpdate } : {}),
            ...(references.match === "full" ? { match: "full" as const } : {}),
            ...(references.onDeleteColumns !== undefined
              ? { onDeleteColumns: [...references.onDeleteColumns] }
              : {}),
          },
        }
      : {}),
  };
  const targets: ObjectIdentity[] = [
    tableIdentity(input.parent),
    ...columns.map((columnName) => columnIdentity(input.parent, columnName)),
  ];
  if (references !== undefined) {
    targets.push(tableIdentity(references.parent));
    for (const columnName of references.columns) {
      targets.push(columnIdentity(references.parent, columnName));
    }
  }
  targets.push(...(input.dependencies ?? []));
  return objectOf("constraint", identity, input, definition, targets);
}

/**
 * Builds a sequence object.
 *
 * @param input - Namespace, name, and sequence counters
 * @returns A sequence envelope
 */
export function sequence(input: SequenceInput): SequenceObject {
  assertNamespace(input.namespace);
  assertIdentifier(input.name, "sequence");
  assertProvenance(input.provenance);
  const dataType = input.dataType ?? "bigint";
  const start = input.start ?? "1";
  const increment = input.increment ?? "1";
  assertInteger(start, "sequence start");
  assertInteger(increment, "sequence increment");
  if (increment === "0" || increment === "-0") {
    catalogError("OKM1020", `Sequence ${input.name} has a zero increment.`);
  }
  for (const [label, value] of [
    ["min", input.min],
    ["max", input.max],
    ["cache", input.cache],
  ] as const) {
    if (value !== undefined) assertInteger(value, `sequence ${label}`);
  }
  const identity: NamespaceIdentity & { readonly kind: "sequence" } = {
    kind: "sequence",
    namespace: input.namespace,
    name: input.name,
  };
  return objectOf(
    "sequence",
    identity,
    input,
    {
      dataType,
      start,
      increment,
      cycle: input.cycle ?? false,
      ...sequenceBounds(dataType, increment, input),
    },
    input.dependencies ?? [],
  );
}

/** Identity fields stored on a column. Absent options stay off the hash. */
export function identityFields(identity: {
  readonly always: boolean;
  readonly start?: string;
  readonly increment?: string;
  readonly min?: string;
  readonly max?: string;
  readonly cache?: string;
  readonly cycle?: boolean;
}): {
  readonly always: boolean;
  readonly start?: string;
  readonly increment?: string;
  readonly min?: string;
  readonly max?: string;
  readonly cache?: string;
  readonly cycle?: boolean;
} {
  return {
    always: identity.always,
    ...(identity.start !== undefined ? { start: identity.start } : {}),
    ...(identity.increment !== undefined ? { increment: identity.increment } : {}),
    ...(identity.min !== undefined ? { min: identity.min } : {}),
    ...(identity.max !== undefined ? { max: identity.max } : {}),
    ...(identity.cache !== undefined ? { cache: identity.cache } : {}),
    ...(identity.cycle === true ? { cycle: true } : {}),
  };
}

const SEQUENCE_MIN: Readonly<Record<string, string>> = {
  smallint: "-32768",
  integer: "-2147483648",
  bigint: "-9223372036854775808",
};

const SEQUENCE_MAX: Readonly<Record<string, string>> = {
  smallint: "32767",
  integer: "2147483647",
  bigint: "9223372036854775807",
};

/**
 * Min, max, and cache that differ from the PostgreSQL default.
 *
 * A positive increment defaults to min 1, the type max, and cache 1.
 * A negative increment defaults to the type min, max -1, and cache 1.
 *
 * @param dataType - Sequence type
 * @param increment - Decimal increment
 * @param input - Bounds the caller set
 * @returns Only the bounds that must be stored
 */
export function sequenceBounds(
  dataType: string,
  increment: string,
  input: { readonly min?: string; readonly max?: string; readonly cache?: string },
): { readonly min?: string; readonly max?: string; readonly cache?: string } {
  const negative = increment.startsWith("-") && increment !== "-0";
  const minDefault = negative ? (SEQUENCE_MIN[dataType] ?? SEQUENCE_MIN.bigint) : "1";
  const maxDefault = negative ? "-1" : (SEQUENCE_MAX[dataType] ?? SEQUENCE_MAX.bigint);
  return {
    ...(input.min !== undefined && input.min !== minDefault ? { min: input.min } : {}),
    ...(input.max !== undefined && input.max !== maxDefault ? { max: input.max } : {}),
    ...(input.cache !== undefined && input.cache !== "1" ? { cache: input.cache } : {}),
  };
}

/** Shapes one catalog object. Every kind ends the same way. */
function objectOf<TKind extends string, TIdentity, TDefinition>(
  kind: TKind,
  identity: TIdentity,
  input: CommonInput,
  definition: TDefinition,
  targets: readonly ObjectIdentity[],
) {
  return {
    kind,
    identity,
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges(targets),
    provenance: input.provenance,
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
  };
}

/**
 * Keeps an explicit index name, including one over the 63-byte limit.
 *
 * Characters are still checked. Length is a tooling check so `schema()` can
 * store the name the author wrote.
 *
 * @param name - Name from `.name()`
 * @returns The same name
 */
function assignIndex(definition: IndexDefinition, input: IndexInput): void {
  const target = definition as Record<string, unknown>;
  for (const key of [
    "predicate",
    "expression",
    "method",
    "include",
    "elements",
    "storage",
  ] as const) {
    const value = input[key];
    if (value === undefined || value === "btree" || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    target[key] = value;
  }
  if (input.nullsNotDistinct === true) target.nullsNotDistinct = true;
}

function explicitIndexName(name: string): string {
  assertIdentifier(name, "index name", 4096);
  return name;
}

/**
 * Sorts and dedupes dependency targets.
 *
 * @param targets - Identity targets, structural ones first
 * @returns Edges in identity-key order
 */
export function normaliseEdges(targets: readonly ObjectIdentity[]): readonly DependencyEdge[] {
  const byKey = new Map<string, ObjectIdentity>();
  for (const target of targets) {
    const key = identityKey(target);
    if (!byKey.has(key)) {
      byKey.set(key, target);
    }
  }
  return [...byKey.entries()]
    .sort((left, right) => compareText(left[0], right[0]))
    .map(([, target]) => ({ target }));
}

/**
 * Compares two strings by UTF-16 code unit, which is stable across runtimes.
 *
 * @param left - First string
 * @param right - Second string
 * @returns A negative, zero, or positive number
 */
export function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function tableIdentity(parent: ObjectRef): ObjectIdentity {
  return { kind: "table", namespace: parent.namespace, name: parent.name };
}

function columnIdentity(parent: ObjectRef, name: string): ObjectIdentity {
  return { kind: "column", parent, name };
}

function defaultNameKey(kind: ConstraintKind, columns: readonly string[]): string {
  if (kind === "primaryKey") {
    return "pkey";
  }
  return columns.join("_");
}

function assertIdentifierTextKey(nameKey: string): void {
  if (nameKey.length === 0) {
    catalogError("OKM1122", "Name key is empty.");
  }
  if (nameKey.includes("\u0000")) {
    catalogError("OKM1122", "Name key contains NUL.");
  }
  assertStoredText(nameKey, "Name key");
}

function assertInteger(value: string, role: string): void {
  assertStoredText(value, role);
  if (!/^-?\d+$/.test(value)) {
    catalogError("OKM1020", `${role} ${value} is not an integer.`);
  }
}

function assertAction(action: ReferentialAction | undefined, parent: string): void {
  if (action === undefined) {
    return;
  }
  if (referentialAction(action) === undefined) {
    catalogError(
      "OKM1020",
      `Foreign key on ${parent} has referential action ${action}. Accepted actions: cascade, no action, restrict, set default, set null.`,
    );
  }
}

/**
 * Rejects a provenance that cannot be stored.
 *
 * @param provenance - Origin and name
 */
export function assertProvenance(provenance: Provenance): void {
  assertStoredText(provenance.name, "provenance");
  if (provenance.name.length === 0) {
    catalogError("OKM1020", "Provenance name is empty.");
  }
}

function copyPartition(
  partition: NonNullable<TableDefinition["partition"]>,
): NonNullable<TableDefinition["partition"]> {
  if (partition.columns.length === 0) {
    catalogError("OKM1020", "Partition needs a column.");
  }
  for (const name of partition.columns) {
    assertIdentifier(name, "partition column");
  }
  return { method: partition.method, columns: [...partition.columns] };
}
