/**
 * `t` namespace from spec section 6.4.
 *
 * Importing `t` pulls every builder. Import one builder when an application
 * uses only that type.
 */

import { boolean, bytea } from "./bool.js";
import { custom } from "./custom.js";
import { double, numeric, real } from "./decimal.js";
import { domain, enumColumn } from "./enum.js";
import { line, point } from "./geometry.js";
import { bigint, identity, integer, smallint } from "./integer.js";
import { json, jsonb } from "./json.js";
import { id, uuid } from "./keys.js";
import { cidr, inet, macaddr, macaddr8 } from "./network.js";
import { daterange, int4range, int8range, numrange, tstzrange } from "./range.js";
import { ltree, tsvector } from "./search.js";
import { char, citext, text, varchar } from "./text.js";
import { date, interval, time, timestamp, timestamptz, timetz } from "./time.js";

/**
 * Postgres column builders.
 */
export const t = {
  id,
  identity,
  uuid,
  smallint,
  integer,
  bigint,
  numeric,
  real,
  double,
  text,
  varchar,
  char,
  citext,
  boolean,
  bytea,
  json,
  jsonb,
  timestamptz,
  timestamp,
  date,
  time,
  timetz,
  interval,
  tstzrange,
  daterange,
  int4range,
  int8range,
  numrange,
  inet,
  cidr,
  macaddr,
  macaddr8,
  point,
  line,
  tsvector,
  ltree,
  enum: enumColumn,
  domain,
  custom,
};
