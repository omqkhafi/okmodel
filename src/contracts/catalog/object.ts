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
import type {
  AnchoredIdentity,
  ColumnDefinition,
  ColumnObject,
  ConstraintDefinition,
  ConstraintKind,
  ConstraintObject,
  DependencyEdge,
  IndexDefinition,
  IndexObject,
  Namespace,
  NamespaceIdentity,
  ObjectIdentity,
  ObjectRef,
  Owner,
  Provenance,
  SequenceDefinition,
  SequenceObject,
  TableDefinition,
  TableObject,
} from "./types.js";

/** Fields every factory accepts. */
type CommonInput = {
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
};

/** Input for {@link table}. */
export type TableInput = CommonInput & {
  readonly namespace: Namespace;
  readonly name: string;
  readonly partition?: TableDefinition["partition"];
};

/** Input for {@link column}. */
export type ColumnInput = CommonInput & {
  readonly parent: ObjectRef;
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly defaultExpression?: string;
  readonly identity?: { readonly always: boolean };
  readonly generated?: { readonly stored: boolean; readonly expression: string };
};

/** Input for {@link index}. */
export type IndexInput = CommonInput & {
  readonly parent: ObjectRef;
  readonly name?: string;
  readonly nameKey?: string;
  readonly columns?: readonly string[];
  readonly unique?: boolean;
  readonly predicate?: string;
  readonly expression?: string;
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
  const definition: TableDefinition =
    input.partition === undefined ? {} : { partition: copyPartition(input.partition) };
  return {
    kind: "table",
    identity,
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges(input.dependencies ?? []),
    provenance: input.provenance,
  };
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
    ...(input.identity !== undefined ? { identity: { always: input.identity.always } } : {}),
    ...(input.generated !== undefined
      ? {
          generated: {
            stored: input.generated.stored,
            expression: input.generated.expression,
          },
        }
      : {}),
  };
  return {
    kind: "column",
    identity,
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges([tableIdentity(input.parent), ...(input.dependencies ?? [])]),
    provenance: input.provenance,
  };
}

/**
 * Builds an index object.
 *
 * The stored name comes from {@link deterministicName} unless `name` is set.
 * Either way a name past the dialect limit is fitted. `nameKey` is what a
 * later rename must keep passing.
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
      : fitIdentifier(input.name);
  const identity: AnchoredIdentity & { readonly kind: "index" } = {
    kind: "index",
    parent: input.parent,
    name,
  };
  const definition: IndexDefinition = {
    columns,
    unique: input.unique ?? false,
    nameKey,
    ...(input.predicate !== undefined ? { predicate: input.predicate } : {}),
    ...(input.expression !== undefined ? { expression: input.expression } : {}),
  };
  return {
    kind: "index",
    identity,
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges([
      tableIdentity(input.parent),
      ...columns.map((columnName) => columnIdentity(input.parent, columnName)),
      ...(input.dependencies ?? []),
    ]),
    provenance: input.provenance,
  };
}

/**
 * Builds a constraint object.
 *
 * Primary key names are `{parent}_pkey` and do not include column names.
 * Other names use `nameKey`, which stays fixed when a field is renamed.
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
      catalogError("OKM1021", `Foreign key on ${input.parent.name} is missing its target.`);
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
          nameKey,
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
  return {
    kind: "constraint",
    identity,
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges(targets),
    provenance: input.provenance,
  };
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
  const start = input.start ?? "1";
  const increment = input.increment ?? "1";
  assertInteger(start, "sequence start");
  assertInteger(increment, "sequence increment");
  if (increment === "0" || increment === "-0") {
    catalogError("OKM1020", `Sequence ${input.name} has a zero increment.`);
  }
  const identity: NamespaceIdentity & { readonly kind: "sequence" } = {
    kind: "sequence",
    namespace: input.namespace,
    name: input.name,
  };
  return {
    kind: "sequence",
    identity,
    owner: input.owner ?? "managed",
    definition: {
      dataType: input.dataType ?? "bigint",
      start,
      increment,
      cycle: input.cycle ?? false,
    },
    dependencies: normaliseEdges(input.dependencies ?? []),
    provenance: input.provenance,
  };
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

function assertProvenance(provenance: Provenance): void {
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
