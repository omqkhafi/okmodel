/**
 * `t.composite`: a Postgres composite type.
 *
 * Reads use `to_jsonb` when every field is safe in JSON, and
 * `jsonb_build_object` with `::text` for bigint and numeric otherwise.
 * Writes encode each field and bind `jsonb_populate_record`. A null column
 * is SQL NULL. A positional `row(...)` default is catalog order; a runtime
 * write does not use that form, so `ADD ATTRIBUTE` does not break it.
 */

import { constraint } from "../../contracts/catalog/object.js";
import { compositeType } from "../../contracts/catalog/composite.js";
import type {
  CatalogObject,
  CompositeFieldDefinition,
  Namespace,
  ObjectIdentity,
  ObjectRef,
  Provenance,
} from "../../contracts/catalog/types.js";
import {
  type ColumnBuilder,
  type ColumnFlags,
  type ColumnRowOf,
  type PlainFlags,
  ColumnBuilder as Column,
  formatType,
  required,
} from "./column.js";
import { tagComposite } from "./column.js";
import {
  type CompositeEnumNote,
  type CompositeFieldMark,
  type CompositeMark,
  rememberTypeGrant,
} from "./composite-mark.js";
import { definition, rejected } from "./misuse.js";
import { quoteLiteral } from "./quote.js";

/** Options on `t.composite`. */
export type CompositeOptions = {
  /** Comment on the type. Field comments use `.comment()` on each field. */
  readonly comment?: string;
  /** `USAGE` grants. The same shape as a table `grants` option. */
  readonly grants?: unknown;
};

/**
 * Brands a composite row so a jsonb object is not one.
 *
 * The property is optional, so a field object still assigns. Only the type
 * carries the symbol. Nothing reads it at runtime, and the catalog hash
 * does not see it.
 */
export declare const compositeFields: unique symbol;

/** Each field's column row type, before the brand. */
type RowShape<TFields extends CompositeFieldMap> = {
  readonly [K in keyof TFields]: ColumnRowOf<TFields[K]>;
};

/**
 * Row of a composite: each field's column row type.
 *
 * @typeParam TFields - Field builders, in catalog order
 */
export type CompositeRow<TFields extends CompositeFieldMap> = RowShape<TFields> & {
  readonly [compositeFields]?: RowShape<TFields>;
};

/**
 * Field map accepted by {@link composite}.
 *
 * `ColumnBuilder` is invariant in its value, so `any` is what lets one
 * composite mix text, numbers, enums, and nested composites.
 */
export type CompositeFieldMap = Readonly<Record<string, ColumnBuilder<any, ColumnFlags>>>;

type FieldSpec = {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly comment?: string;
  readonly renamedFrom?: string;
  readonly text: boolean;
  readonly unsafe: boolean;
  readonly raw: boolean;
  readonly encode: (value: unknown) => string;
  readonly decode: (wire: string) => unknown;
  readonly mark?: CompositeMark;
  readonly accepts?: readonly string[];
  readonly enums: readonly CompositeEnumNote[];
  readonly extension?: string;
  readonly typeName?: string;
  readonly domain?: (
    namespace: Namespace,
    provenance: Provenance,
    objects: CatalogObject[],
  ) => void;
};

/**
 * A named composite type.
 *
 * An unused composite is not in the catalog. A column, or a field of a
 * composite that a column uses, is what records it. A type cannot contain
 * itself.
 *
 * @typeParam TFields - Field builders
 * @param name - Postgres type name
 * @param fields - Fields in catalog order
 * @param options - Comment and usage grants
 * @returns A column of that row type
 */
export function composite<const TFields extends CompositeFieldMap>(
  name: string,
  fields: TFields,
  options?: CompositeOptions,
): ColumnBuilder<CompositeRow<TFields>, PlainFlags> {
  if (name.length === 0) definition("composite name must be a non-empty type name.");
  const specs = readFields(name, fields);
  if (specs.length === 0) definition(`Composite ${name} needs a field.`);
  refuseCycle(name, specs);
  const mark = buildMark(name, specs, false, options);
  const encode = tagComposite((value: unknown) => encodeObject(name, specs, value), mark);
  const decode = (wire: string) => decodeObject(specs, wire) as CompositeRow<TFields>;
  return required({
    baseType: name,
    typeDependency: name,
    encode,
    decode,
    accepts: ["Object"],
    sqlForm: "raw",
  });
}

/**
 * Whether a check expression is the generated composite field check.
 *
 * Pull omits it. `schema()` writes it again from the type.
 *
 * @param expression - Stored check expression
 * @returns `true` when the expression is that generated check
 */
export function isGeneratedCompositeCheck(expression: string): boolean {
  const flat = expression.toLowerCase();
  return flat.includes(" is not null") && (flat.includes(").") || flat.includes("unnest("));
}

function readFields(typeName: string, fields: CompositeFieldMap): FieldSpec[] {
  const specs: FieldSpec[] = [];
  for (const [name, builder] of Object.entries(fields)) {
    if (!(builder instanceof Column)) {
      definition(`Composite ${typeName}.${name} must be a column builder.`);
    }
    const state = builder.state;
    if (state.identity !== undefined || state.generated !== undefined) {
      definition(`Composite ${typeName}.${name} cannot be an identity or a generated column.`);
    }
    const dataType = formatType(state.baseType, state.dims);
    const nested = markOf(state.encode);
    specs.push({
      name,
      dataType,
      nullable: state.nullable,
      ...(state.comment !== undefined ? { comment: state.comment } : {}),
      ...(state.renamedFrom !== undefined ? { renamedFrom: state.renamedFrom } : {}),
      text: isTextType(dataType),
      unsafe:
        isUnsafe(dataType) || nested?.fields.some((field) => isUnsafe(field.dataType)) === true,
      raw: state.sqlForm === "raw" && state.dims === 0 && nested === undefined,
      encode: state.encode,
      decode: state.decode,
      ...(nested !== undefined ? { mark: nested } : {}),
      ...(state.accepts !== undefined ? { accepts: state.accepts } : {}),
      enums: enumNotes(state, nested),
      ...(state.extension !== undefined ? { extension: state.extension } : {}),
      ...(state.typeDependency !== undefined ? { typeName: state.typeDependency } : {}),
      ...(state.domain?.emit !== undefined ? { domain: state.domain.emit } : {}),
    });
  }
  return specs;
}

function enumNotes(
  state: {
    readonly enumLabels?: readonly string[] | undefined;
    readonly typeDependency?: string | undefined;
    readonly enumComment?: string | undefined;
    readonly enumGrants?: unknown;
  },
  nested: CompositeMark | undefined,
): readonly CompositeEnumNote[] {
  const notes: CompositeEnumNote[] = [...(nested?.enums ?? [])];
  if (state.enumLabels !== undefined && state.typeDependency !== undefined) {
    notes.push({
      name: state.typeDependency,
      labels: state.enumLabels,
      ...(state.enumComment !== undefined ? { comment: state.enumComment } : {}),
      ...(state.enumGrants !== undefined ? { grants: state.enumGrants } : {}),
    });
  }
  return notes;
}

function markOf(encode: (value: unknown) => string): CompositeMark | undefined {
  return (encode as unknown as { readonly [key: symbol]: CompositeMark | undefined })[
    Symbol.for("okmodel.composite")
  ];
}

function refuseCycle(name: string, specs: readonly FieldSpec[]): void {
  const visit = (mark: CompositeMark, path: ReadonlySet<string>): void => {
    if (path.has(mark.type)) {
      definition(`Composite ${name} cannot contain itself. PostgreSQL refuses that type (42P16).`);
    }
    const next = new Set(path);
    next.add(mark.type);
    for (const field of mark.fields) {
      if (field.nested !== undefined) visit(field.nested, next);
    }
  };
  const root = new Set([name]);
  for (const spec of specs) {
    if (spec.mark !== undefined) visit(spec.mark, root);
    else if (spec.typeName === name || spec.dataType.replace(/(?:\[\])+$/, "") === name) {
      definition(`Composite ${name} cannot contain itself. PostgreSQL refuses that type (42P16).`);
    }
  }
}

function buildMark(
  name: string,
  specs: readonly FieldSpec[],
  array: boolean,
  options: CompositeOptions | undefined,
): CompositeMark {
  const quoted = quoteIdent(name);
  const prefix = array
    ? `(select coalesce(array_agg(jsonb_populate_record(null::${quoted}, e)), '{}'::${quoted}[]) from jsonb_array_elements(`
    : `jsonb_populate_record(null::${quoted}, `;
  const suffix = array ? `::jsonb) e)` : `::jsonb)`;
  const fields: CompositeFieldMark[] = specs.map((spec) => ({
    name: spec.name,
    dataType: spec.dataType,
    nullable: spec.nullable,
    ...(spec.renamedFrom !== undefined ? { renamedFrom: spec.renamedFrom } : {}),
    ...(spec.mark !== undefined ? { nested: spec.mark } : {}),
  }));
  const enums = specs.flatMap((spec) => spec.enums);
  const mark: CompositeMark = {
    type: name,
    array,
    read: (sql) => `(${project(sql, specs, array)})::text`,
    prefix,
    suffix,
    rowSql: (value) => rowSql(name, specs, value),
    fields,
    enums,
    fieldValue: (field, value) => fieldWire(name, specs, field, value),
    fieldCodec: (field) => {
      const spec = specs.find((item) => item.name === field);
      if (spec === undefined) return undefined;
      return {
        dataType: spec.dataType,
        nullable: spec.nullable,
        encode: spec.encode,
        decode: spec.decode,
        ...(spec.accepts !== undefined ? { accepts: spec.accepts } : {}),
        ...(spec.mark !== undefined ? { nested: spec.mark } : {}),
      };
    },
    declare: (namespace, provenance, objects) => {
      declare(name, specs, namespace, provenance, objects, options);
    },
    emit: (parent, provenance, objects, column, nullable) => {
      declare(name, specs, parent.namespace, provenance, objects, options);
      const check = fieldCheck(parent, provenance, column, nullable, specs, array);
      if (check !== undefined) objects.push(check);
    },
    asArray: (dims) => arrayCodec(name, specs, dims, options),
  };
  return mark;
}

function arrayCodec(
  name: string,
  specs: readonly FieldSpec[],
  dims: number,
  options: CompositeOptions | undefined,
): { readonly encode: (value: unknown) => string; readonly decode: (wire: string) => unknown } {
  if (dims !== 1) {
    definition(`Composite ${name} array dims ${String(dims)} must be 1.`);
  }
  const arrayMark = buildMark(name, specs, true, options);
  const encode = tagComposite((value: unknown) => {
    if (!Array.isArray(value)) rejected(`Composite ${name} array must be a list.`);
    const rows = value.map((item) => JSON.parse(encodeObject(name, specs, item)) as unknown);
    return JSON.stringify(rows);
  }, arrayMark);
  const decode = (wire: string) => {
    const parsed = parseJson(wire);
    if (!Array.isArray(parsed)) rejected(`Composite ${name} array must be a list.`);
    return parsed.map((item) => decodeValue(specs, item));
  };
  return { encode, decode };
}

function declare(
  name: string,
  specs: readonly FieldSpec[],
  namespace: Namespace,
  provenance: Provenance,
  objects: CatalogObject[],
  options: CompositeOptions | undefined,
): void {
  for (const spec of specs) {
    spec.mark?.declare(namespace, provenance, objects);
    spec.domain?.(namespace, provenance, objects);
  }
  if (objects.some((object) => object.kind === "type" && object.identity.name === name)) return;
  const dependencies: ObjectIdentity[] = [];
  for (const spec of specs) {
    if (spec.mark !== undefined) {
      dependencies.push({ kind: "type", namespace, name: spec.mark.type });
    } else if (spec.typeName !== undefined) {
      dependencies.push({ kind: "type", namespace, name: spec.typeName });
    }
    if (spec.extension !== undefined) {
      dependencies.push({ kind: "extension", name: spec.extension });
    }
  }
  const fields: CompositeFieldDefinition[] = specs.map((spec) => ({
    name: spec.name,
    dataType: spec.dataType,
    nullable: spec.nullable,
    ...(spec.comment !== undefined ? { comment: spec.comment } : {}),
  }));
  objects.push(
    compositeType({
      namespace,
      name,
      fields,
      provenance,
      dependencies,
      ...(options?.comment !== undefined ? { comment: options.comment } : {}),
    }),
  );
  const schema = namespace.form === "static" ? namespace.name : "public";
  rememberTypeGrant(schema, name, options?.grants);
}

function fieldCheck(
  parent: ObjectRef,
  provenance: Provenance,
  column: string,
  nullable: boolean,
  specs: readonly FieldSpec[],
  array: boolean,
): CatalogObject | undefined {
  const expression = checkSql(column, nullable, specs, array);
  if (expression.length === 0) return undefined;
  return constraint({
    parent,
    constraintKind: "check",
    columns: [column],
    nameKey: `cf_${column}`,
    expression,
    provenance,
  });
}

/**
 * CHECK that every non-null field is present.
 *
 * PostgreSQL has no NOT NULL inside a composite. A nullable column allows a
 * SQL NULL row: `column IS NOT DISTINCT FROM NULL OR (fields)`.
 *
 * @param column - SQL column name
 * @param nullable - Whether the column itself accepts NULL
 * @param specs - Fields
 * @returns The check expression
 */
export function checkSql(
  column: string,
  nullable: boolean,
  specs: readonly FieldSpec[],
  array = false,
): string {
  const inner = array ? arrayChecks(sqlIdent(column), specs) : fieldChecks(sqlIdent(column), specs);
  if (inner.length === 0) return "";
  if (!nullable) return `((${inner}))`;
  return `(((${sqlIdent(column)} IS NOT DISTINCT FROM NULL) OR (${inner})))`;
}

function fieldChecks(ref: string, specs: readonly FieldSpec[]): string {
  const parts: string[] = [];
  for (const spec of specs) {
    const access = `(${ref}).${sqlIdent(spec.name)}`;
    if (spec.mark !== undefined && !spec.mark.array) {
      const nested = fieldChecks(access, specsFrom(spec.mark));
      if (nested.length === 0) continue;
      parts.push(
        spec.nullable ? `((${access} IS NOT DISTINCT FROM NULL) OR (${nested}))` : `(${nested})`,
      );
      continue;
    }
    if (spec.mark?.array === true) {
      const inner = arrayChecks(access, specsFrom(spec.mark));
      if (inner.length === 0) continue;
      parts.push(
        spec.nullable ? `((${access} IS NOT DISTINCT FROM NULL) OR (${inner}))` : `(${inner})`,
      );
      continue;
    }
    if (!spec.nullable) parts.push(`(${access} IS NOT NULL)`);
  }
  parts.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return parts.join(" AND ");
}

function arrayChecks(ref: string, specs: readonly FieldSpec[]): string {
  const inner = fieldChecks("e", specs);
  if (inner.length === 0) return "";
  return `(NOT EXISTS (SELECT 1 FROM unnest(${ref}) e WHERE ${inner}))`;
}

/** Prints a name the way `pg_get_expr` reprints a simple identifier. */
function sqlIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : quoteIdent(name);
}

function specsFrom(mark: CompositeMark): readonly FieldSpec[] {
  return mark.fields.map((field) => ({
    name: field.name,
    dataType: field.dataType,
    nullable: field.nullable,
    text: isTextType(field.dataType),
    unsafe: isUnsafe(field.dataType),
    raw: false,
    encode: () => "",
    decode: (wire) => wire,
    enums: [],
    ...(field.nested !== undefined ? { mark: field.nested } : {}),
  }));
}

/** A field `to_jsonb` would hand back in the shape that field's codec reads. */
function jsonDirect(spec: FieldSpec): boolean {
  return !spec.unsafe && spec.mark === undefined && !spec.dataType.includes("[]");
}

function project(sql: string, specs: readonly FieldSpec[], array: boolean): string {
  if (array) {
    if (specs.every(jsonDirect)) return `to_jsonb(${sql})`;
    const body = project(`e`, specs, false);
    return `(select coalesce(jsonb_agg(${body}), '[]'::jsonb) from unnest(${sql}) e)`;
  }
  if (specs.every(jsonDirect)) return `to_jsonb(${sql})`;
  const args = specs
    .map((spec) => {
      const access = `(${sql}).${quoteIdent(spec.name)}`;
      const value =
        spec.mark !== undefined
          ? project(access, specsFrom(spec.mark), spec.mark.array)
          : spec.unsafe || spec.dataType.includes("[]")
            ? `${access}::text`
            : access;
      return `${quoteLiteral(spec.name)}, ${value}`;
    })
    .join(", ");
  return `jsonb_build_object(${args})`;
}

function encodeObject(name: string, specs: readonly FieldSpec[], value: unknown): string {
  const record = recordOf(name, specs, value);
  const out: Record<string, unknown> = {};
  for (const spec of specs) {
    if (!Object.hasOwn(record, spec.name)) {
      rejected(`Composite ${name} needs ${spec.name}.`);
    }
    const raw = record[spec.name];
    if (raw === undefined) rejected(`Composite ${name}.${spec.name} cannot be undefined.`);
    if (raw === null) {
      if (!spec.nullable) rejected(`Composite ${name}.${spec.name} cannot be null.`);
      out[spec.name] = null;
      continue;
    }
    if (spec.text && (typeof raw === "number" || typeof raw === "bigint")) {
      rejected(`Composite ${name}.${spec.name} needs text.`);
    }
    const encoded = spec.mark !== undefined ? JSON.parse(spec.encode(raw)) : spec.encode(raw);
    out[spec.name] = encoded;
  }
  return JSON.stringify(out);
}

function rowSql(name: string, specs: readonly FieldSpec[], value: unknown): string {
  const record = recordOf(name, specs, value);
  const parts = specs.map((spec) => {
    if (!Object.hasOwn(record, spec.name)) {
      rejected(`Composite ${name} needs ${spec.name}.`);
    }
    const raw = record[spec.name];
    if (raw === null) {
      if (!spec.nullable) rejected(`Composite ${name}.${spec.name} cannot be null.`);
      return "null";
    }
    if (spec.mark !== undefined) return spec.mark.rowSql(raw);
    if (spec.text && (typeof raw === "number" || typeof raw === "bigint")) {
      rejected(`Composite ${name}.${spec.name} needs text.`);
    }
    const encoded = spec.encode(raw);
    return spec.raw ? encoded : quoteLiteral(encoded);
  });
  return `row(${parts.join(", ")})::${quoteIdent(name)}`;
}

function fieldWire(
  name: string,
  specs: readonly FieldSpec[],
  field: string,
  value: unknown,
): { readonly wire: string; readonly dataType: string } {
  const spec = specs.find((item) => item.name === field);
  if (spec === undefined) rejected(`Composite ${name} has no field ${field}.`);
  if (value === null) {
    if (!spec.nullable) rejected(`Composite ${name}.${field} cannot be null.`);
    return { wire: "", dataType: spec.dataType };
  }
  if (spec.text && (typeof value === "number" || typeof value === "bigint")) {
    rejected(`Composite ${name}.${field} needs text.`);
  }
  return { wire: spec.encode(value), dataType: spec.dataType };
}

function decodeObject(specs: readonly FieldSpec[], wire: string): Record<string, unknown> {
  return decodeValue(specs, parseJson(wire));
}

function decodeValue(specs: readonly FieldSpec[], value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    rejected("A composite value must be an object.");
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const spec of specs) {
    const raw = record[spec.name];
    if (raw === null || raw === undefined) {
      out[spec.name] = null;
      continue;
    }
    const wire = typeof raw === "string" ? raw : JSON.stringify(raw);
    out[spec.name] = spec.decode(wire);
  }
  return out;
}

function recordOf(
  name: string,
  specs: readonly FieldSpec[],
  value: unknown,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    rejected(`Composite ${name} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const known = new Set(specs.map((spec) => spec.name));
  for (const key of Object.keys(record)) {
    if (!known.has(key)) rejected(`Composite ${name} has no field ${key}.`);
  }
  return record;
}

function parseJson(wire: string): unknown {
  if (typeof wire !== "string") return wire;
  try {
    return JSON.parse(wire);
  } catch {
    rejected("A composite value must be JSON.");
  }
}

function isTextType(dataType: string): boolean {
  const base = dataType.replace(/(?:\[\])+$/, "");
  return (
    base === "text" ||
    base === "citext" ||
    base.startsWith("character") ||
    base.startsWith("varchar") ||
    base.startsWith("char(")
  );
}

function isUnsafe(dataType: string): boolean {
  const base = dataType.replace(/(?:\[\])+$/, "");
  return base === "bigint" || base === "decimal" || base.startsWith("numeric");
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
