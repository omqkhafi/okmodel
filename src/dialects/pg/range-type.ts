/**
 * `t.range`: a Postgres range type.
 *
 * An unused range is not in the catalog. A column records it. Builtin
 * subtype diffs are filled in. There is no canonical function and no
 * `t.tsrange`.
 */

import { rangeType } from "../../contracts/catalog/range.js";
import type {
  CatalogObject,
  Namespace,
  ObjectIdentity,
  Provenance,
} from "../../contracts/catalog/types.js";
import { type ColumnBuilder, type ColumnFlags, type PlainFlags, required } from "./column.js";
import { type RangeColumnMark, tagRange } from "./column-mark.js";
import { rememberTypeGrant } from "./composite-mark.js";
import { definition } from "./misuse.js";
import {
  readMulti,
  readRange,
  readRangeList,
  writeMulti,
  writeRange,
  writeRangeArray,
  type Range,
} from "./range.js";

/** Options on `t.range`. */
export type RangeOptions<T = unknown> = {
  /** Bound column. Its SQL type is the range subtype. */
  readonly subtype: ColumnBuilder<T, ColumnFlags>;
  /** `subtype_diff`. A builtin subtype fills this in when omitted. */
  readonly subtypeDiff?: string;
  /** Collation for a collatable subtype. */
  readonly collation?: string;
  /** Multirange type name. The default is `{name}_multirange`. */
  readonly multirangeName?: string;
  /** Comment on the range type. */
  readonly comment?: string;
  /** `USAGE` grants. The same shape as a table `grants` option. */
  readonly grants?: unknown;
  /** Previous type name. The multirange is renamed with it. */
  readonly renamedFrom?: string;
};

const BUILTIN_DIFF: Readonly<Record<string, string>> = {
  smallint: "int4range_subdiff",
  integer: "int4range_subdiff",
  int4: "int4range_subdiff",
  bigint: "int8range_subdiff",
  int8: "int8range_subdiff",
  numeric: "numrange_subdiff",
  real: "float4mi",
  "double precision": "float8mi",
  float4: "float4mi",
  float8: "float8mi",
  date: "daterange_subdiff",
  timestamp: "tsrange_subdiff",
  "timestamp without time zone": "tsrange_subdiff",
  timestamptz: "tstzrange_subdiff",
  "timestamp with time zone": "tstzrange_subdiff",
};

const UNQUOTED = new Set([
  "smallint",
  "integer",
  "int4",
  "bigint",
  "int8",
  "numeric",
  "real",
  "double precision",
  "float4",
  "float8",
]);

/**
 * A named range type.
 *
 * @typeParam T - Bound type
 * @param name - Postgres type name
 * @param options - Subtype, diff, collation, multirange name, comment, and grants
 * @returns A column of that range
 */
export function range<T>(
  name: string,
  options: RangeOptions<T>,
): ColumnBuilder<Range<T>, PlainFlags> {
  if (name.length === 0) definition("range name must be a non-empty type name.");
  const subtype = options.subtype.state.baseType;
  if (subtype.length === 0 || options.subtype.state.dims !== 0) {
    definition(`Range ${name} needs a scalar subtype.`);
  }
  const diff = options.subtypeDiff ?? BUILTIN_DIFF[subtype];
  const multirange = options.multirangeName ?? `${name}_multirange`;
  const quote = !UNQUOTED.has(subtype);
  const encodeBound = (value: unknown): string => options.subtype.state.encode(value as never);
  const decodeBound = (wire: string): T => options.subtype.state.decode(wire) as T;
  const mark = buildMark(
    name,
    subtype,
    diff,
    options.collation,
    multirange,
    quote,
    encodeBound,
    decodeBound,
    options,
  );
  const encode = tagRange((value: unknown) => writeRange(value, encodeBound, quote), mark);
  return required({
    baseType: name,
    typeDependency: name,
    encode,
    decode: (wire) => readRange(wire, decodeBound, quote),
    accepts: ["Object", "Array"],
    sqlForm: "cast",
  });
}

function buildMark<T>(
  name: string,
  subtype: string,
  diff: string | undefined,
  collation: string | undefined,
  multirange: string,
  quote: boolean,
  encodeBound: (value: unknown) => string,
  decodeBound: (wire: string) => T,
  options: RangeOptions<T>,
): RangeColumnMark {
  const mark: RangeColumnMark = {
    kind: "range",
    type: name,
    subtype,
    multirange,
    quote,
    encodeBound,
    ...(diff !== undefined ? { subtypeDiff: diff } : {}),
    ...(collation !== undefined ? { collation } : {}),
    ...(options.comment !== undefined ? { comment: options.comment } : {}),
    ...(options.grants !== undefined ? { grants: options.grants } : {}),
    ...(options.renamedFrom !== undefined ? { renamedFrom: options.renamedFrom } : {}),
    emit(parent, provenance, objects) {
      declare(
        name,
        subtype,
        diff,
        collation,
        multirange,
        parent.namespace,
        provenance,
        objects,
        options,
      );
    },
    asArray: (dims) => {
      if (dims !== 1) definition(`Range ${name} array dims ${String(dims)} must be 1.`);
      const encode = tagRange(
        (value: unknown) => {
          if (!Array.isArray(value)) definition(`Range ${name} array must be a list.`);
          return writeRangeArray(value, encodeBound, quote);
        },
        { ...mark, read: (sql) => `to_jsonb(${sql})::text` },
      );
      return {
        encode,
        decode: (wire: string) => readRangeList(wire, decodeBound, quote),
      };
    },
    multi: () => ({
      baseType: multirange,
      encode: tagRange((value: unknown) => writeMulti(value, encodeBound, quote), {
        ...mark,
        kind: "multirange",
        type: multirange,
      }),
      decode: (wire: string) => readMulti(wire, decodeBound, quote),
    }),
  };
  return mark;
}

function declare(
  name: string,
  subtype: string,
  diff: string | undefined,
  collation: string | undefined,
  multirange: string,
  namespace: Namespace,
  provenance: Provenance,
  objects: CatalogObject[],
  options: Pick<RangeOptions, "comment" | "grants">,
): void {
  if (objects.some((object) => object.kind === "type" && object.identity.name === name)) return;
  const dependencies: ObjectIdentity[] = [];
  objects.push(
    rangeType({
      namespace,
      name,
      subtype,
      multirange,
      provenance,
      ...(diff !== undefined ? { subtypeDiff: diff } : {}),
      ...(collation !== undefined ? { collation } : {}),
      ...(dependencies.length > 0 ? { dependencies } : {}),
      ...(options.comment !== undefined ? { comment: options.comment } : {}),
    }),
  );
  const schema = namespace.form === "static" ? namespace.name : "public";
  rememberTypeGrant(schema, name, options.grants);
}
