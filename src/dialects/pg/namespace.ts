/**
 * `t` namespace from spec section 6.4.
 *
 * Importing `t` pulls every builder. Import one builder when an application
 * uses only that type.
 */

import { boolean, bytea } from "./bool.js";
import { custom } from "./custom.js";
import { double, numeric, real } from "./decimal.js";
import { composite } from "./composite.js";
import { domain, enumColumn } from "./enum.js";
import { line, point } from "./geometry.js";
import { bigint, identity, integer, integerIdentity, smallint } from "./integer.js";
import { json, jsonb } from "./json.js";
import { id, uuid } from "./keys.js";
import { cidr, inet, macaddr, macaddr8 } from "./network.js";
import {
  datemultirange,
  daterange,
  int4multirange,
  int4range,
  int8multirange,
  int8range,
  nummultirange,
  numrange,
  tstzmultirange,
  tstzrange,
} from "./range.js";
import { range } from "./range-type.js";
import { ltree, tsvector } from "./search.js";
import { char, citext, text, varchar } from "./text.js";
import { date, interval, time, timestamp, timestamptz, timetz } from "./time.js";

/**
 * Postgres column builders.
 */
export const t = {
  id,
  identity,
  integerIdentity,
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
  tstzmultirange,
  datemultirange,
  int4multirange,
  int8multirange,
  nummultirange,
  range,
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
  composite,
  custom,
};
