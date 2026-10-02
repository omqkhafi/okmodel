/**
 * Public entry for `okmodel/pg`.
 *
 * Column types, codecs, picklists, `table()`, and `schema()`.
 * Each builder is a separate export so a bundle can keep only the ones it calls.
 */

export { mapPostgresError, type MapPostgresErrorOptions } from "./errors.js";
export { emitRowTypes } from "./emit.js";
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

export { compileColumn, type CompiledColumn, type CompileColumnInput } from "./compile.js";
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
export { json, jsonb, jsonReplacer } from "./json.js";
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
