/**
 * Enum and domain columns.
 *
 * The catalog column type is the type name. Compile records a dependency on
 * the enum, and `schema()` stores that enum as a catalog type.
 */

import {
  type ColumnBuilder,
  type ColumnFlags,
  type PlainFlags,
  openColumn,
  required,
} from "./column.js";
import { definition, rejected } from "./misuse.js";

/**
 * A named enum. The TypeScript type is the literal union.
 *
 * `okmodel/pg` exports this function as `enum`. The declaration stays
 * `enumColumn` because `enum` is reserved in a function declaration.
 *
 * @param name - Postgres type name
 * @param values - Labels, in stored order
 * @returns An enum column
 */
export function enumColumn<const TValues extends readonly string[]>(
  name: string,
  values: TValues,
): ColumnBuilder<TValues[number], PlainFlags> {
  if (name.length === 0) {
    definition("enum name must be a non-empty type name.");
  }
  if (values.length === 0) {
    definition("enum must list at least one label.");
  }
  const allowed = new Set<string>();
  for (const value of values) {
    if (value.length === 0) {
      definition("enum labels must be non-empty strings.");
    }
    if (allowed.has(value)) {
      definition(`enum label ${value} is repeated. Each label is accepted once.`);
    }
    allowed.add(value);
  }
  return required({
    baseType: name,
    typeDependency: name,
    enumLabels: [...values],
    typeLabel: values.map((value) => JSON.stringify(value)).join(" | "),
    encode: (value) => {
      if (!allowed.has(value)) {
        rejected(`enum rejected ${value}. Accepted labels: ${[...allowed].join(", ")}.`);
      }
      return value;
    },
    decode: (wire) => {
      if (!allowed.has(wire)) {
        rejected(`enum rejected ${wire}. Accepted labels: ${[...allowed].join(", ")}.`);
      }
      return wire as TValues[number];
    },
    sqlForm: "quote",
  });
}

/**
 * A named domain over a scalar column.
 *
 * The column's SQL type is the domain name. `base` supplies the codec.
 * `check` is kept for a later `CREATE DOMAIN` and is not a column CHECK.
 *
 * @param name - Domain name
 * @param base - Scalar column the domain is based on
 * @param check - Domain check expression
 * @returns A domain column with the base codec
 */
export function domain<TValue, TFlags extends ColumnFlags>(
  name: string,
  base: ColumnBuilder<TValue, TFlags>,
  check: string,
): ColumnBuilder<TValue, PlainFlags> {
  if (name.length === 0) {
    definition("domain name must be a non-empty type name.");
  }
  if (check.length === 0) {
    definition("domain check must be a non-empty SQL expression.");
  }
  if (base.state.dims !== 0) {
    definition("domain base must be a scalar column (array dims 0).");
  }
  return openColumn({
    baseType: name,
    nullable: false,
    hasDefault: false,
    generated: false,
    guarded: false,
    hidden: false,
    omitWrite: false,
    encode: base.state.encode,
    decode: base.state.decode,
    sqlForm: base.state.sqlForm,
    typeDependency: name,
    domain: { base: base.state.baseType, check },
    ...(base.state.extension !== undefined ? { extension: base.state.extension } : {}),
  });
}
