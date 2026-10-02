/**
 * Column-type cost sample. Not a D127 ceiling. Measured and reported only.
 */

import {
  t,
  type ColumnInsertOf,
  type ColumnRowOf,
  type ColumnUpdateOf,
} from "../../../src/dialects/pg/index.js";

const columns = {
  id: t.id(),
  identity: t.identity(),
  uuid: t.uuid(),
  smallint: t.smallint(),
  integer: t.integer(),
  bigint: t.bigint(),
  bigintNumber: t.bigint({ as: "number" }),
  numeric: t.numeric(12, 2),
  real: t.real(),
  double: t.double(),
  text: t.text(),
  varchar: t.varchar(40),
  status: t.varchar(20).picklist(["draft", "active", "done"]),
  notes: t.text().nullable(),
  citext: t.citext(),
  boolean: t.boolean(),
  bytea: t.bytea(),
  json: t.json<{ readonly id: string }>(),
  jsonb: t.jsonb(),
  timestamptz: t.timestamptz(),
  timestamp: t.timestamp(),
  date: t.date(),
  time: t.time(),
  timetz: t.timetz(),
  interval: t.interval(),
  tstzrange: t.tstzrange(),
  daterange: t.daterange(),
  int4range: t.int4range(),
  int8range: t.int8range(),
  numrange: t.numrange(),
  inet: t.inet(),
  cidr: t.cidr(),
  macaddr: t.macaddr(),
  macaddr8: t.macaddr8(),
  point: t.point(),
  line: t.line(),
  tsvector: t.tsvector(),
  ltree: t.ltree(),
  color: t.enum("color", ["red", "blue"]),
  email: t.domain("email", t.text(), "true"),
  tags: t.text().array(),
  grid: t.integer().array({ dims: 2 }),
  hidden: t.text().hidden(),
  guarded: t.text().guarded(),
  generated: t.integer().generated("1"),
};

type Row = { readonly [K in keyof typeof columns]: ColumnRowOf<(typeof columns)[K]> };
type Insert = { readonly [K in keyof typeof columns]: ColumnInsertOf<(typeof columns)[K]> };
type Update = { readonly [K in keyof typeof columns]: ColumnUpdateOf<(typeof columns)[K]> };

export type Shapes = { readonly row: Row; readonly insert: Insert; readonly update: Update };
