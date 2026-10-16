/**
 * Exported surface of each generated pack.
 */

import { expectTypeOf } from "expect-type";

import type { BtreeGin } from "../src/dialects/pg/ext/btree-gin.js";
import type { BtreeGist } from "../src/dialects/pg/ext/btree-gist.js";
import type { Fuzzystrmatch } from "../src/dialects/pg/ext/fuzzystrmatch.js";
import type { Hstore } from "../src/dialects/pg/ext/hstore.js";
import type { Ltree } from "../src/dialects/pg/ext/ltree.js";
import type { Pgcrypto } from "../src/dialects/pg/ext/pgcrypto.js";
import type { Unaccent } from "../src/dialects/pg/ext/unaccent.js";
import { btreeGin } from "../src/dialects/pg/ext/btree-gin.js";
import { btreeGist } from "../src/dialects/pg/ext/btree-gist.js";
import { fuzzystrmatch } from "../src/dialects/pg/ext/fuzzystrmatch.js";
import { hstore } from "../src/dialects/pg/ext/hstore.js";
import { ltree } from "../src/dialects/pg/ext/ltree.js";
import { pgcrypto } from "../src/dialects/pg/ext/pgcrypto.js";
import { unaccent } from "../src/dialects/pg/ext/unaccent.js";
import type { Fragment } from "../src/dialects/pg/ops/fragment.js";
import type { IndexCall } from "../src/dialects/pg/table.js";

expectTypeOf(unaccent).returns.toEqualTypeOf<Unaccent>();
expectTypeOf<Parameters<Unaccent["unaccent"]>>().toEqualTypeOf<[value: string]>();
expectTypeOf<ReturnType<Unaccent["unaccent"]>>().toEqualTypeOf<Fragment>();

expectTypeOf(hstore).returns.toEqualTypeOf<Hstore>();
expectTypeOf<Parameters<Hstore["hasKey"]>>().toEqualTypeOf<[value: string]>();
expectTypeOf<ReturnType<Hstore["gin"]>>().toEqualTypeOf<IndexCall>();
expectTypeOf<ReturnType<Hstore["gist"]>>().toEqualTypeOf<IndexCall>();

expectTypeOf(ltree).returns.toEqualTypeOf<Ltree>();
expectTypeOf<Parameters<Ltree["ancestorOf"]>>().toEqualTypeOf<[value: string]>();
expectTypeOf<ReturnType<Ltree["descendantOf"]>>().toEqualTypeOf<Fragment>();
expectTypeOf<ReturnType<Ltree["gist"]>>().toEqualTypeOf<IndexCall>();

expectTypeOf(btreeGist).returns.toEqualTypeOf<BtreeGist>();
expectTypeOf<Parameters<BtreeGist["gist"]>>().toEqualTypeOf<[column: string]>();
expectTypeOf<ReturnType<BtreeGist["gist"]>>().toEqualTypeOf<IndexCall>();

expectTypeOf(btreeGin).returns.toEqualTypeOf<BtreeGin>();
expectTypeOf<ReturnType<BtreeGin["gin"]>>().toEqualTypeOf<IndexCall>();

expectTypeOf(fuzzystrmatch).returns.toEqualTypeOf<Fuzzystrmatch>();
expectTypeOf<Parameters<Fuzzystrmatch["levenshtein"]>>().toEqualTypeOf<
  [value: string, distance: number]
>();
expectTypeOf<ReturnType<Fuzzystrmatch["daitchMokotoff"]>>().toEqualTypeOf<Fragment>();

expectTypeOf(pgcrypto).returns.toEqualTypeOf<Pgcrypto>();
expectTypeOf<Parameters<Pgcrypto["digest"]>>().toEqualTypeOf<[algorithm: string, hex: string]>();
expectTypeOf<ReturnType<Pgcrypto["fipsMode"]>>().toEqualTypeOf<Fragment>();
