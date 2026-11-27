/**
 * A mark hung on a composite column's encode function.
 *
 * `column.ts` reads and writes the symbol. This module keeps the mark type
 * and the type-grant map. Neither is on the app startup graph: the type is
 * erased, and the map is reached from `t.composite` and the grant planner.
 */

import type {
  CatalogObject,
  Namespace,
  ObjectRef,
  Provenance,
} from "../../contracts/catalog/types.js";

/** One field a dotted read encodes, decodes, and prints. */
export type CompositeFieldCodec = {
  readonly dataType: string;
  readonly nullable: boolean;
  readonly encode: (value: unknown) => string;
  readonly decode: (wire: string) => unknown;
  readonly accepts?: readonly string[];
  /** Present when the field is itself a composite. */
  readonly nested?: CompositeMark;
};

/** One field the mark exposes to indexes, checks, and introspection recovery. */
export type CompositeFieldMark = {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly renamedFrom?: string;
  /** Present when the field is itself a composite. */
  readonly nested?: CompositeMark;
};

/** One enum a composite field uses. `schema()` records it with the other enums. */
export type CompositeEnumNote = {
  readonly name: string;
  readonly labels: readonly string[];
  readonly comment?: string;
  readonly grants?: unknown;
};

/**
 * What the read and write paths need from a composite column.
 *
 * `prefix` and `suffix` wrap one bound parameter: `prefix || $n || suffix`
 * is `jsonb_populate_record`. `read` projects the column as jsonb text.
 */
export type CompositeMark = {
  readonly type: string;
  readonly array: boolean;
  readonly read: (sql: string) => string;
  readonly prefix: string;
  readonly suffix: string;
  readonly rowSql: (value: unknown) => string;
  readonly fields: readonly CompositeFieldMark[];
  readonly enums: readonly CompositeEnumNote[];
  readonly fieldValue: (
    name: string,
    value: unknown,
  ) => { readonly wire: string; readonly dataType: string };
  /**
   * The field's codec.
   *
   * Absent when `name` is not a field. A query path uses this. A missing
   * field is not OKM1210: the caller raises OKM1120.
   */
  readonly fieldCodec: (name: string) => CompositeFieldCodec | undefined;
  readonly declare: (
    namespace: Namespace,
    provenance: Provenance,
    objects: CatalogObject[],
  ) => void;
  readonly emit: (
    parent: ObjectRef,
    provenance: Provenance,
    objects: CatalogObject[],
    column: string,
    nullable: boolean,
  ) => void;
  readonly asArray: (dims: number) => {
    readonly encode: (value: unknown) => string;
    readonly decode: (wire: string) => unknown;
  };
};

const typeGrants = new Map<string, unknown>();

/**
 * Drops type grants remembered for a previous catalog build.
 */
export function clearTypeGrants(): void {
  typeGrants.clear();
}

/**
 * Remembers `grants` for one type. A later build of the same name replaces it.
 *
 * @param schema - Schema name
 * @param name - Type name
 * @param grants - The option, stored as given
 */
export function rememberTypeGrant(schema: string, name: string, grants: unknown): void {
  const key = `${schema}\0${name}`;
  if (grants === undefined) {
    typeGrants.delete(key);
    return;
  }
  typeGrants.set(key, grants);
}

/**
 * Reads the grants remembered for one type.
 *
 * @param schema - Schema name
 * @param name - Type name
 * @returns The option, or `undefined` when the builder did not set one
 */
export function readTypeGrant(schema: string, name: string): unknown {
  return typeGrants.get(`${schema}\0${name}`);
}
