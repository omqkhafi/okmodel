/**
 * Enum and domain columns.
 *
 * The catalog column type is the type name. Compile records a dependency on
 * the enum, and `schema()` stores that enum as a catalog type.
 */

import { type ColumnBuilder, type ColumnFlags, type PlainFlags, required } from "./column.js";
import { definition, rejected, unavailable } from "./misuse.js";

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
 * Domains are not catalog objects in this version. Calling the builder fails
 * with OKM1061 until 0.3, when a domain becomes a `type` subkind (D141).
 *
 * @param name - Domain name
 * @param base - Scalar column the domain is based on
 * @param check - Domain check expression
 * @returns A domain column with the base codec, once 0.3 supports it
 */
export function domain<TValue, TFlags extends ColumnFlags>(
  _name: string,
  _base: ColumnBuilder<TValue, TFlags>,
  _check: string,
): ColumnBuilder<TValue, PlainFlags> {
  unavailable("t.domain() is not available yet. It arrives in 0.3.");
}
