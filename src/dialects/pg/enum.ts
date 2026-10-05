/**
 * Enum and domain columns.
 *
 * The catalog column type is the type name. Compile records a dependency on
 * the type, and the column's `emit` adds that type when the catalog is built.
 */

import { catalogError } from "../../contracts/error.js";
import { domainType } from "../../contracts/catalog/enum.js";
import { sameNamespace } from "../../contracts/catalog/identity.js";
import { compareText } from "../../contracts/catalog/object.js";
import type { ObjectIdentity } from "../../contracts/catalog/types.js";
import {
  type ColumnBuilder,
  type ColumnFlags,
  type PlainFlags,
  ColumnBuilder as Column,
  formatType,
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
 * A named domain over a column type.
 *
 * The TypeScript row type and the codec are the base column's. The catalog
 * column type is the domain name, and the domain is a `type` object (D141).
 * An enum base is OKM1060. Changing the base type of an existing domain is
 * OKM1020 when the plan is built.
 *
 * @param name - Domain name
 * @param base - Column the domain is based on
 * @param check - Domain check expression, stored as written
 * @returns A domain column
 */
export function domain<TValue, TFlags extends ColumnFlags>(
  name: string,
  base: ColumnBuilder<TValue, TFlags>,
  check: string,
): ColumnBuilder<TValue, TFlags> {
  if (name.length === 0) definition("domain name must be a non-empty type name.");
  if (check.length === 0) definition("domain check must be a non-empty expression.");
  if (base.state.enumLabels !== undefined) {
    definition(
      "A domain cannot use an enum as its base in this version. Use a scalar column type.",
    );
  }
  const baseSql = canonicalBase(formatType(base.state.baseType, base.state.dims));
  const extension = base.state.extension;
  const inner = base.state.baseType;
  const nested = base.state.domain !== undefined;
  return new Column({
    ...base.state,
    baseType: name,
    dims: 0,
    typeDependency: name,
    enumLabels: undefined,
    domain: {
      base: baseSql,
      check,
      emit(namespace, provenance, objects) {
        base.state.domain?.emit?.(namespace, provenance, objects);
        const dependencies: ObjectIdentity[] = [];
        if (extension !== undefined) dependencies.push({ kind: "extension", name: extension });
        if (nested) dependencies.push({ kind: "type", namespace, name: inner });
        const built = domainType({
          namespace,
          name,
          base: baseSql,
          check,
          provenance,
          ...(dependencies.length > 0 ? { dependencies } : {}),
        });
        const index = objects.findIndex(
          (object) =>
            object.kind === "type" &&
            object.identity.name === name &&
            sameNamespace(object.identity.namespace, namespace),
        );
        const previous = index >= 0 ? objects[index] : undefined;
        if (previous !== undefined && previous.kind === "type") {
          const definition = previous.definition;
          if (
            !("base" in definition) ||
            definition.base !== baseSql ||
            definition.check !== check
          ) {
            catalogError(
              "OKM1020",
              `Domain ${name} is ${"base" in definition ? definition.base : "an enum"} on ${previous.provenance.name} and ${baseSql} on ${provenance.name}. One domain has one base and one check.`,
            );
          }
          if (compareText(provenance.name, previous.provenance.name) < 0) objects[index] = built;
          return;
        }
        objects.push(built);
      },
    },
  });
}

/**
 * Postgres `format_type` spelling of a builder type name.
 *
 * `varchar(20)` is stored as `character varying(20)`, and `timestamptz` as
 * `timestamp with time zone`, which is what introspection reads back.
 *
 * @param typeName - Builder type, including `[]` for an array base
 * @returns The type name Postgres prints
 */
function canonicalBase(typeName: string): string {
  const bracket = typeName.indexOf("[");
  const scalar = bracket === -1 ? typeName : typeName.slice(0, bracket);
  const suffix = bracket === -1 ? "" : typeName.slice(bracket);
  return canonicalScalar(scalar) + suffix;
}

function canonicalScalar(typeName: string): string {
  const varchar = /^varchar\((\d+)\)$/.exec(typeName);
  if (varchar !== null) return `character varying(${varchar[1] ?? ""})`;
  const fixed = /^char\((\d+)\)$/.exec(typeName);
  if (fixed !== null) return `character(${fixed[1] ?? ""})`;
  const timed = /^(timestamptz|timestamp|timetz|time)(\(\d+\))?$/.exec(typeName);
  if (timed === null) return typeName;
  const name = timed[1];
  const precision = timed[2] ?? "";
  if (name === "timestamptz") return `timestamp${precision} with time zone`;
  if (name === "timestamp") return `timestamp${precision} without time zone`;
  if (name === "timetz") return `time${precision} with time zone`;
  return `time${precision} without time zone`;
}
