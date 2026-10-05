/**
 * Catalog output for every Postgres column builder.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/index.js";
import { staticNamespace, table, type Provenance } from "../src/contracts/internal.js";
import { catalog, catalogHash } from "../src/contracts/catalog/document.js";
import { compileColumn } from "../src/dialects/pg/compile.js";
import { json } from "../src/dialects/pg/json.js";
import {
  bigint,
  boolean,
  bytea,
  char,
  cidr,
  citext,
  custom,
  date,
  daterange,
  domain,
  double,
  enum as enumColumn,
  id,
  identity,
  inet,
  int4range,
  int8range,
  integer,
  interval,
  jsonb,
  line,
  ltree,
  macaddr,
  macaddr8,
  numeric,
  numrange,
  point,
  real,
  smallint,
  t,
  text,
  time,
  timestamp,
  timestamptz,
  timetz,
  tsvector,
  tstzrange,
  uuid,
  varchar,
  type ColumnBuilder,
  type ColumnFlags,
} from "../src/dialects/pg/index.js";

const provenance: Provenance = { origin: "file", name: "db/tasks.ts" };
const namespace = staticNamespace("public");
const parent = { namespace, name: "tasks" };

const input = { parent, name: "value", provenance };

test("every builder compiles to a stable catalog column", () => {
  const cases: readonly (readonly [string, () => ColumnBuilder<unknown, ColumnFlags>, string])[] = [
    ["id", id as () => ColumnBuilder<unknown, ColumnFlags>, "uuid"],
    ["identity", identity as () => ColumnBuilder<unknown, ColumnFlags>, "bigint"],
    ["uuid", uuid as () => ColumnBuilder<unknown, ColumnFlags>, "uuid"],
    ["smallint", smallint as () => ColumnBuilder<unknown, ColumnFlags>, "smallint"],
    ["integer", integer as () => ColumnBuilder<unknown, ColumnFlags>, "integer"],
    ["bigint", bigint as () => ColumnBuilder<unknown, ColumnFlags>, "bigint"],
    ["numeric", numeric as () => ColumnBuilder<unknown, ColumnFlags>, "numeric"],
    ["real", real as () => ColumnBuilder<unknown, ColumnFlags>, "real"],
    ["double", double as () => ColumnBuilder<unknown, ColumnFlags>, "double precision"],
    ["text", text as () => ColumnBuilder<unknown, ColumnFlags>, "text"],
    ["varchar", (() => varchar(20)) as () => ColumnBuilder<unknown, ColumnFlags>, "varchar(20)"],
    ["char", (() => char(3)) as () => ColumnBuilder<unknown, ColumnFlags>, "char(3)"],
    ["citext", citext as () => ColumnBuilder<unknown, ColumnFlags>, "citext"],
    ["boolean", boolean as () => ColumnBuilder<unknown, ColumnFlags>, "boolean"],
    ["bytea", bytea as () => ColumnBuilder<unknown, ColumnFlags>, "bytea"],
    ["json", json as () => ColumnBuilder<unknown, ColumnFlags>, "json"],
    ["jsonb", jsonb as () => ColumnBuilder<unknown, ColumnFlags>, "jsonb"],
    ["timestamptz", timestamptz as () => ColumnBuilder<unknown, ColumnFlags>, "timestamptz"],
    ["timestamp", timestamp as () => ColumnBuilder<unknown, ColumnFlags>, "timestamp"],
    ["date", date as () => ColumnBuilder<unknown, ColumnFlags>, "date"],
    ["time", time as () => ColumnBuilder<unknown, ColumnFlags>, "time"],
    ["timetz", timetz as () => ColumnBuilder<unknown, ColumnFlags>, "timetz"],
    ["interval", interval as () => ColumnBuilder<unknown, ColumnFlags>, "interval"],
    ["tstzrange", tstzrange as () => ColumnBuilder<unknown, ColumnFlags>, "tstzrange"],
    ["daterange", daterange as () => ColumnBuilder<unknown, ColumnFlags>, "daterange"],
    ["int4range", int4range as () => ColumnBuilder<unknown, ColumnFlags>, "int4range"],
    ["int8range", int8range as () => ColumnBuilder<unknown, ColumnFlags>, "int8range"],
    ["numrange", numrange as () => ColumnBuilder<unknown, ColumnFlags>, "numrange"],
    ["inet", inet as () => ColumnBuilder<unknown, ColumnFlags>, "inet"],
    ["cidr", cidr as () => ColumnBuilder<unknown, ColumnFlags>, "cidr"],
    ["macaddr", macaddr as () => ColumnBuilder<unknown, ColumnFlags>, "macaddr"],
    ["macaddr8", macaddr8 as () => ColumnBuilder<unknown, ColumnFlags>, "macaddr8"],
    ["point", point as () => ColumnBuilder<unknown, ColumnFlags>, "point"],
    ["line", line as () => ColumnBuilder<unknown, ColumnFlags>, "line"],
    ["tsvector", tsvector as () => ColumnBuilder<unknown, ColumnFlags>, "tsvector"],
    ["ltree", ltree as () => ColumnBuilder<unknown, ColumnFlags>, "ltree"],
    [
      "enum",
      (() => enumColumn("color", ["red", "blue"])) as () => ColumnBuilder<unknown, ColumnFlags>,
      "color",
    ],
    [
      "custom",
      (() =>
        custom<string>({
          sqlType: "widget",
          encode: (value) => value,
          decode: (wire) => wire,
        })) as () => ColumnBuilder<unknown, ColumnFlags>,
      "widget",
    ],
  ];

  expect(cases).toHaveLength(38);
  for (const [name, build, dataType] of cases) {
    const first = compileColumn(build(), input);
    const second = compileColumn(build(), input);
    expect(first.column, name).toEqual(second.column);
    expect(first.column.definition.dataType, name).toBe(dataType);
    expect(first.column.definition.nullable, name).toBe(false);
    expect(t).toHaveProperty(name === "enum" ? "enum" : name);
  }
});

test("t.domain compiles to the domain name and keeps the base codec", () => {
  const column = domain("email", text(), "((VALUE ~~ '%@%'::text))");
  const compiled = compileColumn(column, input);
  expect(compiled.column.definition.dataType).toBe("email");
  expect(column.state.encode("a@b.c")).toBe(text().state.encode("a@b.c"));
  expect(column.state.decode("a@b.c")).toBe(text().state.decode("a@b.c"));
});

test("modifiers compile into defaults, checks, flags, and names", () => {
  const column = compileColumn(
    text()
      .nullable()
      .default("draft")
      .unique({ reason: "shared", global: true })
      .picklist(["draft", "active"])
      .renamedFrom("state")
      .sqlName("status")
      .comment("lifecycle")
      .guarded()
      .hidden(),
    input,
  );
  expect(column.column.identity.name).toBe("status");
  expect(column.column.definition).toEqual({
    dataType: "text",
    nullable: true,
    defaultExpression: "'draft'",
  });
  expect(column.check?.definition.expression).toBe("(status IN ('draft', 'active'))");
  expect(column.unique?.definition.constraintKind).toBe("unique");
  expect(column.uniqueReason).toBe("shared");
  expect(column.uniqueGlobal).toBe(true);
  expect(column.guarded).toBe(true);
  expect(column.hidden).toBe(true);
  expect(column.renamedFrom).toBe("state");
  expect(column.comment).toBe("lifecycle");
});

test("picklist check can be omitted, and arrays record rank", () => {
  const unchecked = compileColumn(varchar(20).picklist(["a", "b"], { check: false }), input);
  expect(unchecked.check).toBeUndefined();
  expect(compileColumn(integer().array(), input).column.definition.dataType).toBe("integer[]");
  expect(compileColumn(text().array({ dims: 2 }), input).column.definition.dataType).toBe(
    "text[][]",
  );
});

test("keys, identity, generated, and extensions record the catalog fields", () => {
  expect(compileColumn(id(), input).column.definition.defaultExpression).toBe("uuidv7()");
  expect(compileColumn(id({ default: "uuidv4" }), input).column.definition.defaultExpression).toBe(
    "gen_random_uuid()",
  );
  expect(compileColumn(id({ default: "none" }), input).column.definition.defaultExpression).toBe(
    undefined,
  );
  expect(compileColumn(text().primaryKey(), input).column.definition.nullable).toBe(false);
  const generated = compileColumn(identity(), input);
  expect(generated.column.definition.identity).toEqual({ always: true });
  expect(generated.column.definition.defaultExpression).toBeUndefined();
  const expression = compileColumn(integer().generated("1", { stored: true }), input);
  expect(expression.column.definition.generated).toEqual({ stored: true, expression: "1" });
  const citextColumn = compileColumn(citext(), input);
  expect(citextColumn.column.dependencies).toContainEqual({
    target: { kind: "extension", name: "citext" },
  });
  const tree = compileColumn(ltree(), input);
  expect(tree.column.dependencies).toContainEqual({
    target: { kind: "extension", name: "ltree" },
  });
  const enumerated = compileColumn(enumColumn("color", ["red"]), input);
  expect(enumerated.column.dependencies).toContainEqual({
    target: { kind: "type", namespace, name: "color" },
  });
});

test("a plain column hashes the same catalog twice", () => {
  const tasks = table({ namespace, name: "tasks", provenance });
  const build = () =>
    catalog([tasks, compileColumn(text().defaultSql("''"), { ...input, name: "title" }).column]);
  expect(catalogHash(build())).toBe(catalogHash(build()));
});

test("an extension dependency is recorded and is not ordered without the extension", () => {
  const tasks = table({ namespace, name: "tasks", provenance });
  const column = compileColumn(citext(), input).column;
  expect(() => catalog([tasks, column])).toThrow(OkmError);
  try {
    catalog([tasks, column]);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1020");
    }
  }
});

test("OKM1060 rejects an invalid column definition", () => {
  expect(codeOf(() => varchar(0))).toBe("OKM1060");
  expect(codeOf(() => numeric(0))).toBe("OKM1060");
  expect(codeOf(() => numeric(2, 3))).toBe("OKM1060");
  expect(codeOf(() => timestamptz(7))).toBe("OKM1060");
  expect(codeOf(() => text().array({ dims: 0 }))).toBe("OKM1060");
  expect(codeOf(() => interval("decade"))).toBe("OKM1060");
  expect(codeOf(() => enumColumn("color", []))).toBe("OKM1060");
  expect(codeOf(() => enumColumn("color", ["red", "red"]))).toBe("OKM1060");
  expect(codeOf(() => text().picklist([]))).toBe("OKM1060");
  expect(codeOf(() => text().picklist(["a", "a"]))).toBe("OKM1060");
});

test("builders allocate when called", () => {
  expect(text()).not.toBe(text());
});

function codeOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error.code;
    throw error;
  }
  throw new Error("expected OkmError");
}
