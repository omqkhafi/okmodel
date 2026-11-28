/**
 * `okmodel/pg` for Cloudflare Workers.
 *
 * Wrangler bundles this file under the `workerd` export condition. A Workers
 * script has no `import.meta.url`, so `createRequire` cannot see
 * `catalog-compile.js`. `schema()` installs the compilers first. The function
 * is declared here so a `sideEffects: false` bundle keeps that call. Node
 * resolves the `import` condition and does not load this file.
 */

import type { Catalog } from "../../contracts/catalog/types.js";
import { compileCatalog } from "./catalog-compile.js";
import type { CatalogCompileInput } from "./catalog-draft.js";
import {
  installCatalogCompiler,
  installCompileExclusion,
  type CompileExclusion,
} from "./catalog-load.js";
import { compileExclusion } from "./exclusion.js";
import { schema as buildSchema, type SchemaInput } from "./schema.js";
import type { AnyTable } from "./table.js";

/**
 * Installs the compilers `schema()` and the first `.catalog` read call.
 *
 * Called from {@link schema} so the bundler cannot drop it.
 */
function arm(): void {
  installCatalogCompiler(compileCatalog as (input: CatalogCompileInput) => Catalog);
  installCompileExclusion(compileExclusion as CompileExclusion);
}

/**
 * Builds a schema after the Workers compilers are installed.
 *
 * @param config - Same input as `schema()` on the Node entry
 * @returns The query model, with `.catalog` compiled by the installed function
 */
export const schema = ((config: SchemaInput<readonly AnyTable[]>) => {
  arm();
  return buildSchema(config as never);
}) as typeof buildSchema;

export {
  withOwner,
  external,
  index,
  sql,
  table,
  custom,
  ColumnBuilder,
  bigint,
  identity,
  integer,
  integerIdentity,
  smallint,
  double,
  numeric,
  real,
  boolean,
  bytea,
  jsonb,
  jsonReplacer,
  id,
  uuid,
  char,
  citext,
  text,
  varchar,
  date,
  interval,
  loadTimeCodecs,
  time,
  timestamp,
  timestamptz,
  timetz,
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
  range,
  cidr,
  inet,
  macaddr,
  macaddr8,
  line,
  point,
  ltree,
  tsvector,
  domain,
  enum,
  composite,
  t,
  bucket,
  denseRank,
  rank,
  rowNumber,
  runningTotal,
  between,
  containedBy,
  contains,
  endsWith,
  eq,
  every,
  gt,
  inc,
  gte,
  has,
  hasAnyKey,
  hasKey,
  ilike,
  inList,
  like,
  matches,
  relevance,
  lt,
  lte,
  none,
  not,
  notIn,
  and,
  or,
  overlaps,
  adjacent,
  before,
  after,
  isEmpty,
  path,
  startsWith,
  fragment,
  ident,
  explain,
  raw,
  trusted,
  registerRawLock,
  many,
  manyThrough,
  morph,
  morphMany,
  morphTo,
  one,
  arr,
  json,
} from "./index.js";
