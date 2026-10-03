/**
 * Compiles one column builder into catalog objects.
 *
 * The column factory lives here, not on the builder, so encoding a value
 * does not load constraint naming.
 */

import { assertIdentifier, assertStoredText } from "../../contracts/catalog/identifier.js";
import { column, constraint } from "../../contracts/catalog/object.js";
import type {
  ColumnObject,
  ConstraintObject,
  ObjectIdentity,
  ObjectRef,
  Owner,
  Provenance,
} from "../../contracts/catalog/types.js";
import { formatType } from "./column.js";

/** Column fields {@link compileColumn} reads. Builders satisfy this structurally. */
export type CompilableColumn = {
  readonly state: {
    readonly baseType: string;
    readonly dims: number;
    readonly nullable: boolean;
    readonly defaultSql: string | undefined;
    readonly collation: string | undefined;
    readonly identity: { readonly always: boolean } | undefined;
    readonly generated: { readonly stored: boolean; readonly expression: string } | undefined;
    readonly unique:
      | { readonly reason: string | undefined; readonly global: boolean | undefined }
      | undefined;
    readonly picklist: { readonly values: readonly string[]; readonly check: boolean } | undefined;
    readonly guarded: boolean;
    readonly hidden: boolean;
    readonly renamedFrom: string | undefined;
    readonly sqlName: string | undefined;
    readonly comment: string | undefined;
    readonly extension: string | undefined;
    readonly typeDependency: string | undefined;
    readonly enumLabels: readonly string[] | undefined;
    readonly domain: { readonly base: string; readonly check: string } | undefined;
  };
};
import { quoteLiteral } from "./quote.js";

/** Where the column is compiled. */
export type CompileColumnInput = {
  readonly parent: ObjectRef;
  readonly name: string;
  readonly provenance: Provenance;
  readonly owner?: Owner;
  readonly dependencies?: readonly ObjectIdentity[];
};

/**
 * Catalog column plus the constraints and notes the column object cannot store.
 */
export type CompiledColumn = {
  readonly column: ColumnObject;
  readonly check?: ConstraintObject;
  readonly unique?: ConstraintObject;
  readonly guarded: boolean;
  readonly hidden: boolean;
  readonly renamedFrom?: string;
  readonly comment?: string;
  readonly uniqueReason?: string;
  readonly uniqueGlobal?: boolean;
  readonly domain?: { readonly base: string; readonly check: string };
};

/**
 * Compiles a column into the catalog column definition.
 *
 * `citext` and `ltree` record an extension dependency. Enums and domains
 * record a type dependency. A picklist with `check` adds a CHECK constraint.
 * `.unique()` adds a unique constraint.
 *
 * @param builder - Column definition
 * @param input - Parent table, field name, and provenance
 * @returns The column and any constraints
 */
export function compileColumn(
  builder: CompilableColumn,
  input: CompileColumnInput,
): CompiledColumn {
  const state = builder.state;
  const name = state.sqlName ?? input.name;
  const dependencies: ObjectIdentity[] = [];
  if (state.extension !== undefined) {
    assertIdentifier(state.extension, "extension");
    dependencies.push({ kind: "extension", name: state.extension });
  }
  if (state.typeDependency !== undefined) {
    assertIdentifier(state.typeDependency, "type");
    dependencies.push({
      kind: "type",
      namespace: input.parent.namespace,
      name: state.typeDependency,
    });
  }
  if (state.renamedFrom !== undefined) {
    assertIdentifier(state.renamedFrom, "renamed column");
  }
  if (state.comment !== undefined) {
    assertStoredText(state.comment, "column comment");
  }
  if (state.picklist !== undefined) {
    for (const value of state.picklist.values) {
      assertStoredText(value, "picklist value");
    }
  }
  const built = column({
    parent: input.parent,
    name,
    dataType: formatType(state.baseType, state.dims),
    nullable: state.nullable,
    provenance: input.provenance,
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    ...(state.defaultSql !== undefined ? { defaultExpression: state.defaultSql } : {}),
    ...(state.collation !== undefined ? { collation: state.collation } : {}),
    ...(state.identity !== undefined ? { identity: state.identity } : {}),
    ...(state.generated !== undefined ? { generated: state.generated } : {}),
    ...(dependencies.length > 0 || (input.dependencies?.length ?? 0) > 0
      ? { dependencies: [...dependencies, ...(input.dependencies ?? [])] }
      : {}),
  });
  const check =
    state.picklist !== undefined && state.picklist.check
      ? constraint({
          parent: input.parent,
          constraintKind: "check",
          columns: [name],
          nameKey: name,
          expression: picklistExpression(name, state.picklist.values),
          provenance: input.provenance,
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
        })
      : undefined;
  const unique =
    state.unique !== undefined
      ? constraint({
          parent: input.parent,
          constraintKind: "unique",
          columns: [name],
          nameKey: name,
          provenance: input.provenance,
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
        })
      : undefined;
  return {
    column: built,
    guarded: state.guarded,
    hidden: state.hidden,
    ...(check !== undefined ? { check } : {}),
    ...(unique !== undefined ? { unique } : {}),
    ...(state.renamedFrom !== undefined ? { renamedFrom: state.renamedFrom } : {}),
    ...(state.comment !== undefined ? { comment: state.comment } : {}),
    ...(state.unique?.reason !== undefined ? { uniqueReason: state.unique.reason } : {}),
    ...(state.unique?.global !== undefined ? { uniqueGlobal: state.unique.global } : {}),
    ...(state.domain !== undefined ? { domain: state.domain } : {}),
  };
}

function picklistExpression(name: string, values: readonly string[]): string {
  const list = values.map((value) => quoteLiteral(value)).join(", ");
  return `(${name} IN (${list}))`;
}
