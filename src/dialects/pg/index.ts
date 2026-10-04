/**
 * Public entry for `okmodel/pg`.
 *
 * Column types, codecs, picklists, `table()`, and `schema()`.
 * Each builder is a separate export so a bundle can keep only the ones it calls.
 */

export {
  schema,
  type BuiltSchema,
  type SchemaCodecs,
  type SchemaInput,
  type SchemaRequires,
} from "./schema.js";
export {
  index,
  sql,
  table,
  type AnyTable,
  type ColumnHandle,
  type IndexCall,
  type SqlText,
  type SqlValue,
  type Table,
  type TableOptions,
} from "./table.js";

export { custom } from "./custom.js";
export { ColumnBuilder } from "./column.js";
export type {
  ArrayOf,
  ColumnFlags,
  ColumnInsert,
  ColumnInsertOf,
  ColumnRow,
  ColumnRowOf,
  ColumnUpdate,
  ColumnUpdateOf,
  FlagTrue,
  IdFlags,
  IdentityFlags,
  PlainFlags,
  ReferenceModifier,
  ReferenceOptions,
  SqlForm,
  ValidateModifier,
  WithGenerated,
} from "./column.js";
export { bigint, identity, integer, smallint, type BigintAs, type BigintValue } from "./integer.js";
export { double, numeric, real, type NumericAs, type NumericValue } from "./decimal.js";
export { boolean, bytea } from "./bool.js";
export { jsonb, jsonReplacer } from "./json.js";
export { id, uuid } from "./keys.js";
export { char, citext, text, varchar } from "./text.js";
export { date, interval, time, timestamp, timestamptz, timetz } from "./time.js";
export { type TimeWithOffset } from "./temporal.js";
export { daterange, int4range, int8range, numrange, tstzrange, type Range } from "./range.js";
export { cidr, inet, macaddr, macaddr8 } from "./network.js";
export { line, point, type Line, type Point } from "./geometry.js";
export { ltree, tsvector } from "./search.js";
export { domain, enumColumn as enum } from "./enum.js";
export { t } from "./namespace.js";
export * as arr from "./ops/arr-ns.js";
export * as json from "./ops/json-ns.js";
export { between } from "./ops/between.js";
export { containedBy } from "./ops/containedBy.js";
export { contains } from "./ops/contains.js";
export { endsWith } from "./ops/endsWith.js";
export { eq } from "./ops/eq.js";
export { every } from "./ops/every.js";
export { gt } from "./ops/gt.js";
export { inc } from "./ops/inc.js";
export { gte } from "./ops/gte.js";
export { has } from "./ops/has.js";
export { hasAnyKey } from "./ops/hasAnyKey.js";
export { hasKey } from "./ops/hasKey.js";
export { ilike } from "./ops/ilike.js";
export { inList } from "./ops/inList.js";
export { like } from "./ops/like.js";
export { matches } from "./ops/matches.js";
export { lt } from "./ops/lt.js";
export { lte } from "./ops/lte.js";
export { none } from "./ops/none.js";
export { not } from "./ops/not.js";
export { notIn } from "./ops/notIn.js";
export { or } from "./ops/or.js";
export { overlaps } from "./ops/overlaps.js";
export { path } from "./ops/path.js";
export { startsWith } from "./ops/startsWith.js";
export {
  many,
  manyThrough,
  one,
  type ManyRelation,
  type ManyThroughRelation,
  type OneRelation,
  type RelationCall,
} from "./relations.js";
