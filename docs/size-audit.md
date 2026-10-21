# Size audit

This is an internal report for the size and hygiene pass. It does not change `src/` or a gate. The byte tables are the committed baseline [`tests/fixtures/size-attribution.json`](../tests/fixtures/size-attribution.json), written by [`scripts/size-attribution.ts`](../scripts/size-attribution.ts). Dead exports are the output of [`scripts/dead-exports.ts`](../scripts/dead-exports.ts). Duplicate groups are the output of [`scripts/duplicates.ts`](../scripts/duplicates.ts).

## How a byte is counted

Runtime and startup graphs use the same build as [`scripts/size.ts`](../scripts/size.ts): `bun build --minify` with no plugin for the runtime entry, and `Bun.build` with the dynamic-import stub for the app and each connect entry. Each source module's minified bytes are the generated ranges in an external sourcemap. Bun appends a debug-id comment on that second build. The script strips the comment and fails if the JavaScript is otherwise different, so the ranges describe the gated file. A few ranges step back by a handful of columns. They are sorted, and each byte is kept by the range whose column is the greatest at or before it. The module bytes plus the unattributed remainder sum to the file. Gzip shares are that graph's gzip (level 9, startup chunk ids normalised) allocated by minified weight. This run had no unattributed bytes, and every total matched `size.ts` with a gap of 0. The allowed gap is 8 bytes.

`bytesInOutput` is not used for those graphs. On the featureless app it summed to about 139 bytes more than the file, because shared bytes are counted in more than one input.

Adapter incremental bytes are `bytesInOutput` for inputs that are not already in the runtime entry. That sum is the gate. Gzip for an adapter is an estimate: the adapter file's gzip is shared across every input, and only the unique modules are kept. There is no incremental gzip gate.

## Per-graph totals

| Graph | Minified | Gzip | Min gate | Gzip gate | Min left | Gzip left |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `runtime` | 5,288 | 2,026 | 6,100 | 2,250 | 812 | 224 |
| `app` | 90,879 | 29,769 | 90,900 | 30,170 | 21 | 401 |
| `connect:src/runtime/pg/postgresjs.ts` | 40,111 | 14,273 | 42,450 | 14,920 | 2,339 | 647 |
| `connect:src/runtime/pg/pglite.ts` | 39,205 | 13,757 | 40,450 | 14,280 | 1,245 | 523 |
| `connect:src/runtime/pg/pg.ts` | 40,952 | 14,368 | 42,850 | 15,070 | 1,898 | 702 |
| `connect:src/runtime/pg/bun.ts` | 39,877 | 14,023 | 41,700 | 14,620 | 1,823 | 597 |
| `connect:src/runtime/pg/neon.ts` | 40,725 | 14,206 | 42,000 | 14,500 | 1,275 | 294 |
| `adapter:src/adapters/pg/postgresjs.ts` | 15,909 | 5,946 (estimate) | 16,000 | none | 91 |  |
| `adapter:src/adapters/pg/pglite.ts` | 11,923 | 4,397 (estimate) | 12,010 | none | 87 |  |

The tight minified gates are the featureless app and the two adapter incrementals. Headroom is the Min left column. Connect startup graphs are every row whose id starts with `connect:`.

## Top modules

The script prints 25. The baseline lists every module.

### `runtime`

| Module | Minified | Gzip share |
| --- | ---: | ---: |
| `src/contracts/error.ts` | 5,288 | 2,026 |

### `app`

| Module | Minified | Gzip share |
| --- | ---: | ---: |
| `src/dialects/pg/schema.ts` | 17,250 | 5,651 |
| `src/runtime/plan.ts` | 14,743 | 4,829 |
| `src/runtime/client.ts` | 8,826 | 2,891 |
| `src/contracts/catalog/object.ts` | 6,251 | 2,048 |
| `src/contracts/error.ts` | 4,977 | 1,630 |
| `src/dialects/pg/column.ts` | 4,943 | 1,619 |
| `src/adapters/pg/postgresjs.ts` | 4,913 | 1,609 |
| `src/contracts/catalog/identity.ts` | 2,658 | 871 |
| `src/contracts/sha256.ts` | 2,023 | 663 |
| `src/dialects/pg/array-literal.ts` | 1,847 | 605 |
| `src/dialects/pg/compile.ts` | 1,743 | 571 |
| `src/dialects/pg/table.ts` | 1,559 | 511 |
| `src/contracts/catalog/json.ts` | 1,378 | 451 |
| `src/contracts/catalog/identifier.ts` | 1,220 | 400 |
| `src/adapters/pg/result.ts` | 1,146 | 375 |
| `src/contracts/catalog/order.ts` | 1,143 | 374 |
| `src/contracts/utf8.ts` | 1,114 | 365 |
| `src/dialects/pg/keys.ts` | 1,021 | 334 |
| `src/dialects/pg/decimal.ts` | 969 | 317 |
| `src/contracts/nearest.ts` | 906 | 297 |
| `scripts/app-startup.ts` | 861 | 282 |
| `src/contracts/catalog/build.ts` | 829 | 272 |
| `src/contracts/catalog/words.ts` | 805 | 264 |
| `src/dialects/pg/temporal.ts` | 693 | 227 |
| `src/dialects/pg/filters.ts` | 684 | 224 |
| 22 more, in the baseline | | |

### `connect:src/runtime/pg/postgresjs.ts`

| Module | Minified | Gzip share |
| --- | ---: | ---: |
| `src/runtime/plan.ts` | 14,608 | 5,198 |
| `src/runtime/client.ts` | 8,848 | 3,148 |
| `src/adapters/pg/postgresjs.ts` | 4,948 | 1,761 |
| `src/contracts/error.ts` | 4,941 | 1,758 |
| `src/adapters/pg/result.ts` | 1,142 | 406 |
| `src/contracts/nearest.ts` | 906 | 322 |
| `src/contracts/catalog/words.ts` | 805 | 286 |
| `src/contracts/catalog/identifier.ts` | 736 | 262 |
| `src/adapters/error.ts` | 732 | 261 |
| `src/runtime/pg/postgresjs.ts` | 726 | 258 |
| `src/adapters/pg/call.ts` | 603 | 215 |
| `src/contracts/utf8.ts` | 451 | 161 |
| `src/adapters/failure.ts` | 325 | 116 |
| `src/dialects/pg/operators.ts` | 150 | 53 |
| `src/adapters/capabilities.ts` | 123 | 44 |
| `src/runtime/safety-hook.ts` | 67 | 24 |

### `connect:src/runtime/pg/pglite.ts`

| Module | Minified | Gzip share |
| --- | ---: | ---: |
| `src/runtime/plan.ts` | 14,602 | 5,124 |
| `src/runtime/client.ts` | 8,856 | 3,108 |
| `src/contracts/error.ts` | 4,959 | 1,740 |
| `src/adapters/pg/pglite.ts` | 3,942 | 1,383 |
| `src/adapters/pg/result.ts` | 1,146 | 402 |
| `src/contracts/nearest.ts` | 906 | 318 |
| `src/contracts/catalog/words.ts` | 805 | 282 |
| `src/contracts/catalog/identifier.ts` | 736 | 258 |
| `src/runtime/pg/pglite.ts` | 735 | 258 |
| `src/adapters/error.ts` | 732 | 257 |
| `src/adapters/pg/call.ts` | 600 | 211 |
| `src/contracts/utf8.ts` | 451 | 158 |
| `src/adapters/failure.ts` | 340 | 119 |
| `src/dialects/pg/operators.ts` | 150 | 53 |
| `src/adapters/capabilities.ts` | 123 | 43 |
| `src/runtime/safety-hook.ts` | 67 | 24 |
| `src/adapters/pg/no-inflight-timeout.ts` | 55 | 19 |

### `connect:src/runtime/pg/pg.ts`

| Module | Minified | Gzip share |
| --- | ---: | ---: |
| `src/runtime/plan.ts` | 14,572 | 5,113 |
| `src/runtime/client.ts` | 8,884 | 3,117 |
| `src/contracts/error.ts` | 4,965 | 1,742 |
| `src/adapters/pg/nodepostgres.ts` | 3,535 | 1,240 |
| `src/adapters/pg/session.ts` | 2,100 | 737 |
| `src/adapters/pg/result.ts` | 1,146 | 402 |
| `src/contracts/nearest.ts` | 900 | 316 |
| `src/runtime/pg/pg.ts` | 862 | 302 |
| `src/contracts/catalog/words.ts` | 805 | 282 |
| `src/contracts/catalog/identifier.ts` | 736 | 258 |
| `src/adapters/error.ts` | 732 | 257 |
| `src/adapters/pg/call.ts` | 601 | 211 |
| `src/contracts/utf8.ts` | 451 | 158 |
| `src/adapters/failure.ts` | 323 | 113 |
| `src/dialects/pg/operators.ts` | 150 | 53 |
| `src/adapters/capabilities.ts` | 123 | 43 |
| `src/runtime/safety-hook.ts` | 67 | 24 |

### `connect:src/runtime/pg/bun.ts`

| Module | Minified | Gzip share |
| --- | ---: | ---: |
| `src/runtime/plan.ts` | 14,625 | 5,143 |
| `src/runtime/client.ts` | 8,841 | 3,109 |
| `src/contracts/error.ts` | 4,953 | 1,742 |
| `src/adapters/pg/bunsql.ts` | 2,337 | 822 |
| `src/adapters/pg/session.ts` | 2,101 | 739 |
| `src/adapters/pg/result.ts` | 1,116 | 392 |
| `src/runtime/pg/bun.ts` | 909 | 320 |
| `src/contracts/nearest.ts` | 906 | 319 |
| `src/contracts/catalog/words.ts` | 805 | 283 |
| `src/contracts/catalog/identifier.ts` | 736 | 259 |
| `src/adapters/error.ts` | 732 | 257 |
| `src/adapters/pg/call.ts` | 609 | 214 |
| `src/contracts/utf8.ts` | 451 | 159 |
| `src/adapters/failure.ts` | 360 | 126 |
| `src/dialects/pg/operators.ts` | 150 | 53 |
| `src/adapters/capabilities.ts` | 123 | 43 |
| `src/runtime/safety-hook.ts` | 67 | 23 |
| `src/adapters/pg/no-inflight-timeout.ts` | 56 | 20 |

### `connect:src/runtime/pg/neon.ts`

| Module | Minified | Gzip share |
| --- | ---: | ---: |
| `src/runtime/plan.ts` | 14,620 | 5,100 |
| `src/runtime/client.ts` | 8,843 | 3,085 |
| `src/contracts/error.ts` | 4,953 | 1,728 |
| `src/adapters/pg/neon.ts` | 2,676 | 933 |
| `src/adapters/pg/session.ts` | 2,098 | 732 |
| `src/runtime/pg/neon.ts` | 1,151 | 402 |
| `src/adapters/pg/result.ts` | 1,138 | 397 |
| `src/contracts/nearest.ts` | 906 | 316 |
| `src/adapters/error.ts` | 873 | 305 |
| `src/contracts/catalog/words.ts` | 805 | 281 |
| `src/contracts/catalog/identifier.ts` | 736 | 257 |
| `src/adapters/pg/call.ts` | 609 | 212 |
| `src/contracts/utf8.ts` | 451 | 157 |
| `src/adapters/failure.ts` | 416 | 145 |
| `src/adapters/capabilities.ts` | 178 | 62 |
| `src/dialects/pg/operators.ts` | 150 | 52 |
| `src/runtime/safety-hook.ts` | 67 | 23 |
| `src/adapters/pg/no-inflight-timeout.ts` | 55 | 19 |

### `adapter:src/adapters/pg/postgresjs.ts`

| Module | Minified | Gzip share |
| --- | ---: | ---: |
| `src/adapters/pg/postgresjs.ts` | 4,937 | 1,845 |
| `src/adapters/pg/postgres-extra.ts` | 3,956 | 1,479 |
| `src/adapters/error.ts` | 2,151 | 804 |
| `src/adapters/pg/result.ts` | 1,157 | 432 |
| `src/contracts/connection.ts` | 1,034 | 387 |
| `src/adapters/pg/batch.ts` | 946 | 354 |
| `src/adapters/pg/call.ts` | 615 | 230 |
| `src/adapters/pg/watch.ts` | 531 | 198 |
| `src/adapters/failure.ts` | 337 | 126 |
| `src/adapters/capabilities.ts` | 140 | 52 |
| `src/adapters/lazy-errors.ts` | 105 | 39 |

### `adapter:src/adapters/pg/pglite.ts`

| Module | Minified | Gzip share |
| --- | ---: | ---: |
| `src/adapters/pg/pglite.ts` | 3,867 | 1,426 |
| `src/adapters/error.ts` | 2,148 | 792 |
| `src/adapters/pg/result.ts` | 1,142 | 421 |
| `src/contracts/connection.ts` | 1,034 | 381 |
| `src/adapters/pg/batch.ts` | 946 | 349 |
| `src/adapters/pg/call.ts` | 599 | 221 |
| `src/adapters/pg/pglite-wire.ts` | 557 | 206 |
| `src/adapters/pg/watch.ts` | 526 | 194 |
| `src/adapters/failure.ts` | 405 | 149 |
| `src/adapters/pg/reserved.ts` | 350 | 129 |
| `src/adapters/lazy-errors.ts` | 172 | 64 |
| `src/adapters/capabilities.ts` | 123 | 45 |
| `src/adapters/pg/no-inflight-timeout.ts` | 54 | 20 |

## What the featureless app still carries that an app without relations, tenancy, archive or presets does not need

`scripts/app-startup.ts` builds ten tables with `schema()`, then calls `connect().users.find()`. It does not use relations, tenancy, archive, or presets. The startup graph is 90,879 minified bytes and 47 modules.

These feature modules are already absent. Archive, presets, include decode, text search, window, and exposure are dynamic imports. Morph and through resolvers are tree-shaken. The tenancy methods behind the tenancy subpath are not on this graph.

What remains from those four features:

| Module | Minified | Gzip share | Why it is still linked |
| --- | ---: | ---: | --- |
| `src/dialects/pg/tenancy.ts` | 265 | 87 | `schema()` calls `readTenancy` even when the schema has no tenancy. The file is the stub, not the tenancy implementation. |
| `src/dialects/pg/relations.ts` | 169 | 55 | `schema()` calls `isRelationCall` while compiling every table. The rest of the relation module is shaken. |
| `src/dialects/pg/schema.ts` | 17,250 | 5,651 | `resolveRelations`, the tenancy rewrite pass, and the archive, preset, and trait field copies live in this compiler. They run for a schema that sets none of them. |
| `src/runtime/plan.ts` | 14,743 | 4,829 | `emitWhere` calls `holdArchive` on every read. Relation join and filter emitters stay because the calls are static. Archive phrases are already a hook and stay out. |
| `src/runtime/client.ts` | 8,826 | 2,891 | The read handle checks tenancy, archive, and presets, then dynamic-imports presets and include only when the call uses them. The checks stay. |

The rest of the 90,879 bytes is the catalog compiler, column builders, `OkmError`, SHA-256 for identifier overflow, and the postgres.js adapter `find()` needs. An app that does not call `find()` would drop the adapter, the client, and the planner. This fixture calls `find()`, and the connect gates are that same planner without `schema.ts`.

Every module on this graph:

| Module | Minified | Gzip share |
| --- | ---: | ---: |
| `src/dialects/pg/schema.ts` | 17,250 | 5,651 |
| `src/runtime/plan.ts` | 14,743 | 4,829 |
| `src/runtime/client.ts` | 8,826 | 2,891 |
| `src/contracts/catalog/object.ts` | 6,251 | 2,048 |
| `src/contracts/error.ts` | 4,977 | 1,630 |
| `src/dialects/pg/column.ts` | 4,943 | 1,619 |
| `src/adapters/pg/postgresjs.ts` | 4,913 | 1,609 |
| `src/contracts/catalog/identity.ts` | 2,658 | 871 |
| `src/contracts/sha256.ts` | 2,023 | 663 |
| `src/dialects/pg/array-literal.ts` | 1,847 | 605 |
| `src/dialects/pg/compile.ts` | 1,743 | 571 |
| `src/dialects/pg/table.ts` | 1,559 | 511 |
| `src/contracts/catalog/json.ts` | 1,378 | 451 |
| `src/contracts/catalog/identifier.ts` | 1,220 | 400 |
| `src/adapters/pg/result.ts` | 1,146 | 375 |
| `src/contracts/catalog/order.ts` | 1,143 | 374 |
| `src/contracts/utf8.ts` | 1,114 | 365 |
| `src/dialects/pg/keys.ts` | 1,021 | 334 |
| `src/dialects/pg/decimal.ts` | 969 | 317 |
| `src/contracts/nearest.ts` | 906 | 297 |
| `scripts/app-startup.ts` | 861 | 282 |
| `src/contracts/catalog/build.ts` | 829 | 272 |
| `src/contracts/catalog/words.ts` | 805 | 264 |
| `src/dialects/pg/temporal.ts` | 693 | 227 |
| `src/dialects/pg/filters.ts` | 684 | 224 |
| `src/contracts/catalog/enum.ts` | 648 | 212 |
| `src/runtime/pg/postgresjs.ts` | 613 | 201 |
| `src/adapters/pg/call.ts` | 604 | 198 |
| `src/dialects/pg/integer.ts` | 499 | 163 |
| `src/dialects/pg/json.ts` | 487 | 160 |
| `src/contracts/location.ts` | 435 | 143 |
| `src/contracts/generator.ts` | 332 | 109 |
| `src/adapters/failure.ts` | 330 | 108 |
| `src/dialects/pg/floor.ts` | 297 | 97 |
| `src/dialects/pg/quote.ts` | 283 | 93 |
| `src/dialects/pg/bool.ts` | 270 | 88 |
| `src/dialects/pg/tenancy.ts` | 265 | 87 |
| `src/dialects/pg/time.ts` | 224 | 73 |
| `src/dialects/pg/operators.ts` | 190 | 62 |
| `src/dialects/pg/relations.ts` | 169 | 55 |
| `src/dialects/pg/finite.ts` | 168 | 55 |
| `src/dialects/pg/misuse.ts` | 140 | 46 |
| `src/contracts/catalog/types.ts` | 132 | 43 |
| `src/dialects/pg/text.ts` | 125 | 41 |
| `src/runtime/safety-hook.ts` | 67 | 22 |
| `src/adapters/capabilities.ts` | 66 | 22 |
| `src/dialects/pg/ops/eq.ts` | 33 | 11 |

## Candidate savings

Ranked by estimated minified bytes that could leave a gated graph. Gzip is the same graph's share, or the source-line fraction of that share when the saving is inside one module. A source-line fraction is an upper bound, not a measurement: the bundler was not rebuilt with the split.

1. **Hash identifier overflow in a separate chunk.** Measured: `src/contracts/sha256.ts` is 2,023 minified and 663 gzip on the app, and on no connect graph. `identifier.ts` imports it to suffix a name that does not fit. The featureless schema never takes that branch. `utf8.ts` (1,114 / 365) stays, because every name goes through it. Risk: medium. `schema()` is synchronous, and the suffix is part of the stored name. A dynamic import would change that path for long names only.

2. **Stop compiling relations, tenancy, archive, and presets inside a featureless `schema()`.** Measured leaves that would leave with the import: `relations.ts` 169 / 55 and `tenancy.ts` 265 / 87. The in-file compilers are about 240 lines of `schema.ts` (about 1,750 lines): `resolveRelations`, the rewrite pass, and the trait, archive, and preset helpers. That fraction of this module is about 2,366 minified and 775 gzip, and it double-counts helpers the catalog compiler still needs, so treat 2,366 as a ceiling. Adding the leaves, the ceiling is about 2,800 minified and 917 gzip, on the app only. Connect graphs do not include `schema.ts`. Risk: high. `schema()` is synchronous and always calls `resolveRelations`. The archive-phrase hook is the pattern that already keeps a feature off this path. The catalog shape is public.

3. **Make the archive predicate and the relation SQL emitters lazy inside `plan.ts`.** `holdArchive`, `withRowFilters`, and the relation join and filter emitters are about 140 lines of about 1,550. That fraction is about 1,332 minified and 436 gzip, on the app and on every connect graph. Most of that is the relation SQL. `holdArchive` itself is about 12 lines, on the order of 100 bytes. A featureless `find()` does not filter on a relation and has no archive predicate. The include chunk is already lazy. Risk: high for the relation emitters, because a `where` on a relation still plans in this file. Risk: medium for turning `holdArchive` into the same kind of hook as the archive phrases.

4. **Do not spend a gate on dead exports.** 273 exports are unused by `src/`, `tests/`, and `scripts/` and are not on the public surface. 198 are types. A value export nothing imports is already absent from the minified graph, including `cell` in `result.ts`, which its own file never calls. `needsWatch`, `sqlOf`, and `verifyRead` are used in the same file, so dropping the export saves no bytes. Four names are imported by the harness and must stay: `Counters` and `DriverError` in `src/adapters/pg/neon.ts` and `src/adapters/pg/nodepostgres.ts`, from `packages/harness/src/driver-run.ts`. Risk of deleting those four: the harness stops typechecking. Gated saving: none.

5. **Do not spend a gate on cross-adapter clones.** 935 duplicate windows. The largest are `checkout` and `open` across the Bun.sql, node-postgres, Neon, and postgres.js extras, about 700 to 1,500 whitespace-stripped bytes for one copy (names not mangled, so this is an upper bound). Each adapter is its own bundle. A shared helper of the same size is still linked into that bundle, so the incremental gate barely moves. The postgres.js extra module is 3,956 of the 15,909 incremental bytes. Risk of editing checkout: high, for a saving the gate would not see.

Nothing else on the featureless graph is a feature module waiting to be made lazy. `plan.ts` and `client.ts` are the cost of `find()`. `schema.ts` apart from the compilers in candidate 2 is the cost of `schema()`.

## Dead exports

dead-exports: 273
src/adapters/capabilities.ts:19 CapabilityName type
src/adapters/pg/bun-sql.ts:42 SQLListen type
src/adapters/pg/bun-sql.ts:10 SQLQuery type
src/adapters/pg/call.ts:31 needsWatch
src/adapters/pg/neon.ts:75 Counters type  outside packages/harness/src/driver-run.ts
src/adapters/pg/neon.ts:48 DriverError  outside packages/harness/src/driver-run.ts
src/adapters/pg/nodepostgres.ts:67 Counters type  outside packages/harness/src/driver-run.ts
src/adapters/pg/nodepostgres.ts:37 DriverError  outside packages/harness/src/driver-run.ts
src/adapters/pg/result.ts:18 cell
src/adapters/pg/session.ts:24 NoticeBuffer type
src/adapters/pg/session.ts:21 WireSender type
src/contracts/catalog/enum.ts:79 DomainTypeInput type
src/contracts/catalog/enum.ts:24 EnumTypeInput type
src/contracts/catalog/extension.ts:21 ExtensionInput type
src/contracts/catalog/index.ts:49 TypeDefinition type
src/contracts/catalog/index.ts:50 TypeObject type
src/contracts/catalog/order.ts:15 IndexedObject type
src/contracts/catalog/policy.ts:28 PolicyInput type
src/contracts/catalog/privilege.ts:42 DefaultPrivilegeInput type
src/contracts/catalog/privilege.ts:32 GrantInput type
src/contracts/catalog/privilege.ts:22 RoleInput type
src/contracts/catalog/routine.ts:33 FunctionInput type
src/contracts/catalog/routine.ts:50 TriggerInput type
src/contracts/catalog/types.ts:572 DefaultPrivilegeDefinition type
src/contracts/catalog/types.ts:340 EnumDefinition type
src/contracts/catalog/types.ts:565 GrantDefinition type
src/contracts/catalog/types.ts:555 RoleDefinition type
src/contracts/catalog/view.ts:45 MaterializedViewIndexInput type
src/contracts/catalog/view.ts:40 MaterializedViewInput type
src/contracts/catalog/view.ts:27 ViewInput type
src/contracts/generator.ts:10 CLIENT_DEFAULT
src/contracts/generator.ts:13 GeneratorName type
src/dialects/ddl.ts:59 DdlAllow type
src/dialects/ddl.ts:49 DdlBackfill type
src/dialects/ddl.ts:38 DdlEmulatedNote type
src/dialects/pg/bool.ts:55 decodeBoolean
src/dialects/pg/bool.ts:85 decodeBytea
src/dialects/pg/bool.ts:43 encodeBoolean
src/dialects/pg/bool.ts:71 encodeBytea
src/dialects/pg/column.ts:174 InsertKind type
src/dialects/pg/column.ts:316 OpenColumn type
src/dialects/pg/column.ts:732 RequiredBody type
src/dialects/pg/column.ts:105 WithUpdateGuard type
src/dialects/pg/column.ts:829 sqlOf
src/dialects/pg/compile.ts:48 CompileColumnInput type
src/dialects/pg/compile.ts:59 CompiledColumn type
src/dialects/pg/decimal.ts:119 decodeNumericNumber
src/dialects/pg/decimal.ts:107 encodeNumericNumber
src/dialects/pg/declarations.ts:16 SchemaDeclarations type
src/dialects/pg/emit.ts:20 JsonColumnTypes type
src/dialects/pg/ext/feature.ts:15 FeatureNeed type
src/dialects/pg/ext/versions.ts:9 ExtSignature type
src/dialects/pg/floor.ts:9 POSTGRES_MAJORS
src/dialects/pg/geometry.ts:94 decodeLine
src/dialects/pg/geometry.ts:68 decodePoint
src/dialects/pg/geometry.ts:84 encodeLine
src/dialects/pg/geometry.ts:58 encodePoint
src/dialects/pg/integer.ts:202 decodeBigintValue
src/dialects/pg/integer.ts:160 encodeBigintNumber
src/dialects/pg/integer.ts:192 encodeBigintValue
src/dialects/pg/json.ts:79 decodeJson
src/dialects/pg/keys.ts:18 IdDefault type
src/dialects/pg/misuse.ts:18 CODEC_VALUE_CODE
src/dialects/pg/misuse.ts:12 COLUMN_DEFINITION_CODE
src/dialects/pg/misuse.ts:15 RESERVED_OPTION_CODE
src/dialects/pg/model.ts:74 MorphTarget type
src/dialects/pg/model.ts:156 PlannedTable type
src/dialects/pg/model.ts:164 RelationPlanner type
src/dialects/pg/model.ts:149 RelationSink type
src/dialects/pg/operator-fit.ts:13 OperatorFamily type
src/dialects/pg/operator-fit.ts:79 columnFamily
src/dialects/pg/operators.ts:121 JsonSetValue type
src/dialects/pg/operators.ts:82 PathValue type
src/dialects/pg/operators.ts:112 TrigramQuery type
src/dialects/pg/ops/bucket.ts:45 BucketInput type
src/dialects/pg/ops/fragment.ts:34 FragmentColumn type
src/dialects/pg/preset.ts:44 Preset type
src/dialects/pg/preset.ts:93 RESERVED_PRESETS
src/dialects/pg/preset.ts:52 ReservedPreset type
src/dialects/pg/relations.ts:105 ThroughKeys type
src/dialects/pg/role/index.ts:41 ColumnGrantInput type
src/dialects/pg/role/index.ts:27 ManagedRole type
src/dialects/pg/role/index.ts:58 RoleDeclarationReason type
src/dialects/pg/role/index.ts:164 contributeRoles
src/dialects/pg/role/sql.ts:20 PrivilegeSql type
src/dialects/pg/role/sql.ts:30 PrivilegeStatement type
src/dialects/pg/schema.ts:238 SchemaWithTraits type
src/dialects/pg/schema.ts:208 TenancySchema type
src/dialects/pg/search.ts:44 encodeLtree
src/dialects/pg/table-safe.ts:14 NotNullStep type
src/dialects/pg/table.ts:212 Handles type
src/dialects/pg/table.ts:100 IndexChain type
src/dialects/pg/trait.ts:18 ArchiveRequest type
src/dialects/pg/where.ts:28 IsObject type
src/dialects/pg/where.ts:93 WhereValue type
src/runtime/ids/okid.ts:75 OKID_ALPHABET
src/runtime/ids/okid.ts:76 OKID_DEFAULT_LENGTH
src/runtime/ids/okid.ts:77 OKID_LOOKALIKE_CHARS
src/runtime/ids/okid.ts:78 OKID_MAX_LENGTH
src/runtime/ids/okid.ts:79 OKID_MAX_PREFIX_LENGTH
src/runtime/ids/okid.ts:80 OKID_MIN_LENGTH
src/runtime/ids/okid.ts:81 OKID_SORTABLE_ALPHABET
src/runtime/ids/okid.ts:82 OKID_SORTABLE_MIN_LENGTH
src/runtime/plan.ts:258 Bound type
src/runtime/plan.ts:182 MorphOut type
src/runtime/plan.ts:1254 ParsedMorphTarget type
src/runtime/plan.ts:35 RouteConstraint type
src/runtime/plan.ts:175 ScalarOut type
src/runtime/plan.ts:518 verifyRead
src/runtime/safety-hook.ts:23 SafetyHook type
src/runtime/tenancy/index-shape.ts:16 IndexShapeCall type
src/runtime/tenancy/path.ts:40 PathChain type
src/runtime/tenancy/path.ts:20 PathHop type
src/runtime/tenancy/path.ts:17 TableKind type
src/runtime/tenancy/path.ts:392 declaredPrimary
src/runtime/tenancy/rls.ts:260 runReadOnly
src/runtime/tenancy/rls.ts:290 streamHeld
src/runtime/types.ts:493 AggregateOptions type
src/runtime/types.ts:546 AggregateRow type
src/runtime/types.ts:879 ArchiveCount type
src/runtime/types.ts:593 Endpoint type
src/runtime/types.ts:28 FieldWhere type
src/runtime/types.ts:376 FindOptions type
src/runtime/types.ts:214 IncludeOf type
src/runtime/types.ts:678 InsertOptions type
src/runtime/types.ts:370 LockOptions type
src/runtime/types.ts:668 OnConflict type
src/runtime/types.ts:179 OrderBy type
src/runtime/types.ts:471 PageOptions type
src/runtime/types.ts:431 Query type
src/runtime/types.ts:443 Read type
src/runtime/types.ts:353 ReadOptions type
src/runtime/types.ts:66 RelFilter type
src/runtime/types.ts:38 RelationsOf type
src/runtime/types.ts:330 ResultRow type
src/runtime/types.ts:624 Router type
src/runtime/types.ts:31 RowOf type
src/runtime/types.ts:270 Selected type
src/runtime/types.ts:416 SyncHandle type
src/runtime/types.ts:411 SyncOptions type
src/runtime/types.ts:405 SyncResult type
src/runtime/types.ts:924 TableExtras type
src/runtime/types.ts:618 Target type
src/runtime/types.ts:194 TextSearch type
src/runtime/types.ts:612 Topology type
src/runtime/types.ts:391 TreeOptions type
src/runtime/types.ts:660 UpdateSet type
src/runtime/types.ts:805 UpdateTarget type
src/runtime/types.ts:169 WhereOf type
src/runtime/types.ts:28 WhereValue type
src/runtime/types.ts:732 Write type
src/runtime/types.ts:709 WriteColumn type
src/runtime/types.ts:706 WriteColumnLabel type
src/runtime/types.ts:703 WriteCount type
src/runtime/types.ts:715 WriteDescription type
src/runtime/types.ts:723 WriteInspection type
src/runtime/types.ts:691 WriteOptions type
src/runtime/validate/rules.ts:18 EmailRule type
src/runtime/validate/rules.ts:15 LowerRule type
src/runtime/validate/rules.ts:21 MinRule type
src/runtime/validate/rules.ts:39 PhaseRule type
src/runtime/validate/rules.ts:24 PredicateRule type
src/runtime/validate/rules.ts:12 TrimRule type
src/runtime/validate/rules.ts:32 WhenRule type
src/runtime/validate/surface.ts:44 ValidationOn type
src/runtime/warnings/catalog.ts:28 WarningAlternative type
src/runtime/warnings/catalog.ts:19 WarningEvidence type
src/runtime/warnings/catalog.ts:34 WarningHatch type
src/runtime/warnings/catalog.ts:16 WarningPhase type
src/runtime/warnings/catalog.ts:152 warningRule
src/tooling/agents/block.ts:17 AgentsBlockInput type
src/tooling/capabilities/check.ts:14 FEATURE_REFUSAL_DOCS
src/tooling/capabilities/index.ts:16 CapabilityGate type
src/tooling/capabilities/index.ts:16 EmulatedNote type
src/tooling/capabilities/index.ts:15 PostgresFeature type
src/tooling/capabilities/index.ts:16 Support type
src/tooling/capabilities/index.ts:9 emulationOf
src/tooling/capabilities/index.ts:17 featuresUsed
src/tooling/capabilities/index.ts:11 gateCoverageProblems
src/tooling/cli/envelope.ts:16 CLI_SCHEMA
src/tooling/cli/envelope.ts:25 CliEnvelope type
src/tooling/cli/envelope.ts:13 CliErrorBody type
src/tooling/cli/notices.ts:9 CliNotice type
src/tooling/cli/outcome.ts:112 CliPartial type
src/tooling/cli/outcome.ts:233 exitCodeForOutcome
src/tooling/cli/outcome.ts:197 outcomeOf
src/tooling/cli/outcome.ts:96 readOutcome
src/tooling/cli/schema.ts:13 JsonSchema type
src/tooling/cli/spec.ts:14 FlagSpec type
src/tooling/cli/spec.ts:63 GLOBAL_FLAGS
src/tooling/describe/nullability.ts:41 ColumnNullability type
src/tooling/describe/protocol.ts:20 DescribeColumn type
src/tooling/describe/protocol.ts:17 DescribeTls type
src/tooling/describe/provider.ts:15 DescribeSqlInput type
src/tooling/describe/scan.ts:30 DEFAULT_RAW_INCLUDE
src/tooling/describe/sync.ts:49 lockStatement
src/tooling/errors/examples.ts:130 OfflineExample type
src/tooling/errors/page.ts:112 errorPageFile
src/tooling/errors/shape.ts:52 BYPASS_TOKENS
src/tooling/errors/shape.ts:39 CliErrorDetail type
src/tooling/github/post-comment.ts:29 postPlanComment
src/tooling/init/engine.ts:103 InitChoices type
src/tooling/init/engine.ts:53 InitFileAction type
src/tooling/init/engine.ts:56 InitFileData type
src/tooling/init/engine.ts:50 InitFileState type
src/tooling/init/engine.ts:87 InitWrite type
src/tooling/init/guards.ts:13 INIT_DRIVERS
src/tooling/init/guards.ts:19 INIT_PACKAGE_MANAGERS
src/tooling/init/guards.ts:25 INIT_TENANCY
src/tooling/init/guards.ts:28 InitTenancy type
src/tooling/init/guards.ts:189 isInitTenancy
src/tooling/init/paths.ts:90 initProjectPath
src/tooling/init/paths.ts:102 mayReadProjectFile
src/tooling/migrate/backfill.ts:19 DEFAULT_BACKFILL_BATCH_SIZE
src/tooling/migrate/commands.ts:53 CommandIo type
src/tooling/migrate/engine.ts:21 UuidV7Default type
src/tooling/migrate/export.ts:22 EXPORT_FORMAT
src/tooling/migrate/export.ts:28 ExportColumn type
src/tooling/migrate/export.ts:35 ExportTable type
src/tooling/migrate/export.ts:177 LoadedSnapshot type
src/tooling/migrate/export.ts:135 databaseName
src/tooling/migrate/export.ts:110 parseSnapshot
src/tooling/migrate/ext-surface.ts:412 ExtensionProvides type
src/tooling/migrate/ext-surface.ts:390 isExtension
src/tooling/migrate/fingerprint.ts:13 PostgresEndpoint type
src/tooling/migrate/lint-rules.ts:55 ColumnRule type
src/tooling/migrate/lint-rules.ts:22 LintCategory type
src/tooling/migrate/lint-rules.ts:33 StepInput type
src/tooling/migrate/lint-rules.ts:45 StepRule type
src/tooling/migrate/pg-probe.ts:24 DefinitionVerdict type
src/tooling/migrate/plan-json.ts:35 DestructiveOperation type
src/tooling/migrate/plan-json.ts:44 PlanIdentity type
src/tooling/migrate/plan-json.ts:21 PlanStepJson type
src/tooling/migrate/plan.ts:130 StepAllow type
src/tooling/migrate/policy.ts:72 PolicySubject type
src/tooling/migrate/policy.ts:67 StoreOptions type
src/tooling/migrate/protected-store.ts:19 ProtectedStore type
src/tooling/migrate/protected-store.ts:25 StorePathInput type
src/tooling/migrate/pull-emit.ts:61 PullEmission type
src/tooling/migrate/pull-emit.ts:90 PullReview type
src/tooling/migrate/pull-routines.ts:52 PlannedFunction type
src/tooling/migrate/pull-routines.ts:61 PlannedTrigger type
src/tooling/migrate/pull-routines.ts:71 PlannedView type
src/tooling/migrate/pull-routines.ts:93 RenderedRoutines type
src/tooling/migrate/pull-routines.ts:43 RoutineSkip type
src/tooling/migrate/pull-routines.ts:26 RoutineStatus type
src/tooling/migrate/pull-routines.ts:412 matchNames
src/tooling/migrate/reference.ts:16 ReferenceValue type
src/tooling/migrate/reprint.ts:19 ReprintHit type
src/tooling/migrate/runner.ts:73 RunPolicy type
src/tooling/migrate/runner.ts:43 RunnableStep type
src/tooling/migrate/runner.ts:81 TargetRun type
src/tooling/migrate/runner.ts:98 TargetRunReport type
src/tooling/migrate/runner.ts:213 rolePrivilegeError
src/tooling/migrate/sandbox.ts:38 CheckMigration type
src/tooling/migrate/sandbox.ts:51 ReplayOutcome type
src/tooling/migrate/sandbox.ts:45 ReplayStop type
src/tooling/migrate/snapshot.ts:43 BASELINE_PREFIX
src/tooling/migrate/snapshot.ts:40 PROVISION_PREFIX
src/tooling/migrate/snapshot.ts:81 baselinedMigrationId
src/tooling/migrate/snapshot.ts:71 provisionedMigrationId
src/tooling/migrate/sql-lex.ts:365 SqlName type
src/tooling/migrate/step-engine.ts:20 StepMode type
src/tooling/migrate/step-engine.ts:208 stepFailureMessage
src/tooling/migrate/text.ts:11 MigrationTextReason type
src/tooling/testing/factories.ts:153 TenantScope type
src/tooling/testing/record.ts:19 Recorded type
src/tooling/testing/record.ts:25 Recording type
src/tooling/untrusted-paths.ts:15 UntrustedPath type
src/tooling/untrusted-paths.ts:12 UntrustedTreatment type
src/tooling/untrusted.ts:47 CHECKED_IDENTIFIER
src/tooling/untrusted.ts:58 UntrustedCaps type
src/tooling/untrusted.ts:101 isCheckedIdentifier

## Duplicate groups

The minified size on a function group is `estimateMinified`: comments and whitespace removed, string contents kept, names not mangled. It is an upper bound on one copy, not a gated-graph measurement. A literal group uses the same estimate on the literal text.

duplicates: 935
function 576ab327449d ~1534 minified bytes
  src/runtime/tenancy/rls.ts:489-550 wrapPool
  src/runtime/topology.ts:1153-1176 routePool
function 497aac35cf3d ~1474 minified bytes
  src/adapters/pg/bunsql-extra.ts:156-243 checkout
  src/adapters/pg/nodepostgres-extra.ts:81-113 checkout
function 2e6706b550a7 ~1350 minified bytes
  src/runtime/tenancy/composite.ts:84-151 compositeTenancy
  src/runtime/tenancy/index.ts:104-168 columnTenancy
function 69481c6a0fc1 ~1333 minified bytes
  src/adapters/pg/bunsql.ts:245-274 open
  src/adapters/pg/nodepostgres.ts:195-256 open
function e1bec513ae37 ~1250 minified bytes
  src/adapters/pg/neon.ts:244-268 openWebSocket
  src/adapters/pg/nodepostgres.ts:188-246 open
function a10baedfc45a ~1221 minified bytes
  src/adapters/pg/bunsql-extra.ts:169-243 checkout
  src/adapters/pg/nodepostgres-extra.ts:83-113 checkout
  src/adapters/pg/postgres-extra.ts:85-124 checkout
function 919332170b2c ~1165 minified bytes
  src/adapters/pg/neon.ts:284-325 openHttp
  src/adapters/pg/nodepostgres.ts:192-246 open
function 4ce949ed129a ~1097 minified bytes
  src/adapters/pg/neon.ts:247-268 openWebSocket
  src/adapters/pg/neon.ts:284-325 openHttp
function 6968a5239c3f ~836 minified bytes
  src/adapters/pg/bunsql-extra.ts:156-191 checkout
  src/adapters/pg/neon-extra.ts:69-89 checkout
function 38ac1852c801 ~721 minified bytes
  src/adapters/pg/neon-extra.ts:70-106 checkout
  src/adapters/pg/pglite.ts:83-110 lease
function cd9950961450 ~704 minified bytes
  src/runtime/tenancy/composite.ts:505-538 tenancyRules
  src/runtime/tenancy/index.ts:483-516 tenancyRules
function 957bef04863d ~671 minified bytes
  src/adapters/pg/neon-extra.ts:61-89 checkout
  src/adapters/pg/nodepostgres-extra.ts:73-93 checkout
function efabc66cefce ~658 minified bytes
  src/adapters/pg/neon.ts:146-179 connectClient
  src/adapters/pg/nodepostgres.ts:374-406 connectClient
function e4055f684fff ~657 minified bytes
  src/runtime/sync.ts:271-290 oneToMany
  src/runtime/sync.ts:365-384 manyThrough
function 31b4bda2b2c2 ~619 minified bytes
  src/dialects/pg/view/index.ts:247-270 view
  src/dialects/pg/view/index.ts:407-437 viewFrom
function 2531b279b289 ~618 minified bytes
  src/runtime/tenancy/composite.ts:253-275 rewriteTenant
  src/runtime/tenancy/index.ts:270-292 rewriteTenant
function 18cb8cd6b2d7 ~580 minified bytes
  src/dialects/pg/schema.ts:676-685 collectHooks
  src/tooling/migrate/project.ts:571-598 readSchemaSource
function 8187437f33bd ~579 minified bytes
  src/dialects/pg/schema.ts:677-685 collectHooks
  src/runtime/sync.ts:434-440 joinSlots
  src/tooling/migrate/project.ts:572-598 readSchemaSource
function 53af660fd2fa ~537 minified bytes
  src/dialects/pg/schema.ts:614-622 rewritePass
  src/tooling/testing/cleanup.ts:77-93 dropSteps
function 7b24f6099391 ~469 minified bytes
  src/contracts/catalog/document.ts:356-368 rewriteRenamed
  src/contracts/catalog/document.ts:756-771 rewriteTableName
function e6a97673bd05 ~465 minified bytes
  src/runtime/conflict.ts:331-348 refuseWrite
  src/runtime/write.ts:2543-2560 refuse
function b1cc6fcdde14 ~455 minified bytes
  src/contracts/catalog/document.ts:1008-1026 definitionToJson
  src/contracts/catalog/object.ts:183-199 column
function ca318e4dc15f ~428 minified bytes
  src/runtime/tree.ts:103-110 open
  src/tooling/migrate/apply.ts:363-372 applyTarget
function 5a158c8952b1 ~413 minified bytes
  src/runtime/tenancy/rls.ts:295-311 streamHeld
  src/runtime/topology.ts:1366-1382 (function)
function 0b137acdb314 ~412 minified bytes
  src/runtime/traits/index.ts:240-265 archivable
  src/runtime/traits/index.ts:313-338 sortable
function 292a0df2ef3f ~410 minified bytes
  src/runtime/pg/bun.ts:74-91 connect
  src/runtime/pg/pg.ts:67-84 connect
  src/runtime/pg/postgresjs.ts:67-84 connect
function a79708b11f58 ~406 minified bytes
  src/dialects/pg/compile.ts:118-124 compileColumn
  src/tooling/migrate/apply.ts:363-371 applyTarget
function 1b34da10d954 ~405 minified bytes
  src/runtime/tenancy/composite.ts:124-143 (function)
  src/runtime/tenancy/index.ts:144-163 (function)
function 43fa73113cd8 ~401 minified bytes
  src/tooling/migrate/export.ts:335-348 exportTables
  src/tooling/migrate/export.ts:379-389 externalTables
function 7f51812783be ~401 minified bytes
  src/runtime/pg/bun.ts:75-90 connect
  src/runtime/pg/neon.ts:87-102 (arrow)
  src/runtime/pg/pg.ts:68-83 connect
  src/runtime/pg/postgresjs.ts:68-83 connect
function 17c2e467885d ~394 minified bytes
  src/runtime/tenancy/composite.ts:165-180 rewriteTables
  src/runtime/tenancy/index.ts:182-197 rewriteTables
function 4fc3d00ec908 ~388 minified bytes
  src/dialects/pg/compile.ts:118-123 compileColumn
  src/runtime/pg/bun.ts:67-72 connect
  src/runtime/pg/neon.ts:66-71 (arrow)
  src/runtime/pg/neon.ts:79-84 connect
  src/runtime/pg/pg.ts:61-66 connect
  src/tooling/migrate/apply.ts:363-370 applyTarget
function 84daef29751a ~386 minified bytes
  src/adapters/pg/postgres-extra.ts:368-384 arm
  src/tooling/migrate/sandbox.ts:348-363 refuseWhenLost
function a3b0d0e5f540 ~384 minified bytes
  src/runtime/tenancy/composite.ts:215-226 refuseGlobalReference
  src/runtime/tenancy/index.ts:234-245 refuseGlobalReference
function 1522c1fecc3e ~383 minified bytes
  src/runtime/pg/bun.ts:61-73 connect
  src/runtime/pg/pg.ts:55-67 connect
function f4e200067e48 ~367 minified bytes
  src/tooling/testing/factories.ts:648-659 openScope
  src/tooling/testing/isolation.ts:683-694 openTenant
function f4df580c7774 ~360 minified bytes
  src/contracts/catalog/extension.ts:113-123 alignExtensionVersions
  src/tooling/migrate/sandbox.ts:562-570 extensionsAsLogical
function 1ae609e75728 ~355 minified bytes
  src/runtime/pg/bun.ts:76-91 connect
  src/runtime/pg/pg.ts:69-84 connect
  src/runtime/pg/pglite.ts:63-78 connect
  src/runtime/pg/postgresjs.ts:69-84 connect
function 9336de690bce ~355 minified bytes
  src/runtime/write.ts:973-987 pathSetUpdate
  src/runtime/write.ts:2237-2251 treeSetUpdate
function 0f08cd202b1b ~353 minified bytes
  src/runtime/pg/neon.ts:88-102 (arrow)
  src/runtime/pg/pglite.ts:63-77 connect
function 016c1652f47b ~351 minified bytes
  src/runtime/tenancy/composite.ts:411-428 refuseKey
  src/runtime/tenancy/index.ts:410-427 refuseKey
function 961d29f0fa9e ~351 minified bytes
  src/runtime/pg/bun.ts:77-90 connect
  src/runtime/pg/neon.ts:89-102 (arrow)
  src/runtime/pg/pg.ts:70-83 connect
  src/runtime/pg/pglite.ts:64-77 connect
  src/runtime/pg/postgresjs.ts:70-83 connect
  src/runtime/topology.ts:422-435 connectTopology
function e37bbcc2b216 ~346 minified bytes
  src/contracts/catalog/extension.ts:114-123 alignExtensionVersions
  src/tooling/migrate/sandbox.ts:563-570 extensionsAsLogical
  src/tooling/migrate/snapshot.ts:304-311 normaliseCatalog
function 0b52cba98d18 ~344 minified bytes
  src/tooling/migrate/lint-rules.ts:866-873 ownColumnCheckValidate
  src/tooling/migrate/lint-rules.ts:897-905 ownColumnSafe
function b86a2bf8ac34 ~343 minified bytes
  src/dialects/pg/compile.ts:118-123 compileColumn
  src/runtime/pg/neon.ts:66-71 (arrow)
function 9e32bb001054 ~340 minified bytes
  src/runtime/pg/neon.ts:78-86 connect
  src/runtime/pg/pg.ts:60-68 connect
function 0fbb336bc1f9 ~331 minified bytes
  src/runtime/ids/okid-generator.ts:40-45 optionsRecord
  src/runtime/plan.ts:1339-1344 rejectOptions
function c99d3e878749 ~331 minified bytes
  src/dialects/pg/fn/touch.ts:119-134 hasTrigger
  src/dialects/pg/fn/touch.ts:136-139 named
function eb734696e13d ~331 minified bytes
  src/runtime/ids/okid-generator.ts:40-46 optionsRecord
  src/runtime/read-stream.ts:190-196 pageFields
function 71171c844199 ~328 minified bytes
  src/tooling/migrate/pg-probe.ts:470-478 parseAddConstraint
  src/tooling/migrate/pg-probe.ts:516-524 constraintBody
function c33f082ab9c8 ~326 minified bytes
  src/tooling/migrate/apply.ts:303-314 applyTarget
  src/tooling/migrate/apply.ts:588-599 pushTarget
function 4765855c0b18 ~325 minified bytes
  src/tooling/describe/command.ts:60-70 runRawSync
  src/tooling/migrate/apply.ts:483-493 runApply
function d36d9b4876ac ~325 minified bytes
  src/runtime/pg/bun.ts:66-73 connect
  src/runtime/pg/neon.ts:78-85 connect
function e018290c0495 ~324 minified bytes
  src/tooling/errors/examples.ts:1143-1155 (arrow)
  src/tooling/errors/examples.ts:1157-1169 (arrow)
function 98feff67c27d ~322 minified bytes
  src/runtime/plan.ts:750-761 emitRead
  src/runtime/tree.ts:186-197 emitTree
function 263e1e6d3199 ~310 minified bytes
  src/runtime/pg/bun.ts:67-73 connect
  src/runtime/pg/neon.ts:66-72 (arrow)
  src/runtime/pg/pg.ts:61-67 connect
function 7ff9aba2965f ~306 minified bytes
  src/runtime/pg/bun.ts:67-73 connect
  src/runtime/pg/neon.ts:66-72 (arrow)
  src/runtime/pg/neon.ts:79-85 connect
  src/runtime/pg/pg.ts:61-67 connect
  src/runtime/tree.ts:104-110 open
function f4cf53b44ae3 ~304 minified bytes
  src/runtime/batch.ts:272-277 stampValidation
  src/runtime/tree.ts:105-110 open
  src/tooling/migrate/apply.ts:367-372 applyTarget
function 7e0a1fd474c1 ~302 minified bytes
  src/dialects/pg/archive-bind.ts:331-339 primaryFields
  src/runtime/tenancy/composite.ts:354-362 primaryFields
  src/runtime/tenancy/index.ts:364-372 primaryFields
  src/runtime/tenancy/path.ts:392-400 declaredPrimary
function 82e46a27aec9 ~301 minified bytes
  src/runtime/warnings/evaluate.ts:137-146 wideFanOut
  src/runtime/warnings/evaluate.ts:158-167 exceeds
function b248bb94ee97 ~301 minified bytes
  src/adapters/pg/nodepostgres.ts:141-152 open
  src/adapters/pg/postgresjs.ts:210-224 open
function 44834d753a1b ~300 minified bytes
  src/dialects/pg/schema.ts:622-633 rewritePass
  src/dialects/pg/schema.ts:691-702 collectHooks
function 9f444f6b7593 ~300 minified bytes
  src/adapters/pg/bunsql-extra.ts:171-179 (arrow)
  src/adapters/pg/bunsql-extra.ts:180-191 (arrow)
function e319c24564ac ~297 minified bytes
  src/dialects/pg/introspect.ts:1265-1278 unwrapTriggerWhen
  src/tooling/migrate/lint-rules.ts:588-601 unwrap
function 9042610b421d ~295 minified bytes
  src/contracts/catalog/view.ts:80-89 viewObject
  src/contracts/catalog/view.ts:109-118 materializedViewObject
function c54fbb6e3e69 ~295 minified bytes
  src/runtime/batch.ts:222-227 mapExtra
  src/runtime/batch.ts:242-247 at
function 7f4b87e3398f ~292 minified bytes
  src/tooling/migrate/export.ts:208-214 couplingFindings
  src/tooling/migrate/export.ts:458-464 hasCrossCatalogForeignKey
function 791cd893830d ~284 minified bytes
  src/tooling/errors/examples.ts:942-954 (arrow)
  src/tooling/migrate/baseline.ts:303-313 compareLive
function 8893c288acfc ~284 minified bytes
  src/contracts/catalog/document.ts:360-368 rewriteRenamed
  src/contracts/catalog/document.ts:763-771 rewriteTableName
  src/tooling/migrate/pull-verify.ts:135-143 copyFunction
function c88cb69c6251 ~283 minified bytes
  src/tooling/migrate/pg-probe.ts:450-459 parseDropIndex
  src/tooling/migrate/pg-probe.ts:650-659 alterTable
function d51a852c7860 ~280 minified bytes
  src/runtime/topology.ts:909-914 openEndpoint
  src/runtime/tree.ts:105-110 open
  src/tooling/migrate/apply.ts:367-372 applyTarget
function 8b532e79e65b ~279 minified bytes
  src/runtime/batch.ts:272-277 stampValidation
  src/runtime/pg/bun.ts:68-73 connect
  src/runtime/pg/neon.ts:80-85 connect
  src/runtime/pg/pg.ts:62-67 connect
function 837801408ea6 ~277 minified bytes
  src/runtime/pg/neon.ts:80-86 connect
  src/runtime/pg/pg.ts:62-68 connect
  src/runtime/topology.ts:909-915 openEndpoint
function ffd66018713f ~277 minified bytes
  src/runtime/ids/okid-generator.ts:41-46 optionsRecord
  src/tooling/errors/body.ts:145-150 warningBody
function 61bb4c0a3733 ~276 minified bytes
  src/dialects/pg/archive-bind.ts:307-314 isArchivable
  src/runtime/sort-bind.ts:115-122 archivable
function 98026aa373d3 ~276 minified bytes
  src/contracts/catalog/document.ts:464-473 rewriteColumn
  src/contracts/catalog/document.ts:572-581 rewriteConstraint
function a44d69ece7d7 ~276 minified bytes
  src/contracts/catalog/document.ts:1009-1016 definitionToJson
  src/contracts/catalog/object.ts:184-190 column
  src/dialects/pg/compile.ts:117-121 compileColumn
function f75425587633 ~276 minified bytes
  src/dialects/pg/lower.ts:628-637 order
  src/tooling/migrate/plan.ts:1989-1998 order
function a112ba6d442f ~273 minified bytes
  src/contracts/catalog/document.ts:393-402 rewriteRenamed
  src/contracts/catalog/document.ts:894-903 rewriteSequence
function a1dc27893c61 ~273 minified bytes
  src/runtime/observe-emit.ts:374-386 overflowError
  src/runtime/observe.ts:200-212 observerBufferOverflow
function 585a01e769d5 ~272 minified bytes
  src/runtime/plan.ts:1339-1344 rejectOptions
  src/runtime/read-stream.ts:190-195 pageFields
function b5eebaa76d02 ~271 minified bytes
  src/runtime/batch.ts:272-277 stampValidation
  src/runtime/pg/bun.ts:68-73 connect
  src/runtime/topology.ts:909-914 openEndpoint
function 8f9b43513c4a ~270 minified bytes
  src/runtime/pg/neon.ts:67-72 (arrow)
  src/runtime/topology.ts:909-914 openEndpoint
function c33c378d2b10 ~270 minified bytes
  src/runtime/batch.ts:272-277 stampValidation
  src/runtime/pg/neon.ts:67-72 (arrow)
function 051173e9cbf8 ~268 minified bytes
  src/tooling/testing/isolation.ts:133-145 readTenant
  src/tooling/testing/isolation.ts:552-563 readFiltered
function e127db53b220 ~265 minified bytes
  src/runtime/plan.ts:772-780 emitRead
  src/runtime/window.ts:122-130 (arrow)
function 948dd1422c48 ~264 minified bytes
  src/tooling/migrate/lint-rules.ts:832-838 notNullFloorValidate
  src/tooling/migrate/lint-rules.ts:856-862 ownColumnCheckValidate
function 8546af217f91 ~259 minified bytes
  src/runtime/archive.ts:514-524 requireFilter
  src/runtime/write.ts:2389-2399 requireFilter
function 947d735bb927 ~259 minified bytes
  src/tooling/migrate/baseline.ts:215-227 runBaseline
  src/tooling/migrate/resolve.ts:194-206 resolveOnTarget
function efceac155478 ~259 minified bytes
  src/contracts/catalog/document.ts:893-901 rewriteSequence
  src/tooling/migrate/pull-verify.ts:134-142 copyFunction
function e596a580b734 ~258 minified bytes
  src/contracts/catalog/document.ts:763-770 rewriteTableName
  src/contracts/catalog/document.ts:894-901 rewriteSequence
function 29e9fe2ff7c7 ~257 minified bytes
  src/adapters/pg/postgres-extra.ts:132-144 describe
  src/tooling/describe/provider.ts:55-67 resultFromOutcome
function a04d6abdca08 ~257 minified bytes
  src/tooling/errors/examples.ts:1561-1572 (arrow)
  src/tooling/errors/examples.ts:1574-1585 (arrow)
function 72b1502ec281 ~253 minified bytes
  src/dialects/pg/errors.ts:179-183 safeCause
  src/runtime/ids/okid-generator.ts:40-44 optionsRecord
  src/runtime/plan.ts:1339-1343 rejectOptions
  src/runtime/read-stream.ts:190-194 pageFields
function 96ded7aeedd8 ~253 minified bytes
  src/contracts/catalog/document.ts:472-478 rewriteColumn
  src/contracts/catalog/document.ts:1010-1016 definitionToJson
  src/contracts/catalog/object.ts:185-190 column
function c8b7f439c2bf ~252 minified bytes
  src/runtime/client.ts:344-350 batchHandle
  src/runtime/sync.ts:145-152 build
function 378ad3ff1284 ~251 minified bytes
  src/tooling/migrate/resolve.ts:251-262 committed
  src/tooling/migrate/runner.ts:430-441 committedOf
function dc8e70b6c8f3 ~251 minified bytes
  src/dialects/pg/ext/hstore.ts:47-60 hstore
  src/dialects/pg/ext/ltree.ts:47-60 ltree
function f426aef6aef0 ~251 minified bytes
  src/adapters/pg/pglite.ts:342-349 (function)
  src/adapters/pg/session.ts:42-49 (function)
function a8f02fbd9452 ~248 minified bytes
  src/tooling/errors/body.ts:79-87 errorBody
  src/tooling/errors/body.ts:163-171 fillDoc
function c692f8ef318d ~247 minified bytes
  src/contracts/catalog/document.ts:1010-1016 definitionToJson
  src/contracts/catalog/object.ts:185-190 column
  src/runtime/pg/neon.ts:66-69 (arrow)
function 4a4ea3b3ae94 ~246 minified bytes
  src/adapters/pg/bunsql.ts:136-142 open
  src/adapters/pg/neon.ts:208-214 openWebSocket
function 8cdf4fb8d816 ~246 minified bytes
  src/adapters/pg/neon.ts:149-161 (arrow)
  src/adapters/pg/nodepostgres.ts:377-388 (arrow)
function 8f2c33925f4c ~246 minified bytes
  src/dialects/pg/compile.ts:118-121 compileColumn
  src/dialects/pg/fn/index.ts:237-240 (arrow)
  src/runtime/pg/bun.ts:67-70 connect
  src/runtime/pg/neon.ts:66-69 (arrow)
  src/runtime/pg/neon.ts:79-82 connect
  src/runtime/pg/pg.ts:61-64 connect
  src/tooling/migrate/apply.ts:363-368 applyTarget
  src/tooling/migrate/apply.ts:700-705 pushTarget
function 3e9af0e1b123 ~245 minified bytes
  src/adapters/pg/neon-extra.ts:73-79 (arrow)
  src/adapters/pg/neon-extra.ts:80-89 (arrow)
function 3dcc9cb99486 ~244 minified bytes
  src/runtime/sort.ts:209-218 groupField
  src/runtime/write.ts:1608-1617 traitGroup
function 2d0bb1a3b1d7 ~243 minified bytes
  src/runtime/tenancy/rls.ts:581-591 runScopedRead
  src/runtime/tenancy/rls.ts:638-648 (function)
function 3e92ebc48c40 ~243 minified bytes
  src/contracts/catalog/document.ts:1031-1037 definitionToJson
  src/tooling/migrate/commands.ts:766-774 invokeOf
function f543071765c9 ~243 minified bytes
  src/runtime/archive-handle.ts:94-102 lifecycle
  src/runtime/client.ts:426-434 writeHandle
function ddb5dd29911c ~242 minified bytes
  src/runtime/observe-emit.ts:292-297 (function)
  src/tooling/migrate/commands.ts:766-773 invokeOf
function 9f2ae02b08fa ~241 minified bytes
  src/dialects/pg/compile.ts:116-120 compileColumn
  src/tooling/migrate/commands.ts:766-772 invokeOf
function 6a9cdbb98476 ~240 minified bytes
  src/runtime/read-stream.ts:191-196 pageFields
  src/tooling/errors/body.ts:145-150 warningBody
function 9e6513be5ecb ~239 minified bytes
  src/contracts/catalog/object.ts:184-189 column
  src/runtime/observe-emit.ts:293-296 (function)
  src/tooling/migrate/commands.ts:767-772 invokeOf
function 2ad5bba613be ~238 minified bytes
  src/runtime/pg/bun.ts:81-90 connect
  src/runtime/pg/neon.ts:93-102 (arrow)
  src/runtime/pg/pg.ts:74-83 connect
  src/runtime/pg/pglite.ts:68-77 connect
  src/runtime/pg/postgresjs.ts:74-83 connect
  src/runtime/topology.ts:464-473 (arrow)
function 48c38ed9c5c3 ~238 minified bytes
  src/contracts/error.ts:643-647 fromDriver
  src/runtime/topology.ts:908-912 openEndpoint
function 4fefde9298dd ~237 minified bytes
  src/runtime/topology.ts:426-435 connectTopology
  src/runtime/topology.ts:464-473 (arrow)
function 01c7e899e8a3 ~236 minified bytes
  src/tooling/errors/examples.ts:1591-1600 (arrow)
  src/tooling/errors/examples.ts:1603-1610 (arrow)
function 0a7cd31be37f ~235 minified bytes
  src/tooling/migrate/pull-emit.ts:226-239 emitPull
  src/tooling/migrate/pull-emit.ts:614-627 planTable
function c1fa7af51ac5 ~235 minified bytes
  src/dialects/pg/schema.ts:1465-1475 (arrow)
  src/tooling/errors/registry.ts:993-1003 warningDoc
function 280abd2bdee0 ~233 minified bytes
  src/tooling/migrate/pg-probe.ts:473-478 parseAddConstraint
  src/tooling/migrate/pg-probe.ts:485-490 parseValidate
  src/tooling/migrate/pg-probe.ts:519-524 constraintBody
function 3e1a1eabc566 ~232 minified bytes
  src/contracts/catalog/document.ts:1031-1036 definitionToJson
  src/runtime/observe-emit.ts:292-297 (function)
function 2bca5516ee5b ~231 minified bytes
  src/tooling/migrate/pull-verify.ts:140-146 copyFunction
  src/tooling/migrate/pull-verify.ts:172-176 copyMatview
function 6850b7abd5cc ~230 minified bytes
  src/runtime/transaction.ts:253-259 once
  src/runtime/transaction.ts:391-397 nested
function 9bed1ac9f0f9 ~230 minified bytes
  src/tooling/migrate/drift.ts:114-127 sealDomainChecks
  src/tooling/migrate/drift.ts:158-171 sealTableChecks
function e7b52c264601 ~229 minified bytes
  src/runtime/sync.ts:274-282 oneToMany
  src/runtime/sync.ts:368-376 manyThrough
  src/runtime/sync.ts:473-481 parentLock
function 62c4ffbeccb0 ~227 minified bytes
  src/contracts/catalog/document.ts:1010-1016 definitionToJson
  src/contracts/catalog/object.ts:185-190 column
  src/dialects/pg/fn/index.ts:237-240 (arrow)
  src/runtime/pg/bun.ts:67-70 connect
  src/runtime/pg/neon.ts:79-82 connect
  src/runtime/pg/pg.ts:61-64 connect
  src/tooling/migrate/apply.ts:363-368 applyTarget
  src/tooling/migrate/apply.ts:700-705 pushTarget
function 692e2de3ae1b ~227 minified bytes
  src/runtime/batch.ts:273-277 stampValidation
  src/runtime/topology.ts:910-914 openEndpoint
  src/runtime/tree.ts:106-110 open
  src/tooling/migrate/apply.ts:700-706 pushTarget
function bc3879cf3086 ~225 minified bytes
  src/runtime/tenancy/composite.ts:332-339 widenReference
  src/runtime/tenancy/index.ts:339-346 widenReference
function 722e7207b54a ~224 minified bytes
  src/dialects/pg/errors.ts:179-183 safeCause
  src/tooling/errors/body.ts:145-149 warningBody
function 40a32117578a ~221 minified bytes
  src/runtime/plan.ts:1339-1344 rejectOptions
  src/tooling/errors/body.ts:145-150 warningBody
function ca5364c5d1d5 ~221 minified bytes
  src/runtime/include.ts:583-591 decodeRowIncluded
  src/runtime/include.ts:616-624 decodeInclude
function 10b5295c1a9a ~220 minified bytes
  src/adapters/pg/pglite.ts:91-98 (arrow)
  src/adapters/pg/pglite.ts:114-125 (function)
function 30da436bb3d8 ~220 minified bytes
  src/runtime/include.ts:599-606 decodeInclude
  src/runtime/include.ts:627-634 decodeJsonInclude
function e0e22ee12797 ~220 minified bytes
  src/dialects/pg/schema.ts:1465-1474 (arrow)
  src/runtime/topology.ts:463-472 (arrow)
  src/tooling/errors/registry.ts:993-1002 warningDoc
function 000c4e712580 ~219 minified bytes
  src/tooling/migrate/apply.ts:710-720 pushTarget
  src/tooling/migrate/baseline.ts:217-227 runBaseline
function cee998154ebc ~218 minified bytes
  src/contracts/catalog/document.ts:1032-1036 definitionToJson
  src/runtime/observe-emit.ts:293-297 (function)
  src/runtime/traits/index.ts:96-100 trait
  src/tooling/migrate/commands.ts:767-773 invokeOf
function 0b52a1c6ea94 ~217 minified bytes
  src/tooling/testing/factories.ts:390-394 assignForeign
  src/tooling/testing/factories.ts:463-467 paired
function a52e4f8a56d5 ~217 minified bytes
  src/tooling/migrate/apply.ts:476-484 runApply
  src/tooling/migrate/apply.ts:538-546 pushProject
function 195e65c11f99 ~214 minified bytes
  src/tooling/migrate/place.ts:169-178 relocateEdges
  src/tooling/migrate/snapshot.ts:349-358 normaliseViewColumns
function 214599331c9c ~213 minified bytes
  src/tooling/errors/examples.ts:1548-1555 (arrow)
  src/tooling/errors/examples.ts:1591-1599 (arrow)
  src/tooling/errors/examples.ts:1603-1610 (arrow)
function e040b85c86c5 ~213 minified bytes
  src/runtime/plan.ts:901-911 emitPredicate
  src/runtime/window.ts:169-179 emitResultOrder
function e56c1484f0aa ~213 minified bytes
  src/tooling/migrate/apply.ts:390-400 applyTarget
  src/tooling/migrate/baseline.ts:217-227 runBaseline
function 5c7e622d4911 ~212 minified bytes
  src/contracts/catalog/document.ts:1040-1047 definitionToJson
  src/dialects/pg/schema.ts:1464-1471 (arrow)
function 6fa8ac2e06c5 ~212 minified bytes
  src/contracts/error.ts:644-648 fromDriver
  src/dialects/pg/fn/index.ts:237-241 (arrow)
function e87be89c8e91 ~212 minified bytes
  src/adapters/pg/neon-extra.ts:90-104 (function)
  src/adapters/pg/nodepostgres-extra.ts:97-111 (function)
function 1b4fd7d92108 ~211 minified bytes
  src/dialects/pg/through.ts:27-32 (arrow)
  src/runtime/plan.ts:790-795 emitJoin
function a44606e4d426 ~211 minified bytes
  src/tooling/migrate/apply.ts:307-314 applyTarget
  src/tooling/migrate/apply.ts:592-599 pushTarget
  src/tooling/migrate/resolve.ts:149-156 resolveOnTarget
function d229d5da9f44 ~211 minified bytes
  src/contracts/catalog/document.ts:1041-1047 definitionToJson
  src/tooling/errors/registry.ts:993-999 warningDoc
function fdf7ca5c3bee ~210 minified bytes
  src/tooling/migrate/plan.ts:1344-1349 dataSteps
  src/tooling/migrate/plan.ts:1380-1385 requireReplacements
function 100bccb4819e ~209 minified bytes
  src/contracts/catalog/document.ts:1165-1170 parseObject
  src/contracts/catalog/document.ts:1585-1590 parsePolicy
function 32896e82c71c ~208 minified bytes
  src/tooling/migrate/server-requirements.ts:95-104 assertSchemaExtensions
  src/tooling/migrate/server-requirements.ts:118-127 assertSchemaRequirements
function 82d4c4e7125b ~208 minified bytes
  src/dialects/pg/errors.ts:558-563 valuesOf
  src/tooling/testing/factories.ts:459-464 paired
function 0227ee48bc05 ~207 minified bytes
  src/tooling/describe/scan.ts:478-489 readQuoted
  src/tooling/describe/scan.ts:502-513 readTemplate
function ca112fd8c733 ~206 minified bytes
  src/tooling/migrate/drift.ts:193-200 (function)
  src/tooling/migrate/pull.ts:237-244 (function)
function 8b7a00ef7b1b ~205 minified bytes
  src/contracts/catalog/privilege.ts:92-102 grantObject
  src/contracts/catalog/privilege.ts:121-131 defaultPrivilegeObject
function 8deda5838a2e ~205 minified bytes
  src/contracts/catalog/document.ts:1041-1047 definitionToJson
  src/dialects/pg/schema.ts:1465-1471 (arrow)
  src/runtime/tenancy/via.ts:110-116 (arrow)
  src/runtime/topology.ts:463-469 (arrow)
  src/tooling/cli/envelope.ts:102-108 serializeEnvelope
  src/tooling/errors/registry.ts:993-999 warningDoc
function d3a438f94abe ~205 minified bytes
  src/runtime/topology.ts:1902-1907 leastConnections
  src/runtime/topology.ts:1919-1924 latencyAware
function d8c62753de6e ~205 minified bytes
  src/tooling/migrate/apply.ts:747-755 restampHeadHash
  src/tooling/migrate/apply.ts:868-876 restampLegacy
function da4a7127505a ~205 minified bytes
  src/tooling/migrate/plan.ts:1103-1107 recreateRoutineDependents
  src/tooling/migrate/plan.ts:1173-1180 recreateViewDependents
function a8829321245f ~204 minified bytes
  src/tooling/migrate/ext-surface.ts:136-144 readSurface
  src/tooling/migrate/pull-routines.ts:347-352 renderRoutines
function e1209c6ac860 ~204 minified bytes
  src/runtime/plan.ts:900-910 emitPredicate
  src/runtime/plan.ts:1161-1171 emitOrder
function 1ab555f378e0 ~202 minified bytes
  src/runtime/observe-emit.ts:294-296 (function)
  src/runtime/pg/neon.ts:66-68 (arrow)
  src/runtime/traits/index.ts:97-99 trait
  src/tooling/migrate/commands.ts:768-772 invokeOf
function 40015c13ae18 ~202 minified bytes
  src/adapters/pg/neon-extra.ts:34-43 checkout
  src/adapters/pg/nodepostgres.ts:340-349 trackCheckout
function 7b67fbe474f5 ~202 minified bytes
  src/tooling/migrate/runner.ts:777-782 isLockTimeout
  src/tooling/migrate/step-engine.ts:423-428 isLockTimeout
function 7ef187b723b8 ~202 minified bytes
  src/tooling/migrate/ext.ts:45-50 extProject
  src/tooling/migrate/ext.ts:226-231 withServer
function 8ffd6d9bf993 ~202 minified bytes
  src/tooling/errors/examples.ts:731-740 (arrow)
  src/tooling/errors/examples.ts:766-775 (arrow)
function 6511ed9624be ~200 minified bytes
  src/tooling/migrate/apply.ts:1029-1037 provisionEmpty
  src/tooling/migrate/apply.ts:1112-1120 insertReference
function ee991890ebe6 ~200 minified bytes
  src/runtime/write.ts:2194-2197 keyedId
  src/tooling/migrate/plan.ts:921-927 pairSameShape
function 28c91da358ef ~199 minified bytes
  src/runtime/include.ts:205-212 emitIncludeJoin
  src/runtime/include.ts:301-308 emitNestedAggregate
function 626ed45901bd ~199 minified bytes
  src/contracts/catalog/document.ts:871-879 rewriteType
  src/contracts/catalog/document.ts:897-905 rewriteSequence
function c09517810872 ~199 minified bytes
  src/contracts/catalog/document.ts:94-101 renameColumn
  src/contracts/catalog/document.ts:131-138 renameTable
function f55cf2af3c4a ~199 minified bytes
  src/runtime/conflict.ts:244-254 updateColumns
  src/runtime/sql-fragment.ts:153-162 writeIdent
function 1ae815114148 ~198 minified bytes
  src/runtime/topology.ts:1185-1190 (arrow)
  src/runtime/topology.ts:1269-1274 (arrow)
function e7d55dfde480 ~198 minified bytes
  src/runtime/archive.ts:506-512 expectOf
  src/runtime/sync.ts:726-732 expectOf
function 50550915ff71 ~197 minified bytes
  src/runtime/archive.ts:507-512 expectOf
  src/runtime/sync.ts:727-732 expectOf
  src/runtime/write.ts:2469-2474 expectOf
function b3ce6608fc29 ~197 minified bytes
  src/contracts/error.ts:643-647 fromDriver
  src/dialects/pg/compile.ts:155-159 compileColumn
function de8be9126ad6 ~197 minified bytes
  src/tooling/migrate/baseline.ts:257-264 reportJson
  src/tooling/testing/facts.ts:143-151 readViews
function 31752372b35b ~195 minified bytes
  src/contracts/catalog/document.ts:620-627 rewritePolicyColumn
  src/contracts/catalog/document.ts:807-814 rewriteTableName
function a2c23aa64e8a ~194 minified bytes
  src/tooling/errors/examples.ts:741-747 (arrow)
  src/tooling/errors/examples.ts:776-782 (arrow)
function a5f8a92f49cc ~194 minified bytes
  src/dialects/pg/archive-bind.ts:299-304 applies
  src/runtime/sort-bind.ts:45-50 applies
function d705d142a619 ~194 minified bytes
  src/dialects/pg/schema.ts:1252-1256 compileForeignKeys
  src/runtime/archive.ts:442-446 joinOn
literal 304ceb2a3237 ~194 minified bytes x3
  src/tooling/migrate/apply.ts:1059
  src/tooling/migrate/baseline.ts:204
  src/tooling/migrate/step-journal.ts:111
function 23ad582577cc ~193 minified bytes
  src/dialects/pg/through.ts:26-30 (arrow)
  src/tooling/testing/factories.ts:387-391 assignForeign
function c3b5371f6801 ~193 minified bytes
  src/dialects/pg/through.ts:26-31 (arrow)
  src/runtime/sync.ts:245-250 oneToMany
function 35d6b4989f4b ~192 minified bytes
  src/runtime/archive.ts:277-284 archiveSql
  src/runtime/archive.ts:361-368 restoreSql
function 87ea3a91a057 ~192 minified bytes
  src/dialects/pg/through.ts:27-31 (arrow)
  src/runtime/plan.ts:790-794 emitJoin
  src/runtime/sync.ts:246-250 oneToMany
  src/runtime/sync.ts:447-451 joinSlots
function 9b30bf8a9342 ~192 minified bytes
  src/tooling/migrate/pg-probe.ts:384-389 parseCreateIndex
  src/tooling/migrate/pg-probe.ts:449-454 parseDropIndex
function e40998462bc2 ~192 minified bytes
  src/runtime/sync.ts:245-249 oneToMany
  src/runtime/sync.ts:440-444 joinSlots
  src/tooling/testing/factories.ts:387-391 assignForeign
literal cddfeb861f13 ~192 minified bytes x2
  src/dialects/pg/temporal.ts:9
  src/runtime/bucket-group.ts:275
function 6cca268e991a ~191 minified bytes
  src/runtime/plan.ts:790-793 emitJoin
  src/tooling/testing/factories.ts:388-391 assignForeign
function 893a84edbdef ~191 minified bytes
  src/adapters/pg/bunsql.ts:252-261 (function)
  src/adapters/pg/neon.ts:257-266 (function)
  src/adapters/pg/pglite.ts:126-135 (function)
function 47d9730401e2 ~190 minified bytes
  src/tooling/migrate/runner.ts:761-768 failStep
  src/tooling/migrate/sandbox.ts:663-670 failStep
function c2602acfd071 ~190 minified bytes
  src/contracts/catalog/document.ts:391-397 rewriteRenamed
  src/contracts/catalog/document.ts:615-621 rewritePolicyColumn
function 06ddc851cb54 ~188 minified bytes
  src/tooling/migrate/plan.ts:395-399 planMigration
  src/tooling/testing/cleanup.ts:95-100 dropSteps
function a78a750228f3 ~188 minified bytes
  src/dialects/pg/compile.ts:155-159 compileColumn
  src/runtime/topology.ts:908-912 openEndpoint
function 381e837a69a2 ~187 minified bytes
  src/contracts/catalog/document.ts:528-530 indexAgain
  src/contracts/catalog/object.ts:185-189 column
  src/contracts/catalog/object.ts:251-253 index
  src/contracts/catalog/view.ts:165-167 materializedViewIndex
  src/dialects/pg/compile.ts:118-120 compileColumn
  src/dialects/pg/fn/index.ts:237-239 (arrow)
  src/dialects/pg/schema.ts:1275-1277 (arrow)
  src/runtime/observe-emit.ts:294-296 (function)
  src/runtime/pg/bun.ts:67-69 connect
  src/runtime/pg/neon.ts:66-68 (arrow)
  src/runtime/pg/neon.ts:79-81 connect
  src/runtime/pg/pg.ts:61-63 connect
  src/runtime/traits/index.ts:97-99 trait
  src/tooling/migrate/apply.ts:363-367 applyTarget
  src/tooling/migrate/commands.ts:768-772 invokeOf
function d991d78f04f0 ~187 minified bytes
  src/runtime/batch.ts:270-273 stampValidation
  src/runtime/write.ts:2678-2681 scrubWrite
function 04c1d66ec909 ~186 minified bytes
  src/tooling/init/detect.ts:68-78 scanProject
  src/tooling/init/package-json.ts:105-115 parsePackage
function 8240bd67caa9 ~186 minified bytes
  src/dialects/pg/morph.ts:242-251 (arrow)
  src/runtime/include.ts:532-541 emitMorphJoin
function ac00b77e8311 ~186 minified bytes
  src/tooling/migrate/pull-verify.ts:154-160 copyView
  src/tooling/migrate/pull-verify.ts:170-176 copyMatview
function 056729ef331c ~185 minified bytes
  src/runtime/conflict.ts:244-252 updateColumns
  src/runtime/plan.ts:1302-1310 selectedColumns
  src/runtime/sql-fragment.ts:153-161 writeIdent
function 5835870878ea ~185 minified bytes
  src/runtime/tenancy/rls.ts:552-556 wrapPool
  src/runtime/topology.ts:1280-1286 force
function 6e76fbc60f05 ~185 minified bytes
  src/runtime/sort.ts:262-265 readOne
  src/runtime/sort.ts:328-331 moveStatement
function dfe3f888eaec ~185 minified bytes
  src/contracts/catalog/object.ts:184-189 column
  src/dialects/pg/compile.ts:117-120 compileColumn
  src/runtime/traits/index.ts:96-99 trait
function f78734256c87 ~185 minified bytes
  src/contracts/catalog/document.ts:396-402 rewriteRenamed
  src/contracts/catalog/document.ts:821-827 rewriteTableName
  src/contracts/catalog/document.ts:871-877 rewriteType
function f9443a56919d ~185 minified bytes
  src/contracts/catalog/document.ts:1033-1036 definitionToJson
  src/contracts/catalog/object.ts:251-254 index
  src/runtime/observe-emit.ts:294-297 (function)
  src/tooling/migrate/commands.ts:768-773 invokeOf
function fe456be55cea ~185 minified bytes
  src/runtime/validate/engine.ts:296-302 applyTransforms
  src/runtime/validate/engine.ts:315-321 checkRules
function fcf8e61d0555 ~184 minified bytes
  src/contracts/catalog/document.ts:528-531 indexAgain
  src/contracts/catalog/document.ts:1033-1036 definitionToJson
  src/contracts/catalog/object.ts:251-254 index
  src/contracts/catalog/view.ts:165-168 materializedViewIndex
  src/dialects/pg/schema.ts:1275-1278 (arrow)
  src/runtime/observe-emit.ts:294-297 (function)
  src/runtime/traits/index.ts:97-100 trait
  src/tooling/migrate/apply.ts:651-654 pushTarget
  src/tooling/migrate/commands.ts:768-773 invokeOf
function 1dfb8674eaa9 ~183 minified bytes
  src/contracts/catalog/document.ts:869-875 rewriteType
  src/tooling/migrate/pull-verify.ts:134-140 copyFunction
function b507dfe53ee3 ~183 minified bytes
  src/contracts/catalog/document.ts:469-473 rewriteColumn
  src/contracts/catalog/document.ts:496-501 rewriteIndex
function 20a95de2ceed ~182 minified bytes
  src/runtime/transaction.ts:543-546 callOf
  src/tooling/migrate/apply.ts:814-819 backfillTiming
function 7a0dfeef6b9e ~181 minified bytes
  src/contracts/catalog/document.ts:1044-1048 definitionToJson
  src/runtime/observe-emit.ts:291-295 (function)
  src/tooling/migrate/plan-json.ts:141-145 (arrow)
function b9c3fd55e87c ~180 minified bytes
  src/dialects/pg/schema.ts:1274-1278 (arrow)
  src/tooling/migrate/apply.ts:650-654 pushTarget
function 47573489fa30 ~179 minified bytes
  src/contracts/catalog/document.ts:1033-1037 definitionToJson
  src/dialects/pg/schema.ts:1490-1494 tableModel
  src/tooling/migrate/api.ts:165-171 invokeOf
  src/tooling/migrate/commands.ts:768-774 invokeOf
function 8cae8a761d3c ~179 minified bytes
  src/tooling/migrate/lost.ts:51-58 sessionFailure
  src/tooling/migrate/pull.ts:361-368 unavailable
function a1a54b3396f7 ~179 minified bytes
  src/dialects/pg/compile.ts:116-120 compileColumn
  src/runtime/observe-emit.ts:292-296 (function)
function cdd8b514c9a4 ~179 minified bytes
  src/tooling/migrate/baseline.ts:109-113 runBaseline
  src/tooling/migrate/resolve.ts:78-82 resolveProject
function 06ca8fdfd70a ~178 minified bytes
  src/tooling/errors/body.ts:59-65 errorBody
  src/tooling/errors/body.ts:136-142 warningBody
function 17ec15cc5a45 ~178 minified bytes
  src/runtime/safety/index.ts:171-176 (function)
  src/runtime/safety/index.ts:191-196 (function)
function 5645c63ea401 ~178 minified bytes
  src/contracts/catalog/document.ts:723-726 rewriteTableName
  src/contracts/catalog/document.ts:1033-1036 definitionToJson
  src/contracts/catalog/object.ts:251-254 index
  src/dialects/pg/schema.ts:1490-1493 tableModel
  src/runtime/observe-emit.ts:294-297 (function)
  src/runtime/tree.ts:107-110 open
  src/tooling/migrate/api.ts:165-170 invokeOf
  src/tooling/migrate/commands.ts:768-773 invokeOf
function cbaf42da77f6 ~178 minified bytes
  src/dialects/pg/introspect.ts:609-613 readPrivileges
  src/tooling/migrate/ext-surface.ts:123-127 readSurface
function 2dd2968d696b ~177 minified bytes
  src/contracts/catalog/document.ts:1041-1047 definitionToJson
  src/dialects/pg/schema.ts:1465-1471 (arrow)
  src/runtime/tenancy/via.ts:133-139 (arrow)
  src/tooling/cli/envelope.ts:102-108 serializeEnvelope
  src/tooling/errors/registry.ts:993-999 warningDoc
function 3885c194814d ~177 minified bytes
  src/tooling/errors/examples.ts:1297-1300 (arrow)
  src/tooling/errors/examples.ts:1302-1305 (arrow)
function 540255106877 ~177 minified bytes
  src/runtime/safety/index.ts:438-443 sameViolations
  src/tooling/migrate/plan.ts:1187-1193 columnsAppended
function 6fa90269711f ~177 minified bytes
  src/tooling/migrate/snapshot.ts:322-326 normaliseColumn
  src/tooling/migrate/snapshot.ts:335-339 normaliseView
  src/tooling/migrate/snapshot.ts:341-345 normaliseMatview
function 736a8822661c ~177 minified bytes
  src/tooling/migrate/pg-probe.ts:507-512 parseAddEnum
  src/tooling/migrate/pg-probe.ts:658-663 alterTable
function 99361e192ce2 ~177 minified bytes
  src/contracts/catalog/document.ts:465-471 rewriteColumn
  src/contracts/catalog/document.ts:573-579 rewriteConstraint
  src/dialects/pg/fn/index.ts:438-443 (function)
function cd09cfb6146f ~177 minified bytes
  src/contracts/catalog/document.ts:528-531 indexAgain
  src/contracts/catalog/document.ts:559-562 rewriteConstraint
  src/contracts/catalog/document.ts:723-726 rewriteTableName
  src/contracts/catalog/document.ts:1033-1036 definitionToJson
  src/contracts/catalog/object.ts:251-254 index
  src/contracts/catalog/object.ts:371-374 constraint
  src/contracts/catalog/view.ts:165-168 materializedViewIndex
  src/dialects/pg/schema.ts:1275-1278 (arrow)
  src/dialects/pg/schema.ts:1490-1493 tableModel
  src/runtime/batch.ts:274-277 stampValidation
  src/runtime/observe-emit.ts:294-297 (function)
  src/runtime/pg/bun.ts:70-73 connect
  src/runtime/pg/neon.ts:69-72 (arrow)
  src/runtime/pg/neon.ts:82-85 connect
  src/runtime/pg/pg.ts:64-67 connect
  src/runtime/topology.ts:911-914 openEndpoint
  src/runtime/traits/index.ts:97-100 trait
  src/runtime/tree.ts:107-110 open
  src/tooling/migrate/api.ts:165-170 invokeOf
  src/tooling/migrate/apply.ts:369-372 applyTarget
  src/tooling/migrate/apply.ts:651-654 pushTarget
  src/tooling/migrate/commands.ts:768-773 invokeOf
function 1bc32b9b62d1 ~176 minified bytes
  src/tooling/migrate/apply.ts:867-873 restampLegacy
  src/tooling/migrate/apply.ts:1028-1034 provisionEmpty
function 2896bff6f44c ~176 minified bytes
  src/tooling/migrate/snapshot.ts:323-326 normaliseColumn
  src/tooling/migrate/snapshot.ts:330-333 normaliseDomain
  src/tooling/migrate/snapshot.ts:336-339 normaliseView
  src/tooling/migrate/snapshot.ts:342-345 normaliseMatview
function 2c2c0ac8fbc9 ~176 minified bytes
  src/tooling/migrate/baseline.ts:381-391 childOfUnmanaged
  src/tooling/migrate/plan.ts:1731-1741 childOfHandsOff
function 31507f0ef45c ~176 minified bytes
  src/adapters/error.ts:129-133 errorField
  src/contracts/connection.ts:111-115 readCode
function 3d5399f6a193 ~176 minified bytes
  src/contracts/catalog/document.ts:529-531 indexAgain
  src/contracts/catalog/document.ts:560-562 rewriteConstraint
  src/contracts/catalog/document.ts:724-726 rewriteTableName
  src/contracts/catalog/document.ts:1034-1036 definitionToJson
  src/contracts/catalog/object.ts:252-254 index
  src/contracts/catalog/object.ts:372-374 constraint
  src/contracts/catalog/view.ts:166-168 materializedViewIndex
  src/dialects/pg/role/index.ts:198-200 contributeRoles
  src/dialects/pg/schema.ts:1276-1278 (arrow)
  src/dialects/pg/schema.ts:1491-1493 tableModel
  src/runtime/batch.ts:275-277 stampValidation
  src/runtime/client.ts:147-149 createClient
  src/runtime/observe-emit.ts:295-297 (function)
  src/runtime/pg/bun.ts:71-73 connect
  src/runtime/pg/neon.ts:70-72 (arrow)
  src/runtime/pg/neon.ts:83-85 connect
  src/runtime/pg/pg.ts:65-67 connect
  src/runtime/topology.ts:912-914 openEndpoint
  src/runtime/traits/index.ts:98-100 trait
  src/runtime/tree.ts:108-110 open
  src/tooling/migrate/api.ts:166-170 invokeOf
  src/tooling/migrate/apply.ts:370-372 applyTarget
  src/tooling/migrate/commands.ts:769-773 invokeOf
function 4a4025bfb6c2 ~176 minified bytes
  src/dialects/pg/ops/fragment.ts:336-340 identName
  src/tooling/testing/factories.ts:641-645 refOf
function 791e0843f9ee ~176 minified bytes
  src/runtime/archive.ts:528-534 callOptions
  src/runtime/batch.ts:233-239 call
function 97d85375bd51 ~176 minified bytes
  src/contracts/catalog/document.ts:722-726 rewriteTableName
  src/contracts/catalog/object.ts:370-374 constraint
function e4938420e20a ~176 minified bytes
  src/contracts/catalog/document.ts:1041-1047 definitionToJson
  src/contracts/catalog/document.ts:1823-1829 parseDefaultPrivilege
  src/dialects/pg/schema.ts:1465-1471 (arrow)
  src/tooling/cli/envelope.ts:102-108 serializeEnvelope
  src/tooling/errors/registry.ts:993-999 warningDoc
function 1274e6da506b ~175 minified bytes
  src/tooling/migrate/import-drizzle.ts:671-676 columnOf
  src/tooling/migrate/plan.ts:771-775 parsePlan
function 3701327ef74e ~175 minified bytes
  src/tooling/migrate/apply.ts:1148-1152 enterCatalogSchema
  src/tooling/migrate/baseline.ts:433-437 enterCatalogSchema
function 7edd8c963e96 ~175 minified bytes
  src/tooling/errors/examples.ts:1537-1543 (arrow)
  src/tooling/errors/examples.ts:1565-1571 (arrow)
  src/tooling/errors/examples.ts:1578-1584 (arrow)
function 5ac4272e6b31 ~174 minified bytes
  src/dialects/pg/lower.ts:574-578 identityChangeSql
  src/tooling/migrate/safe.ts:137-142 notValidSteps
function 68846c2b0027 ~174 minified bytes
  src/runtime/exposure.ts:70-74 scrubCall
  src/runtime/write.ts:2676-2680 scrubWrite
function 7d5f2af9bc2c ~174 minified bytes
  src/tooling/errors/examples.ts:1265-1277 (arrow)
  src/tooling/errors/examples.ts:1279-1291 (arrow)
function a6c71cd64461 ~174 minified bytes
  src/contracts/catalog/document.ts:526-530 indexAgain
  src/dialects/pg/fn/index.ts:235-239 (arrow)
function b8af51469bdc ~174 minified bytes
  src/tooling/migrate/check.ts:134-137 checkMigrations
  src/tooling/migrate/import-drizzle.ts:512-515 catalogOf
function cbc594074686 ~174 minified bytes
  src/dialects/pg/lower.ts:517-522 alterColumn
  src/dialects/pg/schema.ts:1252-1257 compileForeignKeys
  src/runtime/page.ts:201-206 (arrow)
function e0ce51b3b3e5 ~174 minified bytes
  src/tooling/describe/lock.ts:307-312 stale
  src/tooling/describe/sync.ts:244-249 staleFiles
function 7a55267cb3b3 ~173 minified bytes
  src/dialects/pg/schema.ts:879-884 compileTable
  src/tooling/migrate/pull-routines.ts:134-139 planRoutines
function 840d06bf7d9e ~173 minified bytes
  src/tooling/migrate/check.ts:135-137 checkMigrations
  src/tooling/migrate/pull-routines.ts:317-319 renderRoutines
function 19cb82c32e62 ~172 minified bytes
  src/runtime/aggregate.ts:187-190 plan
  src/runtime/sync.ts:177-180 prepare
  src/runtime/tree.ts:94-97 open
function c3a6624cc52c ~172 minified bytes
  src/tooling/migrate/pull-verify.ts:140-144 copyFunction
  src/tooling/migrate/pull-verify.ts:156-160 copyView
function 9085c59e0c9e ~171 minified bytes
  src/runtime/sync.ts:735-739 callOf
  src/runtime/write.ts:2490-2494 callOptions
function a1ee64538433 ~171 minified bytes
  src/tooling/migrate/sandbox.ts:159-170 (arrow)
  src/tooling/migrate/sandbox.ts:178-189 (arrow)
function 009ad8db812a ~170 minified bytes
  src/runtime/sort.ts:60-63 insertAtEnd
  src/runtime/sort.ts:262-265 readOne
  src/runtime/sort.ts:328-331 moveStatement
function 036391d21b78 ~170 minified bytes
  src/tooling/errors/examples.ts:1678-1685 (arrow)
  src/tooling/errors/examples.ts:1691-1699 (arrow)
function 7bb2fd99e01f ~170 minified bytes
  src/contracts/catalog/document.ts:1167-1170 parseObject
  src/contracts/catalog/document.ts:1587-1590 parsePolicy
  src/dialects/pg/schema.ts:433-436 schema
function 7c3512d7efb8 ~170 minified bytes
  src/dialects/pg/errors.ts:559-563 valuesOf
  src/dialects/pg/lower.ts:517-521 alterColumn
  src/dialects/pg/schema.ts:1252-1256 compileForeignKeys
  src/runtime/archive.ts:442-446 joinOn
  src/runtime/page.ts:201-205 (arrow)
  src/tooling/testing/factories.ts:460-464 paired
function f42173dfcef5 ~170 minified bytes
  src/contracts/catalog/document.ts:572-577 rewriteConstraint
  src/contracts/catalog/document.ts:1824-1829 parseDefaultPrivilege
function 1ea495b53ba2 ~169 minified bytes
  src/runtime/exposure.ts:27-31 redactView
  src/runtime/exposure.ts:60-64 scrubCall
function 2811e8fdb13e ~169 minified bytes
  src/tooling/migrate/sandbox.ts:476-480 runSteps
  src/tooling/migrate/snapshot.ts:227-231 installSnapshot
function 53fb6a2926b4 ~169 minified bytes
  src/dialects/pg/schema.ts:1490-1493 tableModel
  src/runtime/batch.ts:274-277 stampValidation
  src/runtime/pg/bun.ts:70-73 connect
  src/runtime/pg/neon.ts:69-72 (arrow)
  src/runtime/pg/neon.ts:82-85 connect
  src/runtime/pg/pg.ts:64-67 connect
  src/runtime/topology.ts:911-914 openEndpoint
  src/tooling/migrate/apply.ts:369-372 applyTarget
  src/tooling/migrate/apply.ts:702-706 pushTarget
function d3c43a7c6bca ~169 minified bytes
  src/tooling/migrate/pg-probe.ts:390-395 parseCreateIndex
  src/tooling/migrate/pg-probe.ts:654-659 alterTable
function 5d0d02467171 ~168 minified bytes
  src/runtime/write.ts:857-863 finishGuarded
  src/runtime/write.ts:894-900 finishVersioned
function ae3686c00534 ~168 minified bytes
  src/runtime/topology.ts:429-435 connectTopology
  src/tooling/cli/envelope.ts:103-109 serializeEnvelope
function d8a480c0d9b9 ~168 minified bytes
  src/dialects/pg/errors.ts:559-564 valuesOf
  src/runtime/archive.ts:442-447 joinOn
function e33e474ce79c ~168 minified bytes
  src/contracts/error.ts:645-648 fromDriver
  src/dialects/pg/errors.ts:109-112 mapPostgresError
function fd2ac99b0da3 ~168 minified bytes
  src/contracts/catalog/document.ts:1823-1829 parseDefaultPrivilege
  src/runtime/tenancy/via.ts:110-116 (arrow)
  src/runtime/tenancy/via.ts:133-139 (arrow)
function 184786275ff4 ~167 minified bytes
  src/tooling/migrate/baseline.ts:406-412 readExisting
  src/tooling/migrate/status.ts:390-396 readMeta
function 1c216f6fa5d2 ~167 minified bytes
  src/dialects/pg/introspect.ts:1268-1274 unwrapTriggerWhen
  src/tooling/migrate/lint-rules.ts:591-597 unwrap
  src/tooling/migrate/pg-probe.ts:573-579 wrapped
function 4a4f6a82cdf1 ~167 minified bytes
  src/runtime/pg/bun.ts:84-90 connect
  src/runtime/pg/neon.ts:96-102 (arrow)
  src/runtime/pg/pg.ts:77-83 connect
  src/runtime/pg/pglite.ts:71-77 connect
  src/runtime/pg/postgresjs.ts:77-83 connect
  src/tooling/cli/envelope.ts:103-109 serializeEnvelope
function 7fe42931edb6 ~167 minified bytes
  src/dialects/pg/table.ts:567-572 buildIndex
  src/tooling/migrate/plan.ts:770-775 parsePlan
function 95f6f0059af9 ~167 minified bytes
  src/runtime/tenancy/composite.ts:447-454 requireScope
  src/runtime/tenancy/via.ts:207-214 requireScope
function 3ec3a37ee34d ~166 minified bytes
  src/runtime/sync.ts:525-533 emitChildMatch
  src/runtime/sync.ts:597-605 emitJoinLocked
function a52525c55396 ~166 minified bytes
  src/dialects/pg/network.ts:47-54 network
  src/dialects/pg/network.ts:56-63 mac
function ee5977466217 ~166 minified bytes
  src/tooling/migrate/sql-lex.ts:189-197 dollarBodies
  src/tooling/migrate/sql-lex.ts:382-390 sqlIdentifiers
function c5eb0ae00b64 ~165 minified bytes
  src/runtime/sync.ts:541-546 emitSetCase
  src/runtime/write.ts:1110-1115 updateSliceBody
function 34fb209d0cc3 ~164 minified bytes
  src/dialects/pg/ddl.ts:68-77 renderCatalog
  src/tooling/migrate/plan.ts:491-500 planMigration
function 75ca7a7042b2 ~164 minified bytes
  src/runtime/bucket-group.ts:190-194 writeGrouped
  src/runtime/plan.ts:1189-1193 emitOrder
function 7e4f89799c4c ~164 minified bytes
  src/runtime/write.ts:1432-1439 emitSet
  src/runtime/write.ts:1447-1454 emitTouch
function aa05d7031c52 ~164 minified bytes
  src/runtime/sort.ts:89-94 insertAtEnd
  src/runtime/sort.ts:422-427 flipStatement
function b179a04dc0d9 ~164 minified bytes
  src/tooling/migrate/policy.ts:400-405 selectTarget
  src/tooling/migrate/status.ts:357-362 chosen
function e226f0d7eb56 ~164 minified bytes
  src/tooling/testing/isolation.ts:660-664 isViewQuery
  src/tooling/testing/isolation.ts:730-734 isQueryHandle
function 57e7abc9f672 ~163 minified bytes
  src/runtime/plan.ts:876-883 emitAnd
  src/runtime/plan.ts:1098-1105 emitOr
function 604fc6e45e63 ~163 minified bytes
  src/tooling/init/package-json.ts:136-140 hasDeclaration
  src/tooling/init/package-json.ts:145-149 usesCaret
function dd66b2b4e9e0 ~163 minified bytes
  src/runtime/tenancy/composite.ts:113-117 (function)
  src/runtime/tenancy/index.ts:133-137 (function)
function 1c8d05dc01b4 ~162 minified bytes
  src/dialects/pg/compile.ts:160-161 compileColumn
  src/tooling/describe/command.ts:63-68 runRawSync
  src/tooling/migrate/apply.ts:486-491 runApply
function 2578dd1e902c ~162 minified bytes
  src/runtime/sort-bind.ts:42-46 applies
  src/runtime/sort-bind.ts:112-116 archivable
function 843ec87e0d2c ~162 minified bytes
  src/tooling/migrate/pull-emit.ts:1259-1269 jsIdent
  src/tooling/migrate/pull-routines.ts:584-594 bindingIdent
function 9eed205ed59a ~162 minified bytes
  src/runtime/bucket-group.ts:184-189 writeGrouped
  src/runtime/window.ts:159-164 emitResultOrder
function ecff90e7325c ~162 minified bytes
  src/adapters/pg/postgresjs.ts:388-394 (function)
  src/adapters/pg/session.ts:175-181 (function)
function fa165a5fa553 ~162 minified bytes
  src/tooling/errors/examples.ts:1536-1542 (arrow)
  src/tooling/errors/examples.ts:1548-1554 (arrow)
  src/tooling/errors/examples.ts:1591-1597 (arrow)
  src/tooling/errors/examples.ts:1603-1609 (arrow)
function 2ca01a6c92d9 ~161 minified bytes
  src/runtime/write.ts:576-579 planInsert
  src/tooling/migrate/plan.ts:339-342 planMigration
function 934d346782b5 ~161 minified bytes
  src/adapters/pg/neon-extra.ts:48-56 (arrow)
  src/adapters/pg/nodepostgres-extra.ts:57-65 (arrow)
function b1e5ad0138e9 ~161 minified bytes
  src/tooling/errors/examples.ts:1549-1554 (arrow)
  src/tooling/errors/examples.ts:1565-1570 (arrow)
  src/tooling/errors/examples.ts:1578-1583 (arrow)
  src/tooling/errors/examples.ts:1592-1597 (arrow)
  src/tooling/errors/examples.ts:1604-1609 (arrow)
function ccc7a0320d6e ~161 minified bytes
  src/dialects/pg/errors.ts:559-563 valuesOf
  src/dialects/pg/lower.ts:517-521 alterColumn
  src/dialects/pg/schema.ts:1252-1256 compileForeignKeys
  src/runtime/archive.ts:442-446 joinOn
  src/runtime/safety/index.ts:438-442 sameViolations
  src/tooling/migrate/plan.ts:1187-1191 columnsAppended
  src/tooling/testing/factories.ts:460-464 paired
function 6568e3d8dea4 ~160 minified bytes
  src/adapters/pg/nodepostgres.ts:159-161 open
  src/contracts/catalog/document.ts:528-530 indexAgain
  src/contracts/catalog/document.ts:1010-1014 definitionToJson
  src/contracts/catalog/object.ts:185-189 column
  src/contracts/catalog/object.ts:251-253 index
  src/contracts/catalog/view.ts:165-167 materializedViewIndex
  src/dialects/pg/compile.ts:118-120 compileColumn
  src/dialects/pg/fn/index.ts:237-239 (arrow)
  src/runtime/observe-emit.ts:294-296 (function)
  src/runtime/pg/neon.ts:66-68 (arrow)
  src/runtime/traits/index.ts:97-99 trait
  src/tooling/migrate/apply.ts:363-367 applyTarget
  src/tooling/migrate/commands.ts:768-771 invokeOf
function e3bf627766f4 ~160 minified bytes
  src/runtime/aggregate.ts:285-290 columns
  src/runtime/aggregate.ts:326-331 readGroups
function 2ff7f061f6e1 ~159 minified bytes
  src/tooling/cli/outcome.ts:179-182 readPartial
  src/tooling/errors/shape.ts:107-110 readCliDetail
function e58c67606d82 ~159 minified bytes
  src/dialects/pg/morph.ts:123-132 resolveMorph
  src/dialects/pg/morph.ts:203-212 resolveMorphMany
function 0a843b62ba70 ~158 minified bytes
  src/dialects/pg/schema.ts:1275-1277 (arrow)
  src/runtime/pg/bun.ts:67-69 connect
  src/runtime/pg/neon.ts:79-81 connect
  src/runtime/pg/pg.ts:61-63 connect
function 3fa36805b813 ~158 minified bytes
  src/dialects/pg/view/index.ts:240-242 view
  src/dialects/pg/view/index.ts:289-291 materializedView
function 54e69d66038a ~158 minified bytes
  src/runtime/batch.ts:114-120 run
  src/runtime/batch.ts:158-164 recover
function 8c7cf49909e5 ~158 minified bytes
  src/runtime/sync.ts:399-404 manyThrough
  src/runtime/write.ts:1109-1114 updateSliceBody
literal 577db2ee59b6 ~158 minified bytes x3
  src/runtime/tenancy/rls.ts:61
  src/runtime/tenancy/rls.ts:824
  src/tooling/errors/registry.ts:716
function 49f33ae049ee ~157 minified bytes
  src/tooling/testing/factories.ts:419-424 tenantKeyNames
  src/tooling/testing/isolation.ts:245-250 tenantKeys
function 92eccc576f34 ~157 minified bytes
  src/tooling/migrate/apply.ts:746-752 restampHeadHash
  src/tooling/migrate/apply.ts:1111-1117 insertReference
function b83f854973af ~157 minified bytes
  src/contracts/catalog/document.ts:869-874 rewriteType
  src/contracts/catalog/document.ts:893-898 rewriteSequence
  src/tooling/migrate/pull-verify.ts:154-159 copyView
  src/tooling/migrate/pull-verify.ts:170-175 copyMatview
function d151eb3b8e0f ~157 minified bytes
  src/contracts/catalog/document.ts:1008-1013 definitionToJson
  src/contracts/catalog/object.ts:183-188 column
  src/runtime/safety/index.ts:134-137 (function)
  src/runtime/safety/index.ts:172-175 (function)
  src/runtime/safety/index.ts:192-195 (function)
  src/runtime/safety/index.ts:222-225 (function)
  src/runtime/safety/index.ts:265-268 (function)
function d40f4b89bd57 ~157 minified bytes
  src/contracts/catalog/document.ts:1030-1034 definitionToJson
  src/dialects/pg/custom.ts:34-38 custom
  src/tooling/describe/sync.ts:74-78 lockStatement
function 04c632f22765 ~156 minified bytes
  src/runtime/tenancy/composite.ts:489-494 (arrow)
  src/runtime/tenancy/index.ts:467-472 (arrow)
function 2f6342689b66 ~156 minified bytes
  src/dialects/pg/lower.ts:517-522 alterColumn
  src/runtime/page.ts:201-206 (arrow)
function 3340e60abd80 ~156 minified bytes
  src/dialects/pg/decimal.ts:32-39 numeric
  src/dialects/pg/integer.ts:67-74 bigint
function 6f8bd8d9d42d ~156 minified bytes
  src/runtime/sort.ts:559-564 count
  src/runtime/write.ts:902-907 countCell
function 7c04d5c7f12b ~156 minified bytes
  src/tooling/migrate/protect.ts:52-53 addProtectedTarget
  src/tooling/migrate/protect.ts:83-84 removeProtectedTarget
function 8f91c8fdf822 ~156 minified bytes
  src/dialects/pg/errors.ts:109-112 mapPostgresError
  src/dialects/pg/fn/index.ts:238-241 (arrow)
function a473380be95d ~156 minified bytes
  src/contracts/catalog/document.ts:360-364 rewriteRenamed
  src/contracts/catalog/document.ts:763-767 rewriteTableName
  src/tooling/migrate/pull-verify.ts:155-159 copyView
  src/tooling/migrate/pull-verify.ts:171-175 copyMatview
function a808911d66a1 ~156 minified bytes
  src/dialects/pg/role/check.ts:142-146 assertGrant
  src/dialects/pg/role/sql.ts:279-285 grantStatement
function c812acca3759 ~156 minified bytes
  src/contracts/catalog/enum.ts:43-48 enumType
  src/contracts/catalog/enum.ts:98-103 domainType
function ca9421b8d192 ~156 minified bytes
  src/runtime/write.ts:1675-1678 insertRow
  src/runtime/write.ts:2105-2108 writeSet
function d2d59d52378b ~156 minified bytes
  src/tooling/migrate/apply.ts:747-752 restampHeadHash
  src/tooling/migrate/apply.ts:868-873 restampLegacy
  src/tooling/migrate/apply.ts:1019-1024 provisionEmpty
  src/tooling/migrate/apply.ts:1112-1117 insertReference
  src/tooling/migrate/runner.ts:824-829 assertUnitPolicy
function 1e3b08c4dd17 ~155 minified bytes
  src/runtime/include.ts:291-296 emitNestedAggregate
  src/runtime/window.ts:214-219 emitWindow
function 2c169d6e0088 ~155 minified bytes
  src/runtime/drift-detail.ts:86-90 assertDrift
  src/runtime/server-check.ts:113-117 acceptServer
function 7a570b298e22 ~155 minified bytes
  src/dialects/pg/archive-bind.ts:251-255 foreignKeys
  src/runtime/tenancy/composite.ts:215-219 refuseGlobalReference
  src/runtime/tenancy/index.ts:234-238 refuseGlobalReference
function c3239563eaa7 ~155 minified bytes
  src/tooling/migrate/runner.ts:392-395 runUnit
  src/tooling/migrate/runner.ts:597-600 oneBatch
function 59d0e335d1ca ~153 minified bytes
  src/contracts/catalog/object.ts:371-374 constraint
  src/tooling/migrate/apply.ts:678-681 pushTarget
function 7d3f7ed3e2a0 ~153 minified bytes
  src/contracts/catalog/document.ts:368-374 rewriteRenamed
  src/dialects/pg/view/scratch.ts:125-129 (arrow)
function 9d35aeda2756 ~153 minified bytes
  src/dialects/pg/temporal.ts:64-70 encodeInstant
  src/dialects/pg/temporal.ts:96-102 encodeDateTime
  src/dialects/pg/temporal.ts:156-162 encodeTime
function d40c2f6da5eb ~153 minified bytes
  src/tooling/migrate/apply.ts:904-908 backendPid
  src/tooling/migrate/baseline.ts:454-458 backendPid
  src/tooling/migrate/seed.ts:66-70 (arrow)
function e2e9e77bbd66 ~153 minified bytes
  src/tooling/migrate/server-requirements.ts:214-223 installedExtensions
  src/tooling/migrate/server-requirements.ts:231-240 availableExtensions
function e36930651044 ~153 minified bytes
  src/runtime/include.ts:191-196 emitIncludeJoin
  src/runtime/plan.ts:751-756 emitRead
  src/runtime/sync.ts:399-404 manyThrough
  src/runtime/tree.ts:187-192 emitTree
  src/runtime/write.ts:1109-1114 updateSliceBody
function 1e9c7795a78c ~152 minified bytes
  src/runtime/sync.ts:400-404 manyThrough
  src/runtime/sync.ts:541-545 emitSetCase
function 4e7041aa46b4 ~152 minified bytes
  src/contracts/catalog/view.ts:165-168 materializedViewIndex
  src/dialects/pg/schema.ts:1275-1278 (arrow)
  src/runtime/traits/index.ts:97-100 trait
function a209e398b432 ~152 minified bytes
  src/contracts/catalog/document.ts:525-530 indexAgain
  src/dialects/pg/fn/index.ts:439-444 (function)
function b382bcfc0bf2 ~152 minified bytes
  src/contracts/catalog/document.ts:723-726 rewriteTableName
  src/tooling/migrate/apply.ts:678-681 pushTarget
function f720c4ba2626 ~152 minified bytes
  src/runtime/include.ts:192-196 emitIncludeJoin
  src/runtime/plan.ts:752-756 emitRead
  src/runtime/sync.ts:541-545 emitSetCase
  src/runtime/tree.ts:188-192 emitTree
function fd62e9bfc354 ~152 minified bytes
  src/contracts/catalog/document.ts:824-828 rewriteTableName
  src/dialects/pg/view/scratch.ts:125-129 (arrow)
function fe6fffee156c ~152 minified bytes
  src/contracts/catalog/document.ts:961-964 renamedIdentitySequence
  src/tooling/migrate/plan.ts:888-890 sequenceRenames
function 6b0a2e82ec72 ~151 minified bytes
  src/contracts/catalog/document.ts:723-727 rewriteTableName
  src/contracts/catalog/object.ts:251-255 index
function 944ef387af28 ~151 minified bytes
  src/dialects/pg/ext/index.ts:135-139 extension
  src/dialects/pg/table.ts:567-571 buildIndex
function a5cb423f86d9 ~151 minified bytes
  src/contracts/catalog/document.ts:462-467 rewriteColumn
  src/contracts/catalog/document.ts:651-656 rewriteTableName
function ea55c58f4a77 ~151 minified bytes
  src/dialects/pg/table.ts:568-572 buildIndex
  src/tooling/migrate/import-drizzle.ts:671-675 columnOf
function eeb89341cc28 ~151 minified bytes
  src/tooling/migrate/plan.ts:224-226 planMigration
  src/tooling/migrate/plan.ts:1073-1075 recreateDependents
function ff3c9d399ef5 ~151 minified bytes
  src/dialects/pg/archive-bind.ts:190-195 childLinks
  src/dialects/pg/schema.ts:1555-1560 resolveRelations
function 156891e4a0e5 ~150 minified bytes
  src/runtime/exposure.ts:65-68 scrubCall
  src/runtime/write.ts:2670-2673 scrubWrite
  src/runtime/write.ts:2692-2695 (arrow)
function 2b96700a52b9 ~150 minified bytes
  src/contracts/catalog/document.ts:1052-1055 definitionToJson
  src/contracts/error.ts:645-648 fromDriver
  src/dialects/pg/errors.ts:109-112 mapPostgresError
function 4020040782f5 ~150 minified bytes
  src/tooling/migrate/import-drizzle.ts:513-515 catalogOf
  src/tooling/migrate/pull-routines.ts:317-319 renderRoutines
function 492f78709712 ~150 minified bytes
  src/tooling/errors/examples.ts:1616-1623 (arrow)
  src/tooling/errors/examples.ts:1629-1634 (arrow)
function 8421c552290c ~150 minified bytes
  src/runtime/archive.ts:329-334 restoreSql
  src/runtime/version.ts:297-302 targetStatement
  src/runtime/write.ts:1007-1012 pathListUpdate
function 843c1db339ff ~150 minified bytes
  src/tooling/migrate/baseline.ts:289-294 compareLive
  src/tooling/migrate/drift.ts:68-73 assertAuthorDrift
function ad57d1b41fe3 ~150 minified bytes
  src/tooling/migrate/apply.ts:765-772 restampHeadHash
  src/tooling/migrate/apply.ts:1061-1068 provisionEmpty
function b280d5ce749c ~150 minified bytes
  src/tooling/migrate/apply.ts:493-500 runApply
  src/tooling/migrate/provision.ts:49-56 provision
function e7be89713683 ~150 minified bytes
  src/runtime/warnings/config.ts:66-69 parseWarningOptions
  src/tooling/cli/parse.ts:196-199 parseCli
  src/tooling/describe/protocol.ts:367-370 parseTarget
function 61b104223b74 ~149 minified bytes
  src/contracts/catalog/document.ts:1052-1055 definitionToJson
  src/dialects/pg/schema.ts:1167-1170 (arrow)
function 739ca909216b ~149 minified bytes
  src/runtime/archive.ts:75-77 executeArchive
  src/runtime/write.ts:256-258 executeWrite
function 9d4635bbb36e ~149 minified bytes
  src/contracts/catalog/view.ts:165-169 materializedViewIndex
  src/tooling/migrate/apply.ts:369-373 applyTarget
  src/tooling/migrate/apply.ts:678-682 pushTarget
function 9fa115add694 ~149 minified bytes
  src/runtime/include.ts:116-119 emitIncludeSelect
  src/tooling/migrate/runner.ts:129-132 runTarget
function f08cd4928791 ~149 minified bytes
  src/runtime/include.ts:664-668 emitIncludeOrder
  src/runtime/window.ts:226-230 emitWindow
function 226699842627 ~148 minified bytes
  src/dialects/pg/custom.ts:34-38 custom
  src/tooling/describe/sync.ts:74-78 lockStatement
function 844d4860e226 ~148 minified bytes
  src/contracts/catalog/view.ts:166-169 materializedViewIndex
  src/runtime/client.ts:147-150 createClient
  src/tooling/migrate/apply.ts:370-373 applyTarget
  src/tooling/migrate/apply.ts:679-682 pushTarget
function c68f4aa4296b ~148 minified bytes
  src/runtime/tenancy/composite.ts:85-100 (function)
  src/runtime/tenancy/index.ts:105-120 (function)
function 1ab9090c4410 ~147 minified bytes
  src/adapters/error.ts:64-71 (function)
  src/contracts/error.ts:436-443 (function)
function 1c078bc3ae24 ~147 minified bytes
  src/contracts/catalog/document.ts:528-531 indexAgain
  src/tooling/migrate/apply.ts:651-654 pushTarget
function 4ec0f190cad3 ~147 minified bytes
  src/tooling/migrate/apply.ts:625-631 pushTarget
  src/tooling/migrate/baseline.ts:277-283 compareLive
function ba37e82a8154 ~147 minified bytes
  src/dialects/pg/compile.ts:116-119 compileColumn
  src/dialects/pg/custom.ts:35-38 custom
  src/tooling/describe/sync.ts:75-78 lockStatement
  src/tooling/migrate/commands.ts:766-769 invokeOf
  src/tooling/migrate/plan-json.ts:142-145 (arrow)
function 44300ac5b993 ~146 minified bytes
  src/contracts/catalog/document.ts:527-531 indexAgain
  src/contracts/catalog/object.ts:250-254 index
  src/contracts/catalog/view.ts:164-168 materializedViewIndex
function 48442bbaba3c ~146 minified bytes
  src/contracts/catalog/object.ts:184-188 column
  src/dialects/pg/compile.ts:117-119 compileColumn
  src/dialects/pg/custom.ts:36-38 custom
  src/runtime/observe-emit.ts:293-295 (function)
  src/runtime/safety/index.ts:135-137 (function)
  src/runtime/safety/index.ts:173-175 (function)
  src/runtime/safety/index.ts:193-195 (function)
  src/runtime/safety/index.ts:223-225 (function)
  src/runtime/safety/index.ts:266-268 (function)
  src/tooling/describe/sync.ts:76-78 lockStatement
  src/tooling/migrate/commands.ts:767-769 invokeOf
  src/tooling/migrate/plan-json.ts:143-145 (arrow)
function 9c2808b67ec0 ~146 minified bytes
  src/adapters/pg/postgresjs.ts:351-358 (function)
  src/adapters/pg/session.ts:93-100 (function)
function ad4ac37301f7 ~146 minified bytes
  src/contracts/catalog/document.ts:1823-1829 parseDefaultPrivilege
  src/runtime/topology.ts:463-469 (arrow)
function b2bacabb2c1b ~146 minified bytes
  src/runtime/aggregate.ts:217-223 plan
  src/runtime/page.ts:128-134 plan
function b79099372a12 ~146 minified bytes
  src/contracts/catalog/object.ts:250-253 index
  src/contracts/catalog/view.ts:164-167 materializedViewIndex
  src/dialects/pg/fn/index.ts:236-239 (arrow)
function c3e460a84810 ~146 minified bytes
  src/contracts/catalog/object.ts:371-375 constraint
  src/dialects/pg/schema.ts:1275-1279 (arrow)
function d9cee0cbc9b7 ~146 minified bytes
  src/tooling/errors/examples.ts:731-737 (arrow)
  src/tooling/errors/examples.ts:741-746 (arrow)
  src/tooling/errors/examples.ts:766-772 (arrow)
  src/tooling/errors/examples.ts:776-781 (arrow)
function e3dc5ed13d94 ~146 minified bytes
  src/tooling/migrate/apply.ts:764-771 restampHeadHash
  src/tooling/migrate/baseline.ts:205-212 runBaseline
function 0c819a8590fb ~145 minified bytes
  src/dialects/pg/compile.ts:156-158 compileColumn
  src/dialects/pg/errors.ts:109-111 mapPostgresError
  src/runtime/topology.ts:909-911 openEndpoint
function 3c232c4bdfa9 ~145 minified bytes
  src/contracts/catalog/document.ts:559-562 rewriteConstraint
  src/dialects/pg/schema.ts:1490-1493 tableModel
  src/runtime/batch.ts:274-277 stampValidation
  src/runtime/pg/bun.ts:70-73 connect
  src/runtime/pg/neon.ts:69-72 (arrow)
  src/runtime/pg/neon.ts:82-85 connect
  src/runtime/pg/pg.ts:64-67 connect
  src/runtime/topology.ts:911-914 openEndpoint
  src/runtime/tree.ts:107-110 open
  src/tooling/migrate/apply.ts:369-372 applyTarget
  src/tooling/migrate/apply.ts:703-706 pushTarget
function 53256d42d40b ~145 minified bytes
  src/runtime/include.ts:228-232 emitIncludeJoin
  src/runtime/write.ts:1888-1892 shapeObserver
function 560a0f69f124 ~145 minified bytes
  src/runtime/include.ts:117-121 emitIncludeSelect
  src/tooling/migrate/sandbox.ts:445-448 runSteps
function 8101b8cf20f3 ~145 minified bytes
  src/dialects/pg/schema.ts:1490-1491 tableModel
  src/tooling/describe/command.ts:63-68 runRawSync
  src/tooling/migrate/apply.ts:486-491 runApply
function 8f6f41bb02be ~145 minified bytes
  src/dialects/pg/introspect.ts:1297-1302 text
  src/dialects/pg/view/depend.ts:18-23 cellText
function ad9bdc0a70d7 ~145 minified bytes
  src/contracts/catalog/object.ts:371-374 constraint
  src/contracts/catalog/view.ts:165-168 materializedViewIndex
  src/dialects/pg/schema.ts:1275-1278 (arrow)
  src/runtime/traits/index.ts:97-100 trait
  src/tooling/migrate/apply.ts:369-372 applyTarget
function dacc29cfe55c ~145 minified bytes
  src/tooling/migrate/doctor.ts:78-81 doctorProject
  src/tooling/migrate/project.ts:272-275 checkProject
function fe1671388fc3 ~145 minified bytes
  src/dialects/pg/ddl.ts:357-360 alterColumnSql
  src/tooling/migrate/safe.ts:137-140 notValidSteps
function 030bf566ad20 ~144 minified bytes
  src/adapters/pg/neon.ts:171-176 (arrow)
  src/adapters/pg/nodepostgres.ts:398-403 (arrow)
function 2765c0781b61 ~144 minified bytes
  src/contracts/catalog/privilege.ts:119-125 defaultPrivilegeObject
  src/runtime/pg/bun.ts:84-90 connect
  src/runtime/pg/neon.ts:96-102 (arrow)
  src/runtime/pg/pg.ts:77-83 connect
  src/runtime/pg/pglite.ts:71-77 connect
  src/runtime/pg/postgresjs.ts:60-66 connect
  src/runtime/topology.ts:429-435 connectTopology
  src/runtime/topology.ts:467-473 (arrow)
  src/tooling/cli/envelope.ts:103-109 serializeEnvelope
  src/tooling/init/engine.ts:315-321 buildPlan
function 32615a46293c ~144 minified bytes
  src/adapters/pg/neon.ts:162-170 (arrow)
  src/adapters/pg/nodepostgres.ts:389-397 (arrow)
function 663a0cacc1a3 ~144 minified bytes
  src/dialects/pg/schema.ts:1465-1472 (arrow)
  src/runtime/tenancy/via.ts:110-117 (arrow)
  src/tooling/errors/registry.ts:993-1000 warningDoc
function 80caa832cd8e ~144 minified bytes
  src/dialects/pg/fn/index.ts:238-241 (arrow)
  src/dialects/pg/schema.ts:1167-1170 (arrow)
function ba43fc224fe0 ~144 minified bytes
  src/contracts/catalog/object.ts:372-374 constraint
  src/dialects/pg/schema.ts:1276-1278 (arrow)
  src/runtime/client.ts:147-149 createClient
  src/runtime/traits/index.ts:98-100 trait
function db283cc114da ~144 minified bytes
  src/tooling/describe/sync.ts:75-79 lockStatement
  src/tooling/migrate/plan-json.ts:142-146 (arrow)
function ea8619c41a46 ~144 minified bytes
  src/contracts/catalog/privilege.ts:119-126 defaultPrivilegeObject
  src/tooling/init/engine.ts:315-322 buildPlan
function 42d3526c7b29 ~143 minified bytes
  src/adapters/pg/nodepostgres.ts:223-228 (arrow)
  src/adapters/pg/postgresjs.ts:388-393 (function)
  src/adapters/pg/session.ts:175-180 (function)
function 637e7f4b391e ~143 minified bytes
  src/contracts/catalog/document.ts:398-403 rewriteRenamed
  src/contracts/catalog/document.ts:435-440 rewriteTable
  src/contracts/catalog/document.ts:669-674 rewriteTableName
function 66298f4a7c28 ~143 minified bytes
  src/contracts/error.ts:645-648 fromDriver
  src/dialects/pg/errors.ts:109-112 mapPostgresError
  src/dialects/pg/schema.ts:1167-1170 (arrow)
function 70b98913cd1a ~143 minified bytes
  src/adapters/pg/bunsql.ts:247-251 (function)
  src/adapters/pg/neon.ts:252-256 (function)
  src/adapters/pg/pglite.ts:86-90 (arrow)
function 7dfaa5970d00 ~143 minified bytes
  src/dialects/pg/filter-parse.ts:106-111 clauses
  src/dialects/pg/filter-parse.ts:193-198 relationClause
function c5ae40646c7b ~143 minified bytes
  src/tooling/errors/examples.ts:282-283 diffCodes
  src/tooling/errors/examples.ts:290-291 schemaCodes
function c86a69e44b43 ~143 minified bytes
  src/tooling/migrate/lint-rules.ts:999-1006 lengthShrink
  src/tooling/migrate/lint-rules.ts:1010-1017 lengthGrow
function d53135e5f3bc ~143 minified bytes
  src/tooling/migrate/sql-lex.ts:247-252 skipTrivia
  src/tooling/migrate/sql-lex.ts:386-391 sqlIdentifiers
function db4e0cfd21a9 ~143 minified bytes
  src/dialects/pg/column.ts:658-661 (function)
  src/dialects/pg/ext/index.ts:136-139 extension
  src/dialects/pg/table.ts:568-571 buildIndex
  src/tooling/migrate/plan.ts:771-774 parsePlan
function ffbe6afe7a4c ~143 minified bytes
  src/tooling/migrate/runner.ts:383-388 runUnit
  src/tooling/migrate/runner.ts:462-467 executePlanStep
function 11aa803e54c6 ~142 minified bytes
  src/tooling/migrate/apply.ts:932-938 lockTarget
  src/tooling/migrate/baseline.ts:441-447 lockTarget
function 171d5088f246 ~142 minified bytes
  src/dialects/pg/ext/index.ts:134-139 extension
  src/tooling/migrate/plan.ts:769-774 parsePlan
function 27509be821e1 ~142 minified bytes
  src/contracts/catalog/document.ts:254-260 loadTrustedCatalog
  src/contracts/catalog/document.ts:308-314 parseCatalog
function 403ab35ec113 ~142 minified bytes
  src/runtime/client.ts:906-909 callOptions
  src/tooling/migrate/import-drizzle.ts:671-674 columnOf
function 99a995e8768d ~142 minified bytes
  src/dialects/pg/ddl.ts:249-251 policyCreatePlan
  src/dialects/pg/ddl.ts:358-360 alterColumnSql
  src/dialects/pg/lower.ts:575-577 identityChangeSql
  src/tooling/migrate/safe.ts:138-140 notValidSteps
  src/tooling/migrate/safe.ts:168-170 usingIndexSteps
function cdddac0ed039 ~142 minified bytes
  src/runtime/topology.ts:2136-2140 byteLag
  src/runtime/topology.ts:2162-2166 timeLag
function d8759e8910b1 ~142 minified bytes
  src/dialects/pg/custom.ts:35-38 custom
  src/runtime/observe-emit.ts:292-295 (function)
  src/tooling/describe/sync.ts:75-78 lockStatement
  src/tooling/migrate/plan-json.ts:142-145 (arrow)
function f7423ef78f51 ~142 minified bytes
  src/tooling/describe/lock.ts:213-216 (arrow)
  src/tooling/describe/lock.ts:224-227 (arrow)
function fc8905fd5a99 ~142 minified bytes
  src/dialects/pg/compile.ts:154-157 compileColumn
  src/dialects/pg/schema.ts:523-526 schema
function 069a88931704 ~141 minified bytes
  src/tooling/migrate/apply.ts:460-464 runApply
  src/tooling/migrate/apply.ts:531-535 pushProject
  src/tooling/migrate/seed.ts:44-48 seedProject
function 105c4b70ee54 ~141 minified bytes
  src/dialects/pg/column.ts:658-661 (function)
  src/dialects/pg/ext/index.ts:136-139 extension
  src/dialects/pg/table.ts:568-571 buildIndex
  src/runtime/client.ts:906-909 callOptions
  src/tooling/migrate/import-drizzle.ts:671-674 columnOf
function 12dfe0390838 ~141 minified bytes
  src/runtime/tenancy/via.ts:110-117 (arrow)
  src/runtime/topology.ts:463-470 (arrow)
function 4295a846ad89 ~141 minified bytes
  src/runtime/include.ts:291-295 emitNestedAggregate
  src/runtime/include.ts:502-506 emitMorphJoin
  src/runtime/window.ts:214-218 emitWindow
  src/runtime/write.ts:1888-1892 shapeObserver
function 62d3137ef3f9 ~141 minified bytes
  src/dialects/pg/errors.ts:179-182 safeCause
  src/runtime/ids/okid-generator.ts:40-43 optionsRecord
  src/runtime/plan.ts:1339-1342 rejectOptions
  src/runtime/read-stream.ts:190-193 pageFields
  src/tooling/migrate/commands.ts:343-346 check
function 8c2f5ce614ec ~141 minified bytes
  src/adapters/pg/neon.ts:362-368 statementName
  src/adapters/pg/nodepostgres.ts:288-294 statementName
function 8d2ed495e6ac ~141 minified bytes
  src/dialects/pg/schema.ts:1299-1306 localKey
  src/dialects/pg/schema.ts:1324-1331 resolveTarget
function 99fe791d36f2 ~141 minified bytes
  src/runtime/include.ts:191-196 emitIncludeJoin
  src/runtime/plan.ts:751-756 emitRead
  src/runtime/sync.ts:502-507 emitDesired
  src/runtime/tree.ts:187-192 emitTree
  src/runtime/version.ts:282-287 targetStatement
  src/runtime/version.ts:407-412 anyClaimStatement
  src/runtime/write.ts:2060-2065 pathInsert
function d2f5fc3a046a ~141 minified bytes
  src/contracts/catalog/extension.ts:49-55 extensionObject
  src/contracts/catalog/view.ts:93-99 viewObject
  src/contracts/catalog/view.ts:122-128 materializedViewObject
function fdeecdd441ea ~141 minified bytes
  src/runtime/include.ts:257-261 emitIncludeJoin
  src/tooling/migrate/runner.ts:129-133 runTarget
function 38a04de9d330 ~140 minified bytes
  src/tooling/migrate/export.ts:240-243 assertSnapshots
  src/tooling/migrate/export.ts:288-291 assertLiveExternal
function 38b45e92570e ~140 minified bytes
  src/dialects/pg/ddl.ts:357-360 alterColumnSql
  src/dialects/pg/lower.ts:574-577 identityChangeSql
function 3ae58d3eaa5b ~140 minified bytes
  src/contracts/catalog/document.ts:528-531 indexAgain
  src/runtime/pg/bun.ts:70-73 connect
  src/runtime/pg/neon.ts:82-85 connect
  src/runtime/pg/pg.ts:64-67 connect
  src/runtime/topology.ts:911-914 openEndpoint
function 674553b48931 ~140 minified bytes
  src/runtime/include.ts:192-196 emitIncludeJoin
  src/runtime/plan.ts:752-756 emitRead
  src/runtime/sync.ts:400-404 manyThrough
  src/runtime/sync.ts:486-490 emitSelectLocked
  src/runtime/sync.ts:503-507 emitDesired
  src/runtime/sync.ts:541-545 emitSetCase
  src/runtime/tree.ts:188-192 emitTree
  src/runtime/version.ts:283-287 targetStatement
  src/runtime/version.ts:408-412 anyClaimStatement
  src/runtime/write.ts:1110-1114 updateSliceBody
  src/runtime/write.ts:2061-2065 pathInsert
function 770144845677 ~140 minified bytes
  src/dialects/pg/ddl.ts:56-60 renderCatalog
  src/tooling/migrate/pull-emit.ts:156-160 emitPull
function 78f2d3e87f3f ~140 minified bytes
  src/dialects/pg/role/sql.ts:81-85 privilegeSql
  src/runtime/write.ts:1884-1888 shapeObserver
function 8822521a8ba1 ~140 minified bytes
  src/tooling/errors/body.ts:145-148 warningBody
  src/tooling/migrate/commands.ts:343-346 check
function acfecbad0995 ~140 minified bytes
  src/tooling/migrate/apply.ts:461-464 runApply
  src/tooling/migrate/apply.ts:532-535 pushProject
  src/tooling/migrate/resolve.ts:78-81 resolveProject
  src/tooling/migrate/seed.ts:45-48 seedProject
function c4218fa81807 ~140 minified bytes
  src/contracts/catalog/object.ts:184-189 column
  src/dialects/pg/compile.ts:117-120 compileColumn
  src/runtime/batch.ts:269-272 stampValidation
function ea4147a68857 ~140 minified bytes
  src/adapters/pg/bunsql.ts:386-393 statsOf
  src/adapters/pg/neon.ts:370-377 statsOf
  src/adapters/pg/nodepostgres.ts:408-415 statsOf
function 00e630ec87e3 ~139 minified bytes
  src/runtime/include.ts:291-295 emitNestedAggregate
  src/runtime/include.ts:502-506 emitMorphJoin
  src/runtime/window.ts:214-218 emitWindow
function 7961a7080ebb ~139 minified bytes
  src/dialects/pg/schema.ts:1251-1254 compileForeignKeys
  src/runtime/validate/engine.ts:92-95 finishUpdate
function 906700f07121 ~139 minified bytes
  src/runtime/include.ts:562-565 decodeMorph
  src/runtime/include.ts:615-618 decodeInclude
function 99e8ec21e20f ~139 minified bytes
  src/runtime/sync.ts:399-404 manyThrough
  src/runtime/sync.ts:502-507 emitDesired
  src/runtime/version.ts:282-287 targetStatement
  src/runtime/version.ts:407-412 anyClaimStatement
  src/runtime/write.ts:1109-1114 updateSliceBody
  src/runtime/write.ts:2060-2065 pathInsert
function a0e5fa3a1339 ~139 minified bytes
  src/runtime/client.ts:797-802 errorFields
  src/runtime/exposure.ts:71-76 scrubCall
function e30368d6c873 ~139 minified bytes
  src/runtime/plan.ts:1157-1162 emitOrder
  src/runtime/window.ts:158-163 emitResultOrder
function 1789c293c143 ~138 minified bytes
  src/contracts/catalog/document.ts:529-531 indexAgain
  src/dialects/pg/role/index.ts:198-200 contributeRoles
  src/runtime/batch.ts:275-277 stampValidation
  src/runtime/pg/bun.ts:71-73 connect
  src/runtime/pg/neon.ts:70-72 (arrow)
  src/runtime/pg/neon.ts:83-85 connect
  src/runtime/pg/pg.ts:65-67 connect
  src/runtime/topology.ts:912-914 openEndpoint
  src/tooling/migrate/apply.ts:652-654 pushTarget
function 1b213d552248 ~138 minified bytes
  src/runtime/tenancy/composite.ts:195-209 (arrow)
  src/runtime/tenancy/index.ts:217-231 (arrow)
function 42275f6f7558 ~138 minified bytes
  src/tooling/testing/isolation.ts:481-483 markerFor
  src/tooling/testing/isolation.ts:529-531 markerWhere
function 5b3905986803 ~138 minified bytes
  src/dialects/pg/owner.ts:81-88 ownerFor
  src/tooling/migrate/place.ts:185-192 relocateIdentity
function 7f623fbc5737 ~138 minified bytes
  src/tooling/errors/registry.ts:992-998 warningDoc
  src/tooling/migrate/baseline.ts:255-261 reportJson
function 8b84f6bf689d ~138 minified bytes
  src/tooling/migrate/status.ts:431-438 readBackfills
  src/tooling/migrate/status.ts:462-469 readSteps
function 9323452963c2 ~138 minified bytes
  src/runtime/page.ts:201-205 (arrow)
  src/runtime/safety/index.ts:438-442 sameViolations
  src/tooling/migrate/plan.ts:1187-1191 columnsAppended
function 96e5050bb7a2 ~138 minified bytes
  src/runtime/include.ts:116-119 emitIncludeSelect
  src/runtime/write.ts:1888-1891 shapeObserver
  src/tooling/migrate/runner.ts:129-132 runTarget
function f16284e9fd63 ~138 minified bytes
  src/runtime/sync.ts:485-490 emitSelectLocked
  src/runtime/sync.ts:540-545 emitSetCase
function 14c5e87b20fb ~137 minified bytes
  src/tooling/migrate/pull-emit.ts:1181-1189 uniqueFile
  src/tooling/migrate/pull-emit.ts:1248-1257 freshIdent
function 1acfac532a8d ~137 minified bytes
  src/tooling/migrate/apply.ts:1061-1067 provisionEmpty
  src/tooling/migrate/baseline.ts:206-212 runBaseline
function 23f245c52737 ~137 minified bytes
  src/dialects/pg/ddl.ts:248-251 policyCreatePlan
  src/tooling/migrate/safe.ts:167-170 usingIndexSteps
function 8534a82017a1 ~137 minified bytes
  src/dialects/pg/schema.ts:1490-1493 tableModel
  src/runtime/tree.ts:107-110 open
function fc0cdb1c6b25 ~137 minified bytes
  src/runtime/batch.ts:270-272 stampValidation
  src/runtime/client.ts:798-800 errorFields
  src/runtime/exposure.ts:72-74 scrubCall
function 0e3a6dda2560 ~136 minified bytes
  src/runtime/sync.ts:523-527 emitChildMatch
  src/runtime/version.ts:437-441 anyClaimStatement
function 141b7d6aae8c ~136 minified bytes
  src/contracts/catalog/document.ts:528-532 indexAgain
  src/runtime/batch.ts:274-278 stampValidation
function 39d56936be64 ~136 minified bytes
  src/runtime/write.ts:981-987 pathSetUpdate
  src/runtime/write.ts:1406-1412 emitClaim
  src/runtime/write.ts:2245-2251 treeSetUpdate
function 78ed7a907843 ~136 minified bytes
  src/tooling/migrate/pg-probe.ts:278-282 probeAddConstraint
  src/tooling/migrate/pg-probe.ts:296-300 probeValidate
function a59ccf6fba84 ~136 minified bytes
  src/dialects/pg/role/index.ts:197-200 contributeRoles
  src/runtime/client.ts:146-149 createClient
function 3696c2f6c20f ~135 minified bytes
  src/adapters/pg/nodepostgres.ts:158-161 open
  src/dialects/pg/schema.ts:1274-1277 (arrow)
  src/tooling/migrate/apply.ts:650-653 pushTarget
function 6565d6cc1624 ~135 minified bytes
  src/runtime/tree.ts:214-220 emitTree
  src/runtime/window.ts:228-234 emitWindow
function 972468f99f53 ~135 minified bytes
  src/tooling/canonical-json.ts:40-43 write
  src/tooling/migrate/reference.ts:208-211 literal
function 97ea84fa7f07 ~135 minified bytes
  src/contracts/catalog/document.ts:360-364 rewriteRenamed
  src/contracts/catalog/document.ts:870-874 rewriteType
  src/contracts/catalog/document.ts:894-898 rewriteSequence
  src/contracts/catalog/document.ts:1065-1069 definitionToJson
  src/tooling/migrate/pull-verify.ts:135-139 copyFunction
  src/tooling/migrate/pull-verify.ts:155-159 copyView
  src/tooling/migrate/pull-verify.ts:171-175 copyMatview
function a21aedc87c71 ~135 minified bytes
  src/tooling/migrate/pg-probe.ts:396-400 parseCreateIndex
  src/tooling/migrate/pg-probe.ts:499-503 parseAddEnum
function ba5535683c02 ~135 minified bytes
  src/contracts/catalog/document.ts:528-531 indexAgain
  src/runtime/pg/neon.ts:69-72 (arrow)
function bd36550ba383 ~135 minified bytes
  src/runtime/sync.ts:582-586 emitDistinct
  src/runtime/write.ts:1134-1138 updateSliceBody
function cd80e63e485b ~135 minified bytes
  src/runtime/tenancy/rls.ts:496-501 (arrow)
  src/runtime/tenancy/rls.ts:522-527 (arrow)
function ed46ffc657f8 ~135 minified bytes
  src/tooling/migrate/apply.ts:538-543 pushProject
  src/tooling/migrate/provision.ts:44-49 provision
function 343bb7ab21af ~134 minified bytes
  src/runtime/safety/index.ts:133-138 (function)
  src/runtime/safety/index.ts:171-176 (function)
  src/runtime/safety/index.ts:191-196 (function)
function 56aea619ecc4 ~134 minified bytes
  src/tooling/testing/factories.ts:592-596 requireTable
  src/tooling/testing/isolation.ts:666-670 requireFacts
function b16fa4941a35 ~134 minified bytes
  src/runtime/include.ts:123-128 emitIncludeSelect
  src/runtime/include.ts:241-244 emitIncludeJoin
function 0f4f067b0748 ~133 minified bytes
  src/adapters/pg/neon.ts:152-158 (arrow)
  src/adapters/pg/nodepostgres.ts:380-386 (arrow)
function 170b329145fb ~133 minified bytes
  src/tooling/migrate/pull-emit.ts:1051-1054 domainDefs
  src/tooling/migrate/reprint.ts:121-124 domainChecks
function 36b8d12e68ae ~133 minified bytes
  src/runtime/version.ts:546-556 outputsOf
  src/runtime/write.ts:2455-2465 outputsOf
function 5584de0cb0d6 ~133 minified bytes
  src/tooling/migrate/check.ts:405-408 sameSql
  src/tooling/migrate/check.ts:470-473 sameType
function 7119a3ce83ef ~133 minified bytes
  src/tooling/migrate/lint-rules.ts:1124-1127 numericBounds
  src/tooling/migrate/lint-rules.ts:1189-1192 numericSpec
function 73ea59be42dc ~133 minified bytes
  src/contracts/catalog/enum.ts:116-123 domainType
  src/contracts/catalog/object.ts:128-135 table
function 77db88e29a96 ~133 minified bytes
  src/tooling/testing/isolation.ts:58-63 isolation
  src/tooling/testing/isolation.ts:379-384 checkViews
function 8be3be08827e ~133 minified bytes
  src/dialects/pg/archive-bind.ts:55-57 rewriteArchivable
  src/runtime/write.ts:1879-1881 shapeObserver
function 9cde6ef9b2f0 ~133 minified bytes
  src/tooling/errors/examples.ts:824-827 (arrow)
  src/tooling/errors/examples.ts:829-832 (arrow)
  src/tooling/errors/examples.ts:848-851 (arrow)
function a9854cdb0733 ~133 minified bytes
  src/runtime/aggregate.ts:270-275 sumDecode
  src/runtime/window.ts:390-395 totalDecode
function b0203a5aa4b2 ~133 minified bytes
  src/tooling/errors/examples.ts:1025-1028 (arrow)
  src/tooling/errors/examples.ts:1051-1054 (arrow)
function 6941db9dbe20 ~132 minified bytes
  src/contracts/catalog/object.ts:364-369 constraint
  src/dialects/pg/fn/index.ts:441-444 (function)
function 8dbe8d5a47e3 ~132 minified bytes
  src/tooling/migrate/place.ts:159-163 relocateReferences
  src/tooling/migrate/place.ts:193-197 relocateIdentity
function 98c5a1f263dd ~132 minified bytes
  src/runtime/include.ts:229-231 emitIncludeJoin
  src/runtime/include.ts:292-294 emitNestedAggregate
  src/runtime/include.ts:503-505 emitMorphJoin
  src/runtime/window.ts:215-217 emitWindow
  src/runtime/write.ts:1889-1891 shapeObserver
  src/tooling/migrate/runner.ts:130-132 runTarget
  src/tooling/migrate/sandbox.ts:445-447 runSteps
function c3c3a294a23e ~132 minified bytes
  src/tooling/migrate/commands.ts:765-768 invokeOf
  src/tooling/migrate/pg-probe.ts:509-512 parseAddEnum
function ce5ca591696d ~132 minified bytes
  src/runtime/plan.ts:1158-1162 emitOrder
  src/runtime/topology.ts:368-372 connectTopology
function 0067b1c5ef7d ~131 minified bytes
  src/tooling/migrate/commands.ts:765-768 invokeOf
  src/tooling/migrate/pg-probe.ts:660-663 alterTable
function 1483eeaee048 ~131 minified bytes
  src/runtime/lock.ts:39-45 build
  src/runtime/tree.ts:77-83 build
function 4b779a9393a8 ~131 minified bytes
  src/adapters/pg/bunsql.ts:387-392 statsOf
  src/adapters/pg/neon.ts:371-376 statsOf
  src/adapters/pg/nodepostgres.ts:409-414 statsOf
  src/adapters/pg/postgresjs.ts:472-477 (arrow)
function 8a1bbedf0450 ~131 minified bytes
  src/runtime/write.ts:735-740 planUpdate
  src/runtime/write.ts:1405-1410 emitClaim
function ba1057c2827d ~131 minified bytes
  src/runtime/warnings/config.ts:41-44 assertProjectWarnings
  src/runtime/warnings/config.ts:58-61 parseWarningOptions
function 18c979e8d1f6 ~130 minified bytes
  src/runtime/warnings/config.ts:66-69 parseWarningOptions
  src/tooling/cli/parse.ts:196-199 parseCli
function 6604123a0a8c ~130 minified bytes
  src/contracts/catalog/json.ts:80-83 encodeEscaped
  src/contracts/utf8.ts:93-96 readCode
function 77bc5a8e6856 ~130 minified bytes
  src/runtime/plan.ts:1159-1162 emitOrder
  src/runtime/tenancy/composite.ts:390-393 writePredicate
  src/runtime/topology.ts:369-372 connectTopology
function 7d1fe791ebe9 ~130 minified bytes
  src/contracts/catalog/document.ts:1448-1454 parseFunction
  src/tooling/migrate/plan.ts:768-774 parsePlan
function 811762ace57f ~130 minified bytes
  src/dialects/pg/archive-bind.ts:252-254 foreignKeys
  src/dialects/pg/declarations.ts:39-41 schemaDeclarations
  src/runtime/tenancy/composite.ts:216-218 refuseGlobalReference
  src/runtime/tenancy/index.ts:235-237 refuseGlobalReference
function 9a132c2eda89 ~130 minified bytes
  src/dialects/pg/geometry.ts:68-73 decodePoint
  src/dialects/pg/temporal.ts:201-206 decodeTimeZone
function f7217d34fa6c ~130 minified bytes
  src/runtime/sort.ts:560-564 count
  src/runtime/write.ts:903-907 countCell
  src/tooling/migrate/pull.ts:218-222 countCell
function 28edfb17c944 ~129 minified bytes
  src/tooling/migrate/files.ts:39-43 loadMigrations
  src/tooling/migrate/lint.ts:121-125 lintMigrationDirectory
function 424672f0f4cc ~129 minified bytes
  src/runtime/topology.ts:442-446 connectTopology
  src/runtime/topology.ts:1121-1125 shutdown
function 96b8614691d2 ~129 minified bytes
  src/runtime/include.ts:228-232 emitIncludeJoin
  src/runtime/include.ts:502-506 emitMorphJoin
  src/runtime/window.ts:214-218 emitWindow
function c770bff40e0c ~129 minified bytes
  src/runtime/tenancy/via.ts:110-115 (arrow)
  src/runtime/tenancy/via.ts:133-138 (arrow)
  src/runtime/topology.ts:1959-1964 fromSelect
function c80f15ccc63f ~129 minified bytes
  src/tooling/errors/examples.ts:1642-1648 (arrow)
  src/tooling/errors/examples.ts:1654-1657 (arrow)
function e08a77fb4a11 ~129 minified bytes
  src/dialects/pg/lower.ts:542-547 columnAlterKinds
  src/dialects/pg/role/sql.ts:103-108 privilegeSql
literal 57ff8553dcc4 ~129 minified bytes x2
  src/runtime/page.ts:36
  src/tooling/errors/registry.ts:259
function 16b7d54de7e7 ~128 minified bytes
  src/runtime/drift-detail.ts:113-117 groupMigrations
  src/tooling/migrate/status.ts:408-412 readHistory
function 61cb8bedba04 ~128 minified bytes
  src/contracts/catalog/document.ts:1449-1454 parseFunction
  src/dialects/pg/ext/index.ts:134-139 extension
function a69b1b9afd37 ~128 minified bytes
  src/dialects/pg/trait.ts:210-214 contributedFields
  src/runtime/write.ts:1096-1100 updateSliceBody
function ad0e8d68550b ~128 minified bytes
  src/runtime/version.ts:457-461 primaryColumns
  src/runtime/write.ts:1980-1984 primaryColumns
function be408fadf6f1 ~128 minified bytes
  src/runtime/archive.ts:204-209 noteArchive
  src/runtime/write.ts:2602-2607 noteArchive
function db19efc221fa ~128 minified bytes
  src/dialects/pg/fn/touch.ts:23-26 timestampRecords
  src/tooling/migrate/pull-emit.ts:344-347 formatPullReport
  src/tooling/migrate/pull-routines.ts:122-125 planRoutines
function 19f54fddf48f ~127 minified bytes
  src/dialects/pg/fn/touch.ts:23-27 timestampRecords
  src/tooling/migrate/pull-emit.ts:344-348 formatPullReport
function 48d34785c6ff ~127 minified bytes
  src/tooling/testing/factories.ts:666-669 tableHandle
  src/tooling/testing/isolation.ts:715-718 tableHandle
function 4e9b7c0b38cd ~127 minified bytes
  src/adapters/pg/pglite.ts:263-269 (function)
  src/adapters/pg/postgresjs.ts:351-357 (function)
  src/adapters/pg/session.ts:93-99 (function)
function 767cf2d08388 ~127 minified bytes
  src/dialects/pg/view/refresh.ts:74-80 refreshView
  src/tooling/migrate/apply.ts:1125-1131 insertReference
function ac0b8acbef95 ~127 minified bytes
  src/runtime/bucket-group.ts:184-188 writeGrouped
  src/runtime/topology.ts:368-372 connectTopology
  src/runtime/window.ts:159-163 emitResultOrder
function 0b5a9c1e63f5 ~126 minified bytes
  src/tooling/migrate/place.ts:146-150 relocateCalls
  src/tooling/migrate/place.ts:225-229 moveRef
function 4332322fbb55 ~126 minified bytes
  src/runtime/bucket-group.ts:184-188 writeGrouped
  src/runtime/plan.ts:1158-1162 emitOrder
  src/runtime/tenancy/composite.ts:468-472 (arrow)
  src/runtime/topology.ts:368-372 connectTopology
  src/runtime/window.ts:159-163 emitResultOrder
function 617a696d8a8c ~126 minified bytes
  src/adapters/pg/neon.ts:210-215 openWebSocket
  src/adapters/pg/postgresjs.ts:214-224 open
function 7568a50c18e7 ~126 minified bytes
  src/tooling/init/package-json.ts:79-86 addDep
  src/tooling/init/package-json.ts:95-102 addScript
function beb7d7d5b486 ~126 minified bytes
  src/contracts/catalog/document.ts:1094-1097 definitionToJson
  src/dialects/pg/view/refresh.ts:83-86 refreshView
function d7c8063aa128 ~126 minified bytes
  src/runtime/archive.ts:329-333 restoreSql
  src/runtime/sync.ts:399-403 manyThrough
  src/runtime/sync.ts:502-506 emitDesired
  src/runtime/version.ts:407-411 anyClaimStatement
  src/runtime/write.ts:1007-1011 pathListUpdate
  src/runtime/write.ts:1109-1113 updateSliceBody
  src/runtime/write.ts:2060-2064 pathInsert
function ea1910bd2138 ~126 minified bytes
  src/runtime/aggregate.ts:134-138 build
  src/runtime/lock.ts:41-45 build
  src/runtime/tree.ts:79-83 build
function fd61837c554c ~126 minified bytes
  src/contracts/catalog/plan-order.ts:32-35 uniqueBeforeForeignKey
  src/tooling/migrate/requirements.ts:162-165 unique
function 05df40343f8f ~125 minified bytes
  src/tooling/errors/examples.ts:1514-1521 (arrow)
  src/tooling/errors/examples.ts:1561-1568 (arrow)
  src/tooling/errors/examples.ts:1574-1581 (arrow)
function 0b08ee4a8eec ~125 minified bytes
  src/runtime/archive.ts:329-333 restoreSql
  src/runtime/include.ts:191-195 emitIncludeJoin
  src/runtime/plan.ts:751-755 emitRead
  src/runtime/tree.ts:187-191 emitTree
  src/runtime/write.ts:1007-1011 pathListUpdate
function 1ffff5646b73 ~125 minified bytes
  src/runtime/topology.ts:2174-2177 parseLsn
  src/tooling/migrate/plan.ts:1586-1589 parseInList
function 223c832bc50e ~125 minified bytes
  src/runtime/trait-read.ts:37-41 fieldSealed
  src/runtime/trait-read.ts:55-59 sealingTrait
function 300f29a5750c ~125 minified bytes
  src/runtime/aggregate.ts:219-221 plan
  src/runtime/page.ts:130-132 plan
  src/tooling/migrate/commands.ts:766-768 invokeOf
  src/tooling/migrate/pg-probe.ts:510-512 parseAddEnum
function 6bfb42c47fab ~125 minified bytes
  src/dialects/pg/compile.ts:160-163 compileColumn
  src/tooling/migrate/api.ts:166-171 invokeOf
function 7701bed32de5 ~125 minified bytes
  src/dialects/pg/emit.ts:275-281 typescriptForPgType
  src/dialects/pg/view/scratch.ts:441-447 canonicalArgType
function 9f66aa9d0f93 ~125 minified bytes
  src/runtime/version.ts:312-315 (function)
  src/runtime/version.ts:355-358 claimStatement
function b699fe38f706 ~125 minified bytes
  src/dialects/pg/ops/lane.ts:374-378 predicateOf
  src/runtime/write.ts:2078-2082 pathInsert
function baee7f52ff4f ~125 minified bytes
  src/contracts/catalog/extension.ts:49-55 extensionObject
  src/contracts/catalog/routine.ts:124-130 functionObject
  src/contracts/catalog/view.ts:93-99 viewObject
  src/contracts/catalog/view.ts:122-128 materializedViewObject
function dbc177300961 ~125 minified bytes
  src/contracts/catalog/document.ts:1107-1110 definitionToJson
  src/tooling/describe/lock.ts:249-252 (arrow)
function eb1e9139ea83 ~125 minified bytes
  src/tooling/migrate/pull-emit.ts:1239-1243 prefixed
  src/tooling/migrate/snapshot.ts:119-123 markedMigrationId
function f30e29da04ba ~125 minified bytes
  src/runtime/include.ts:583-586 decodeRowIncluded
  src/runtime/include.ts:603-606 decodeInclude
  src/runtime/include.ts:631-634 decodeJsonInclude
  src/runtime/plan.ts:1441-1444 decodeRow
function 0a3e55aa4a59 ~124 minified bytes
  src/tooling/testing/facts.ts:97-102 readFacts
  src/tooling/testing/facts.ts:133-138 readViews
function 76f7cc3ec4e2 ~124 minified bytes
  src/contracts/catalog/enum.ts:117-123 domainType
  src/contracts/catalog/extension.ts:49-55 extensionObject
  src/contracts/catalog/object.ts:129-135 table
  src/contracts/catalog/routine.ts:124-130 functionObject
  src/contracts/catalog/view.ts:93-99 viewObject
  src/contracts/catalog/view.ts:122-128 materializedViewObject
function 8db39668de3c ~124 minified bytes
  src/contracts/catalog/document.ts:1453-1456 parseFunction
  src/dialects/pg/view/refresh.ts:83-85 refreshView
function 8e1d3051d942 ~124 minified bytes
  src/dialects/pg/introspect.ts:1269-1274 unwrapTriggerWhen
  src/tooling/migrate/lint-rules.ts:592-597 unwrap
  src/tooling/migrate/pg-probe.ts:574-579 wrapped
  src/tooling/migrate/pg-probe.ts:722-727 readParen
function a3cebb8e2286 ~124 minified bytes
  src/runtime/archive.ts:330-333 restoreSql
  src/runtime/include.ts:192-195 emitIncludeJoin
  src/runtime/plan.ts:752-755 emitRead
  src/runtime/sync.ts:400-403 manyThrough
  src/runtime/sync.ts:486-489 emitSelectLocked
  src/runtime/sync.ts:503-506 emitDesired
  src/runtime/sync.ts:523-526 emitChildMatch
  src/runtime/sync.ts:541-544 emitSetCase
  src/runtime/sync.ts:582-585 emitDistinct
  src/runtime/tree.ts:188-191 emitTree
  src/runtime/version.ts:283-286 targetStatement
  src/runtime/version.ts:408-411 anyClaimStatement
  src/runtime/write.ts:1008-1011 pathListUpdate
  src/runtime/write.ts:1110-1113 updateSliceBody
  src/runtime/write.ts:2061-2064 pathInsert
function b35ecc0428eb ~124 minified bytes
  src/tooling/migrate/pull-emit.ts:1050-1053 domainDefs
  src/tooling/migrate/reprint.ts:131-134 sqlBodies
function f061d74e2008 ~124 minified bytes
  src/runtime/client.ts:797-800 errorFields
  src/runtime/write.ts:2677-2680 scrubWrite
function 1f8d93d868f0 ~123 minified bytes
  src/dialects/pg/errors.ts:560-563 valuesOf
  src/dialects/pg/lower.ts:518-521 alterColumn
  src/dialects/pg/schema.ts:1253-1256 compileForeignKeys
  src/runtime/archive.ts:443-446 joinOn
  src/runtime/page.ts:202-205 (arrow)
  src/runtime/safety/index.ts:439-442 sameViolations
  src/runtime/tenancy/composite.ts:295-298 rewriteTenant
  src/tooling/migrate/plan.ts:1188-1191 columnsAppended
  src/tooling/testing/factories.ts:461-464 paired
function 23eaa50c1ac2 ~123 minified bytes
  src/adapters/pg/pglite.ts:200-205 describeOnPglite
  src/runtime/topology.ts:1958-1963 fromSelect
function 296dedf6c66a ~123 minified bytes
  src/runtime/safety/index.ts:134-138 (function)
  src/runtime/safety/index.ts:172-176 (function)
  src/runtime/safety/index.ts:192-196 (function)
  src/runtime/safety/index.ts:222-226 (function)
  src/runtime/safety/index.ts:265-269 (function)
function 3e7a1ff2971a ~123 minified bytes
  src/runtime/write.ts:2211-2214 tenantKeys
  src/tooling/testing/factories.ts:421-424 tenantKeyNames
  src/tooling/testing/isolation.ts:247-250 tenantKeys
function 4376a82c10c4 ~123 minified bytes
  src/dialects/pg/ops/lane.ts:485-489 (arrow)
  src/runtime/conflict.ts:138-141 lookupExisting
  src/runtime/sort.ts:360-363 moveStatement
function 5496cf2a1aeb ~123 minified bytes
  src/runtime/topology.ts:1268-1270 (arrow)
  src/runtime/topology.ts:1483-1485 readStream
function 647ac130413c ~123 minified bytes
  src/tooling/migrate/status.ts:405-411 readHistory
  src/tooling/migrate/status.ts:431-437 readBackfills
  src/tooling/migrate/status.ts:462-468 readSteps
function 83c66a5a0d8c ~123 minified bytes
  src/runtime/include.ts:582-586 decodeRowIncluded
  src/runtime/plan.ts:1440-1444 decodeRow
function bc11dfa407ea ~123 minified bytes
  src/dialects/pg/role/sql.ts:81-85 privilegeSql
  src/tooling/migrate/plan.ts:339-343 planMigration
function be7bf8e6a860 ~123 minified bytes
  src/dialects/pg/temporal.ts:21-23 requireTemporal
  src/runtime/bucket-group.ts:270-272 decodeDay
function c1a9d193affc ~123 minified bytes
  src/dialects/pg/schema.ts:523-526 schema
  src/dialects/pg/table.ts:569-572 buildIndex
  src/runtime/client.ts:906-909 callOptions
  src/tooling/migrate/import-drizzle.ts:672-675 columnOf
function 1096a7bb7210 ~122 minified bytes
  src/contracts/catalog/document.ts:1450-1454 parseFunction
  src/dialects/pg/table.ts:567-571 buildIndex
function 179f484c6751 ~122 minified bytes
  src/runtime/exposure.ts:169-171 walk
  src/runtime/plan.ts:1561-1563 plain
function 2ceaaa86faa4 ~122 minified bytes
  src/runtime/sync.ts:485-489 emitSelectLocked
  src/runtime/sync.ts:522-526 emitChildMatch
  src/runtime/sync.ts:540-544 emitSetCase
  src/runtime/sync.ts:581-585 emitDistinct
function 407439a77113 ~122 minified bytes
  src/contracts/catalog/order.ts:28-32 indexObjects
  src/dialects/pg/view/client.ts:244-248 columnModels
function 83644fd76382 ~122 minified bytes
  src/runtime/write.ts:1884-1888 shapeObserver
  src/tooling/migrate/import-drizzle.ts:322-326 collect
  src/tooling/migrate/plan.ts:339-343 planMigration
function 9e7f623bbe5e ~122 minified bytes
  src/runtime/validate/engine.ts:121-123 finish
  src/runtime/validate/engine.ts:143-145 issuesOf
function ade0db8a6c10 ~122 minified bytes
  src/tooling/testing/factories.ts:467-471 paired
  src/tooling/testing/isolation.ts:228-232 primaryWhere
function d02c9af17363 ~122 minified bytes
  src/contracts/catalog/document.ts:1051-1054 definitionToJson
  src/runtime/client.ts:797-800 errorFields
  src/runtime/exposure.ts:71-74 scrubCall
  src/runtime/pg/neon.ts:65-68 (arrow)
  src/runtime/write.ts:2677-2680 scrubWrite
function e8da0a0a0fdc ~122 minified bytes
  src/adapters/pg/batch.ts:113-117 statementsOf
  src/tooling/init/engine.ts:351-355 applyWrites
function ebc3764cac0d ~122 minified bytes
  src/tooling/migrate/doctor.ts:88-94 doctorProject
  src/tooling/migrate/server-requirements.ts:75-81 assertSchemaMajor
  src/tooling/migrate/server-requirements.ts:98-104 assertSchemaExtensions
  src/tooling/migrate/server-requirements.ts:121-127 assertSchemaRequirements
function 6f64ae6d437b ~121 minified bytes
  src/tooling/describe/scan.ts:141-144 callsInFile
  src/tooling/untrusted.ts:146-149 keep
function b049dae99928 ~121 minified bytes
  src/runtime/tenancy/via.ts:110-116 (arrow)
  src/runtime/tenancy/via.ts:133-139 (arrow)
function d3be2fc33269 ~121 minified bytes
  src/runtime/tenancy/rls.ts:270-277 runReadOnly
  src/runtime/topology.ts:1339-1346 (arrow)
function e8d1305dc228 ~121 minified bytes
  src/adapters/pg/bunsql.ts:255-261 (function)
  src/adapters/pg/neon.ts:260-266 (function)
  src/adapters/pg/nodepostgres.ts:238-244 (function)
  src/adapters/pg/pglite.ts:129-135 (function)
function 06d85020aee3 ~120 minified bytes
  src/tooling/errors/examples.ts:1094-1099 (arrow)
  src/tooling/errors/examples.ts:1103-1108 (arrow)
function 1da1abbd3af4 ~120 minified bytes
  src/dialects/pg/view/refresh.ts:74-80 refreshView
  src/runtime/tenancy/rls.ts:305-311 streamHeld
  src/runtime/topology.ts:1376-1382 (function)
  src/tooling/migrate/apply.ts:1125-1131 insertReference
function 2467accc94ff ~120 minified bytes
  src/contracts/catalog/enum.ts:110-114 domainType
  src/contracts/catalog/object.ts:179-185 column
function 2947623408ff ~120 minified bytes
  src/tooling/describe/protocol.ts:183-189 (function)
  src/tooling/describe/protocol.ts:213-219 (function)
function 5727e59cb5d0 ~120 minified bytes
  src/dialects/pg/custom.ts:36-39 custom
  src/runtime/safety/index.ts:135-138 (function)
function 5a18e866791c ~120 minified bytes
  src/dialects/pg/column.ts:658-662 (function)
  src/runtime/client.ts:906-910 callOptions
function a29b9c24ac45 ~120 minified bytes
  src/runtime/client.ts:906-909 callOptions
  src/tooling/migrate/plan.ts:772-775 parsePlan
function 0f19f792b450 ~119 minified bytes
  src/runtime/include.ts:116-119 emitIncludeSelect
  src/runtime/include.ts:291-294 emitNestedAggregate
  src/runtime/include.ts:502-505 emitMorphJoin
  src/runtime/window.ts:214-217 emitWindow
  src/tooling/migrate/runner.ts:129-132 runTarget
function 41af0f0ad09a ~119 minified bytes
  src/runtime/include.ts:349-354 readIncludes
  src/runtime/sync.ts:688-693 requireRelation
function 6bfadd946a34 ~119 minified bytes
  src/dialects/pg/view/refresh.ts:74-79 refreshView
  src/runtime/tenancy/rls.ts:305-310 streamHeld
  src/runtime/topology.ts:1376-1381 (function)
  src/tooling/migrate/apply.ts:766-771 restampHeadHash
  src/tooling/migrate/apply.ts:1062-1067 provisionEmpty
  src/tooling/migrate/apply.ts:1125-1130 insertReference
  src/tooling/migrate/baseline.ts:207-212 runBaseline
function 707c7dffc775 ~119 minified bytes
  src/runtime/plan.ts:793-798 emitJoin
  src/runtime/tree.ts:257-262 emitStep
function 73a3e27fc2b5 ~119 minified bytes
  src/tooling/migrate/drift.ts:48-55 assertAuthorDrift
  src/tooling/migrate/sandbox.ts:380-387 dropScratch
function 91634f3670da ~119 minified bytes
  src/dialects/pg/view/client.ts:292-294 readsTenant
  src/runtime/tenancy/via.ts:77-79 classify
function 9b363f55a28c ~119 minified bytes
  src/runtime/archive.ts:329-333 restoreSql
  src/runtime/include.ts:191-195 emitIncludeJoin
  src/runtime/plan.ts:751-755 emitRead
  src/runtime/sync.ts:399-403 manyThrough
  src/runtime/sync.ts:502-506 emitDesired
  src/runtime/tree.ts:187-191 emitTree
  src/runtime/version.ts:282-286 targetStatement
  src/runtime/version.ts:407-411 anyClaimStatement
  src/runtime/write.ts:1007-1011 pathListUpdate
  src/runtime/write.ts:1109-1113 updateSliceBody
  src/runtime/write.ts:1305-1309 rowKey
  src/runtime/write.ts:2060-2064 pathInsert
function bdb14e47bc2b ~119 minified bytes
  src/dialects/pg/emit.ts:42-46 emitRowTypes
  src/dialects/pg/role/sql.ts:82-86 privilegeSql
function c6e74176e80c ~119 minified bytes
  src/dialects/pg/ops/lane.ts:484-488 (arrow)
  src/runtime/archive.ts:277-281 archiveSql
  src/runtime/archive.ts:361-365 restoreSql
  src/runtime/sort.ts:457-461 joinOn
  src/runtime/version.ts:527-531 closeUpdated
  src/runtime/write.ts:1115-1119 updateSliceBody
function d37baa2976fc ~119 minified bytes
  src/dialects/pg/schema.ts:441-445 schema
  src/dialects/pg/schema.ts:531-534 acceptTables
function fb60d8ad9c23 ~119 minified bytes
  src/tooling/migrate/resolve.ts:147-152 resolveOnTarget
  src/tooling/migrate/status.ts:230-235 readTargetStatus
literal 042b77c102b0 ~119 minified bytes x2
  src/tooling/errors/registry.ts:573
  src/tooling/migrate/check.ts:69
literal 843f41a125ca ~119 minified bytes x2
  src/runtime/version.ts:115
  src/runtime/version.ts:251
function 185106b688e1 ~118 minified bytes
  src/runtime/archive.ts:277-281 archiveSql
  src/runtime/archive.ts:361-365 restoreSql
  src/runtime/conflict.ts:137-141 lookupExisting
  src/runtime/sort.ts:457-461 joinOn
  src/runtime/version.ts:527-531 closeUpdated
  src/runtime/write.ts:1115-1119 updateSliceBody
function 54209c0a4a15 ~118 minified bytes
  src/dialects/pg/integer.ts:70-75 bigint
  src/dialects/pg/integer.ts:111-116 identity
function 611990121457 ~118 minified bytes
  src/tooling/migrate/runner.ts:808-811 statementOutsideTransaction
  src/tooling/testing/record.ts:57-60 isTransactionControl
function 7a8392c15458 ~118 minified bytes
  src/runtime/version.ts:420-424 anyClaimStatement
  src/runtime/window.ts:158-162 emitResultOrder
function 7eff69d33918 ~118 minified bytes
  src/runtime/write.ts:2027-2030 keyExpr
  src/runtime/write.ts:2448-2451 (arrow)
function a776cb6ca9e0 ~118 minified bytes
  src/dialects/pg/introspect.ts:423-427 introspectSchema
  src/runtime/archive.ts:329-333 restoreSql
  src/runtime/plan.ts:768-772 emitRead
  src/runtime/sync.ts:399-403 manyThrough
  src/runtime/sync.ts:502-506 emitDesired
  src/runtime/version.ts:282-286 targetStatement
  src/runtime/version.ts:407-411 anyClaimStatement
  src/runtime/write.ts:1007-1011 pathListUpdate
  src/runtime/write.ts:1109-1113 updateSliceBody
  src/runtime/write.ts:2060-2064 pathInsert
function beba9f6adecf ~118 minified bytes
  src/dialects/pg/introspect.ts:1267-1272 unwrapTriggerWhen
  src/tooling/migrate/lint-rules.ts:590-595 unwrap
  src/tooling/migrate/pg-probe.ts:629-634 splitCommas
function da8b9ed83ec5 ~118 minified bytes
  src/contracts/catalog/document.ts:1451-1454 parseFunction
  src/dialects/pg/compile.ts:154-157 compileColumn
function df1c1e12222c ~118 minified bytes
  src/dialects/pg/view/refresh.ts:75-80 refreshView
  src/runtime/tenancy/rls.ts:306-311 streamHeld
  src/runtime/topology.ts:1377-1382 (function)
  src/tooling/migrate/apply.ts:1126-1131 insertReference
  src/tooling/migrate/step-journal.ts:116-121 completeMarker
function e25ef5a8e277 ~118 minified bytes
  src/dialects/pg/view/client.ts:292-294 readsTenant
  src/runtime/tenancy/rls.ts:314-316 refuseVia
  src/runtime/tenancy/via.ts:77-79 classify
function 019f97e165a8 ~117 minified bytes
  src/dialects/pg/ops/lane.ts:485-488 (arrow)
  src/runtime/archive.ts:278-281 archiveSql
  src/runtime/archive.ts:362-365 restoreSql
  src/runtime/conflict.ts:138-141 lookupExisting
  src/runtime/sort.ts:360-363 moveStatement
  src/runtime/sort.ts:444-447 flipStatement
  src/runtime/sort.ts:458-461 joinOn
  src/runtime/version.ts:528-531 closeUpdated
  src/runtime/write.ts:1116-1119 updateSliceBody
function 57bc17e2e840 ~117 minified bytes
  src/tooling/migrate/apply.ts:767-771 restampHeadHash
  src/tooling/migrate/apply.ts:1063-1067 provisionEmpty
  src/tooling/migrate/baseline.ts:208-212 runBaseline
  src/tooling/migrate/step-journal.ts:116-120 completeMarker
function 5ac534b88f4a ~117 minified bytes
  src/runtime/plan.ts:1157-1161 emitOrder
  src/runtime/version.ts:420-424 anyClaimStatement
function 735ee495c83f ~117 minified bytes
  src/runtime/sync.ts:486-489 emitSelectLocked
  src/runtime/sync.ts:523-526 emitChildMatch
  src/runtime/sync.ts:541-544 emitSetCase
  src/runtime/sync.ts:582-585 emitDistinct
  src/runtime/write.ts:1306-1309 rowKey
function 758a69af2874 ~117 minified bytes
  src/dialects/pg/errors.ts:558-561 valuesOf
  src/runtime/tenancy/composite.ts:467-470 (arrow)
  src/tooling/testing/factories.ts:459-462 paired
function 8b90483b04a1 ~117 minified bytes
  src/dialects/pg/view/depend.ts:65-68 viewDependencyEdges
  src/tooling/cli/parse.ts:159-163 parseCli
function 8ec7c5e1ffed ~117 minified bytes
  src/contracts/catalog/plan-order.ts:32-35 uniqueBeforeForeignKey
  src/dialects/pg/archive-bind.ts:171-174 childLinks
function 90f05d5af37d ~117 minified bytes
  src/runtime/sort.ts:358-363 moveStatement
  src/runtime/sort.ts:442-447 flipStatement
function afcef4d4d6fa ~117 minified bytes
  src/tooling/migrate/pg-probe.ts:573-577 wrapped
  src/tooling/migrate/pg-probe.ts:630-634 splitCommas
function ea154c944c66 ~117 minified bytes
  src/runtime/operator-sql.ts:133-137 emitPath
  src/runtime/write.ts:1517-1521 emitJsonSet
function 02d491994995 ~116 minified bytes
  src/tooling/errors/examples.ts:255-262 unknownEngine
  src/tooling/errors/examples.ts:264-271 appliedEngine
function 26e584684c16 ~116 minified bytes
  src/contracts/error.ts:643-645 fromDriver
  src/dialects/pg/schema.ts:524-526 schema
function 3bfe5eec0d86 ~116 minified bytes
  src/runtime/write.ts:818-822 finishParent
  src/runtime/write.ts:830-834 finishTree
function 4be5c4a8a297 ~116 minified bytes
  src/dialects/pg/fn/index.ts:235-239 (arrow)
  src/dialects/pg/fn/index.ts:440-444 (function)
function 67092cdaace3 ~116 minified bytes
  src/dialects/pg/introspect.ts:184-188 introspectSchema
  src/tooling/migrate/plan.ts:1023-1027 assertUnambiguous
function 9be3ff1a8154 ~116 minified bytes
  src/adapters/pg/batch.ts:112-114 statementsOf
  src/adapters/pg/result.ts:70-72 rowCells
function 1c8496bcacef ~115 minified bytes
  src/runtime/aggregate.ts:134-138 build
  src/runtime/lock.ts:41-45 build
  src/runtime/page.ts:78-82 build
  src/runtime/tree.ts:79-83 build
function 6af31033f09e ~115 minified bytes
  src/adapters/pg/neon.ts:198-202 send
  src/adapters/pg/nodepostgres.ts:276-280 send
function 722092a25dd0 ~115 minified bytes
  src/dialects/pg/ops/lane.ts:484-488 (arrow)
  src/runtime/archive.ts:277-281 archiveSql
  src/runtime/plan.ts:777-781 emitRead
  src/runtime/sort.ts:457-461 joinOn
  src/runtime/version.ts:527-531 closeUpdated
function 800e07d2b047 ~115 minified bytes
  src/tooling/errors/examples.ts:881-883 (arrow)
  src/tooling/errors/examples.ts:885-887 (arrow)
  src/tooling/errors/examples.ts:897-899 (arrow)
  src/tooling/errors/examples.ts:905-907 (arrow)
  src/tooling/errors/examples.ts:909-911 (arrow)
function db77b44482fb ~115 minified bytes
  src/runtime/tenancy/via.ts:133-139 (arrow)
  src/runtime/topology.ts:463-469 (arrow)
function f824565c366c ~115 minified bytes
  src/tooling/describe/scan.ts:141-144 callsInFile
  src/tooling/describe/scan.ts:189-192 importedRaw
function 169413620b19 ~114 minified bytes
  src/dialects/pg/schema.ts:1251-1254 compileForeignKeys
  src/tooling/describe/scan.ts:140-143 callsInFile
function 3919f783554c ~114 minified bytes
  src/runtime/archive.ts:330-333 restoreSql
  src/runtime/include.ts:192-195 emitIncludeJoin
  src/runtime/plan.ts:752-755 emitRead
  src/runtime/sync.ts:400-403 manyThrough
  src/runtime/sync.ts:503-506 emitDesired
  src/runtime/tree.ts:188-191 emitTree
  src/runtime/tree.ts:223-226 emitKeyList
  src/runtime/version.ts:283-286 targetStatement
  src/runtime/version.ts:408-411 anyClaimStatement
  src/runtime/write.ts:1008-1011 pathListUpdate
  src/runtime/write.ts:1110-1113 updateSliceBody
  src/runtime/write.ts:1306-1309 rowKey
  src/runtime/write.ts:2061-2064 pathInsert
function 5254658168a1 ~114 minified bytes
  src/tooling/errors/examples.ts:937-941 (arrow)
  src/tooling/errors/examples.ts:957-961 (arrow)
function 55b1783ee789 ~114 minified bytes
  src/dialects/pg/ops/lane.ts:484-489 (arrow)
  src/runtime/conflict.ts:137-141 lookupExisting
function 60e79d787402 ~114 minified bytes
  src/runtime/archive.ts:427-431 primarySql
  src/runtime/version.ts:457-461 primaryColumns
  src/runtime/write.ts:1980-1984 primaryColumns
function 7b4bdb24ee2e ~114 minified bytes
  src/runtime/bucket-group.ts:185-188 writeGrouped
  src/runtime/tenancy/composite.ts:390-393 writePredicate
  src/runtime/tenancy/composite.ts:469-472 (arrow)
  src/runtime/window.ts:160-163 emitResultOrder
function 7d5558a5db4b ~114 minified bytes
  src/runtime/conflict.ts:137-140 lookupExisting
  src/tooling/describe/scan.ts:141-144 callsInFile
function 979b9beacaf3 ~114 minified bytes
  src/dialects/pg/view/scratch.ts:143-147 scratchSearchPath
  src/tooling/migrate/drift.ts:174-177 tableColumns
function 9ec93db1228b ~114 minified bytes
  src/dialects/pg/introspect.ts:423-427 introspectSchema
  src/runtime/include.ts:191-195 emitIncludeJoin
  src/runtime/tree.ts:187-191 emitTree
  src/runtime/write.ts:1305-1309 rowKey
function b1b05ac7d177 ~114 minified bytes
  src/runtime/tenancy/composite.ts:468-471 (arrow)
  src/tooling/migrate/sandbox.ts:83-86 (arrow)
function b5876ea7b293 ~114 minified bytes
  src/dialects/pg/role/sql.ts:82-85 privilegeSql
  src/tooling/migrate/import-drizzle.ts:322-325 collect
function c90e1891b691 ~114 minified bytes
  src/runtime/conflict.ts:137-141 lookupExisting
  src/runtime/plan.ts:777-781 emitRead
function f50569e03f94 ~114 minified bytes
  src/adapters/error.ts:129-131 errorField
  src/contracts/connection.ts:111-113 readCode
  src/tooling/migrate/sandbox.ts:636-638 cell
function 161edee6abfa ~113 minified bytes
  src/runtime/batch.ts:181-184 recover
  src/runtime/bucket-group.ts:185-188 writeGrouped
  src/runtime/plan.ts:1159-1162 emitOrder
  src/runtime/tenancy/composite.ts:469-472 (arrow)
  src/runtime/topology.ts:369-372 connectTopology
  src/runtime/window.ts:160-163 emitResultOrder
function 1a6e8efa150c ~113 minified bytes
  src/runtime/archive-handle.ts:135-144 run
  src/runtime/client.ts:444-448 runWrite
function 27f287018c3d ~113 minified bytes
  src/runtime/conflict.ts:136-140 lookupExisting
  src/tooling/untrusted.ts:145-149 keep
function 36d06628ea0e ~113 minified bytes
  src/runtime/text-search.ts:178-181 searchable
  src/runtime/text-search.ts:187-190 hiddenSearch
function 41308859ec13 ~113 minified bytes
  src/dialects/pg/ops/lane.ts:256-259 openTable
  src/runtime/plan.ts:1462-1465 indexes
function 4ea37b5ed632 ~113 minified bytes
  src/runtime/plan.ts:778-781 emitRead
  src/runtime/sort.ts:360-363 moveStatement
  src/runtime/sort.ts:444-447 flipStatement
function 678799a08b96 ~113 minified bytes
  src/dialects/pg/compile.ts:160-161 compileColumn
  src/dialects/pg/schema.ts:1490-1491 tableModel
function 86968aa87e2c ~113 minified bytes
  src/dialects/pg/introspect.ts:423-426 introspectSchema
  src/dialects/pg/ops/lane.ts:484-487 (arrow)
  src/runtime/bucket-group.ts:184-187 writeGrouped
function 9306ee6b9031 ~113 minified bytes
  src/tooling/migrate/export.ts:569-572 exportFlags
  src/tooling/migrate/import-drizzle.ts:195-198 parseImportArgs
  src/tooling/migrate/pull.ts:124-127 parsePullArgs
function cc04ec8ff01f ~113 minified bytes
  src/dialects/pg/introspect.ts:424-427 introspectSchema
  src/runtime/sync.ts:486-489 emitSelectLocked
  src/runtime/sync.ts:523-526 emitChildMatch
  src/runtime/sync.ts:541-544 emitSetCase
  src/runtime/sync.ts:582-585 emitDistinct
  src/runtime/tree.ts:223-226 emitKeyList
function daa33ceabd48 ~113 minified bytes
  src/runtime/version.ts:291-295 targetStatement
  src/runtime/version.ts:351-355 claimStatement
  src/runtime/version.ts:417-421 anyClaimStatement
function dc3ed3897a96 ~113 minified bytes
  src/dialects/pg/introspect.ts:423-426 introspectSchema
  src/dialects/pg/lower.ts:315-318 addValueStatements
function 2f933dcd37d5 ~112 minified bytes
  src/tooling/migrate/commands.ts:469-473 extTestCommand
  src/tooling/migrate/commands.ts:708-712 seed
function 35ad13817214 ~112 minified bytes
  src/contracts/catalog/document.ts:1451-1454 parseFunction
  src/dialects/pg/compile.ts:154-157 compileColumn
  src/runtime/client.ts:906-909 callOptions
  src/tooling/migrate/import-drizzle.ts:671-674 columnOf
function 60e8d91c8c6d ~112 minified bytes
  src/tooling/migrate/extensions.ts:90-93 assertExtensionsAvailable
  src/tooling/migrate/server-requirements.ts:56-59 extensionsCreatedByMigrations
function 6d5a95356603 ~112 minified bytes
  src/dialects/pg/schema.ts:755-757 bareTables
  src/dialects/pg/view/client.ts:292-294 readsTenant
  src/runtime/tenancy/via.ts:77-79 classify
function a3c3d644cd0c ~112 minified bytes
  src/runtime/sync.ts:780-783 tenantSql
  src/runtime/tree.ts:342-345 identityColumn
function b3be7a56c462 ~112 minified bytes
  src/runtime/plan.ts:793-797 emitJoin
  src/runtime/sync.ts:525-529 emitChildMatch
  src/runtime/sync.ts:597-601 emitJoinLocked
function bb88ec84b0fc ~112 minified bytes
  src/tooling/describe/lock.ts:85-86 parseLock
  src/tooling/init/engine.ts:877-878 readRecord
function 21c65f1682d7 ~111 minified bytes
  src/tooling/errors/examples.ts:716-719 (arrow)
  src/tooling/errors/examples.ts:723-725 (arrow)
function 4b76c9477019 ~111 minified bytes
  src/contracts/catalog/document.ts:1451-1454 parseFunction
  src/dialects/pg/column.ts:658-661 (function)
  src/dialects/pg/compile.ts:154-157 compileColumn
  src/dialects/pg/ext/index.ts:136-139 extension
  src/dialects/pg/table.ts:568-571 buildIndex
function 541227c984f5 ~111 minified bytes
  src/dialects/pg/schema.ts:1252-1254 compileForeignKeys
  src/runtime/archive.ts:442-444 joinOn
  src/runtime/conflict.ts:137-139 lookupExisting
  src/runtime/validate/engine.ts:93-95 finishUpdate
  src/tooling/describe/scan.ts:141-143 callsInFile
  src/tooling/untrusted.ts:146-148 keep
function 55401ccb383d ~111 minified bytes
  src/dialects/pg/ext/call.ts:22-27 fnEqualsArg
  src/dialects/pg/ext/call.ts:55-60 fnDistance
function 7f1eda7a281e ~111 minified bytes
  src/dialects/pg/schema.ts:523-526 schema
  src/tooling/migrate/plan.ts:773-776 parsePlan
function af5c7611e61e ~111 minified bytes
  src/dialects/pg/schema.ts:1251-1254 compileForeignKeys
  src/runtime/validate/engine.ts:92-95 finishUpdate
  src/tooling/cli/parse.ts:289-292 commandWords
  src/tooling/describe/scan.ts:140-143 callsInFile
  src/tooling/migrate/pull.ts:116-119 parsePullArgs
function b3dac18c0dbd ~111 minified bytes
  src/runtime/sync.ts:485-489 emitSelectLocked
  src/runtime/sync.ts:522-526 emitChildMatch
  src/runtime/sync.ts:540-544 emitSetCase
  src/runtime/sync.ts:581-585 emitDistinct
  src/runtime/tree.ts:222-226 emitKeyList
function c160e0a73fe7 ~111 minified bytes
  src/dialects/pg/errors.ts:507-510 fieldKey
  src/runtime/trait-read.ts:18-21 touchFields
function cd0bd8dd2423 ~111 minified bytes
  src/runtime/tenancy/composite.ts:166-168 rewriteTables
  src/runtime/tenancy/index.ts:183-185 rewriteTables
  src/runtime/tenancy/path.ts:106-108 compilePaths
function 1c05f8c67eb8 ~110 minified bytes
  src/runtime/tenancy/composite.ts:72-74 compositeTenancy
  src/runtime/tenancy/index.ts:98-100 columnTenancy
  src/tooling/migrate/pull-routines.ts:422-424 matchNames
function 397583653121 ~110 minified bytes
  src/runtime/include.ts:117-119 emitIncludeSelect
  src/runtime/include.ts:229-231 emitIncludeJoin
  src/runtime/include.ts:292-294 emitNestedAggregate
  src/runtime/include.ts:503-505 emitMorphJoin
  src/runtime/topology.ts:609-611 preview
  src/runtime/window.ts:215-217 emitWindow
  src/runtime/write.ts:1889-1891 shapeObserver
  src/tooling/migrate/runner.ts:130-132 runTarget
function 47720456289c ~110 minified bytes
  src/runtime/include.ts:562-565 decodeMorph
  src/runtime/include.ts:630-633 decodeJsonInclude
function 596c8cf02366 ~110 minified bytes
  src/dialects/pg/schema.ts:531-535 acceptTables
  src/tooling/migrate/pull-emit.ts:168-173 emitPull
function 70bbb18324e5 ~110 minified bytes
  src/tooling/testing/isolation.ts:330-333 checkPath
  src/tooling/testing/isolation.ts:577-580 dropNewRows
function a634fc675c8c ~110 minified bytes
  src/runtime/validate/places.ts:114-118 readSetting
  src/runtime/validate/places.ts:132-136 tableSetting
function bb08ad9c6081 ~110 minified bytes
  src/runtime/sort.ts:238-242 moveColumn
  src/runtime/tree.ts:344-348 identityColumn
function c36b87504bed ~110 minified bytes
  src/tooling/migrate/lint-rules.ts:915-916 widenValidate
  src/tooling/migrate/lint-rules.ts:934-935 addedConstraint
function cd619ee6996b ~110 minified bytes
  src/runtime/topology.ts:1453-1458 choose
  src/runtime/topology.ts:1624-1629 retryOf
function 03c7a27f9d98 ~109 minified bytes
  src/tooling/describe/scan.ts:340-345 lex
  src/tooling/migrate/lint-rules.ts:451-456 sqlWords
function 1243ac3f9ce3 ~109 minified bytes
  src/runtime/client.ts:758-761 readCall
  src/runtime/read-stream.ts:195-198 pageFields
function 22d77355f035 ~109 minified bytes
  src/dialects/pg/morph.ts:244-249 (arrow)
  src/runtime/include.ts:534-539 emitMorphJoin
  src/runtime/sync.ts:526-531 emitChildMatch
  src/runtime/sync.ts:598-603 emitJoinLocked
function 2a0b8c5676c5 ~109 minified bytes
  src/tooling/errors/examples.ts:979-986 (arrow)
  src/tooling/errors/examples.ts:999-1006 (arrow)
  src/tooling/errors/examples.ts:1007-1014 (arrow)
function 49f4ef13bfee ~109 minified bytes
  src/tooling/errors/examples.ts:1360-1362 (arrow)
  src/tooling/errors/examples.ts:1370-1372 (arrow)
function 844d339804ca ~109 minified bytes
  src/runtime/topology.ts:845-848 readProbe
  src/tooling/migrate/plan.ts:1586-1589 parseInList
function 9c6bf8074db3 ~109 minified bytes
  src/tooling/describe/scan.ts:332-338 lex
  src/tooling/describe/scan.ts:410-416 skipJsxElement
function adfb9be35e92 ~109 minified bytes
  src/runtime/topology.ts:1341-1349 (arrow)
  src/runtime/topology.ts:1377-1385 (function)
function bbe8b3473ff6 ~109 minified bytes
  src/dialects/pg/lower.ts:215-219 dropRelation
  src/dialects/pg/lower.ts:444-448 createRoutine
  src/dialects/pg/lower.ts:454-458 dropRoutine
function c79cc01ae3cc ~109 minified bytes
  src/runtime/include.ts:563-565 decodeMorph
  src/runtime/include.ts:583-585 decodeRowIncluded
  src/runtime/plan.ts:1441-1443 decodeRow
literal b4a6a8d5aaf6 ~109 minified bytes x4
  src/runtime/observe-emit.ts:382
  src/runtime/observe.ts:208
  src/tooling/errors/examples.ts:655
  src/tooling/errors/registry.ts:979
function 5b9d3eb71f3a ~108 minified bytes
  src/tooling/describe/protocol.ts:460-464 saslInitial
  src/tooling/describe/protocol.ts:472-476 saslFinal
function 7e3a9cc84baa ~108 minified bytes
  src/runtime/topology.ts:730-737 readPrimary
  src/runtime/topology.ts:781-787 readReplica
function 87d1bf625b55 ~108 minified bytes
  src/dialects/pg/ops/lane.ts:484-487 (arrow)
  src/runtime/bucket-group.ts:184-187 writeGrouped
function 90bd0169c390 ~108 minified bytes
  src/tooling/errors/examples.ts:1518-1521 (arrow)
  src/tooling/errors/examples.ts:1537-1540 (arrow)
  src/tooling/errors/examples.ts:1549-1552 (arrow)
  src/tooling/errors/examples.ts:1592-1595 (arrow)
  src/tooling/errors/examples.ts:1604-1607 (arrow)
function 9a4804f22b4c ~108 minified bytes
  src/dialects/pg/ext/feature.ts:49-52 pinAllows
  src/tooling/migrate/ext-surface.ts:278-281 versionAllows
function f689f3e8abd9 ~108 minified bytes
  src/dialects/pg/lower.ts:315-317 addValueStatements
  src/dialects/pg/lower.ts:517-519 alterColumn
function f71f251a45c1 ~108 minified bytes
  src/dialects/pg/view/scratch.ts:197-201 createExtensions
  src/tooling/migrate/pull-emit.ts:975-979 extensionCalls
function 11418fa270e0 ~107 minified bytes
  src/dialects/pg/lower.ts:238-241 createIndex
  src/dialects/pg/lower.ts:254-257 dropIndex
function 12de179aecb5 ~107 minified bytes
  src/tooling/init/command.ts:164-166 packageVersions
  src/tooling/init/engine.ts:878-880 readRecord
function 1d52bed1fcef ~107 minified bytes
  src/runtime/write.ts:1884-1888 shapeObserver
  src/tooling/migrate/import-drizzle.ts:322-326 collect
function 280414025204 ~107 minified bytes
  src/runtime/batch.ts:179-184 recover
  src/runtime/tenancy/composite.ts:388-393 writePredicate
function 2a76f8081f6a ~107 minified bytes
  src/dialects/pg/schema.ts:441-445 schema
  src/tooling/migrate/pull-emit.ts:168-172 emitPull
function 2c88aed82f25 ~107 minified bytes
  src/dialects/pg/introspect.ts:424-427 introspectSchema
  src/runtime/archive.ts:330-333 restoreSql
  src/runtime/include.ts:192-195 emitIncludeJoin
  src/runtime/plan.ts:752-755 emitRead
  src/runtime/safety/index.ts:390-393 safetyProperty
  src/runtime/sync.ts:400-403 manyThrough
  src/runtime/sync.ts:503-506 emitDesired
  src/runtime/tree.ts:188-191 emitTree
  src/runtime/version.ts:283-286 targetStatement
  src/runtime/version.ts:408-411 anyClaimStatement
  src/runtime/write.ts:1008-1011 pathListUpdate
  src/runtime/write.ts:1110-1113 updateSliceBody
  src/runtime/write.ts:1306-1309 rowKey
  src/runtime/write.ts:2061-2064 pathInsert
function 723401e36371 ~107 minified bytes
  src/runtime/plan.ts:1088-1092 emitOr
  src/runtime/write.ts:2064-2068 pathInsert
function 77d4cef1499b ~107 minified bytes
  src/dialects/pg/fn/touch.ts:80-83 updatedColumns
  src/tooling/migrate/plan.ts:234-237 planMigration
function 86810b215422 ~107 minified bytes
  src/tooling/migrate/import-drizzle.ts:326-329 collect
  src/tooling/migrate/pull-emit.ts:166-169 emitPull
function 9e3743df4409 ~107 minified bytes
  src/dialects/pg/errors.ts:110-112 mapPostgresError
  src/dialects/pg/schema.ts:1476-1478 (arrow)
function b03580c1ef08 ~107 minified bytes
  src/runtime/batch.ts:179-183 recover
  src/runtime/sort.ts:442-446 flipStatement
function c7facc838e00 ~107 minified bytes
  src/dialects/pg/schema.ts:754-757 bareTables
  src/runtime/tenancy/rls.ts:313-316 refuseVia
function d9a3073164a8 ~107 minified bytes
  src/runtime/write.ts:1188-1192 lookupStatements
  src/runtime/write.ts:1367-1370 updateList
function da6bcd46a675 ~107 minified bytes
  src/tooling/migrate/drift.ts:195-199 (arrow)
  src/tooling/migrate/pull.ts:239-243 (arrow)
function ee04ac2673a4 ~107 minified bytes
  src/dialects/pg/lower.ts:315-318 addValueStatements
  src/runtime/window.ts:119-122 (arrow)
  src/tooling/describe/scan.ts:189-192 importedRaw
function fd8d8737d445 ~107 minified bytes
  src/runtime/topology.ts:845-848 readProbe
  src/runtime/topology.ts:2174-2177 parseLsn
literal 0479bf78177d ~107 minified bytes x2
  src/tooling/errors/registry.ts:390
  src/tooling/migrate/check.ts:313
function 0253e8f2fe08 ~106 minified bytes
  src/runtime/client.ts:905-907 callOptions
  src/tooling/describe/lock.ts:213-215 (arrow)
  src/tooling/describe/lock.ts:224-226 (arrow)
function 24e81353e6bd ~106 minified bytes
  src/dialects/pg/schema.ts:1588-1593 readPrimaryKey
  src/runtime/window.ts:346-351 readPartition
function 28ddbe3afbc9 ~106 minified bytes
  src/dialects/pg/errors.ts:508-510 fieldKey
  src/tooling/migrate/reference.ts:88-90 referenceInserts
function 3072e5b24c46 ~106 minified bytes
  src/dialects/pg/lower.ts:315-318 addValueStatements
  src/runtime/window.ts:119-122 (arrow)
  src/tooling/describe/scan.ts:141-144 callsInFile
  src/tooling/describe/scan.ts:189-192 importedRaw
  src/tooling/untrusted.ts:146-149 keep
function 5952c7fd3f23 ~106 minified bytes
  src/runtime/validate/engine.ts:92-96 finishUpdate
  src/tooling/describe/scan.ts:140-144 callsInFile
function 72c2caf0a8f5 ~106 minified bytes
  src/runtime/conflict.ts:137-140 lookupExisting
  src/runtime/include.ts:219-222 emitIncludeJoin
function 96d85b3ece84 ~106 minified bytes
  src/runtime/batch.ts:179-183 recover
  src/runtime/sort.ts:358-362 moveStatement
  src/runtime/sort.ts:442-446 flipStatement
  src/runtime/tenancy/composite.ts:388-392 writePredicate
function a27a7c275eae ~106 minified bytes
  src/contracts/catalog/document.ts:1451-1454 parseFunction
  src/dialects/pg/compile.ts:154-157 compileColumn
  src/dialects/pg/schema.ts:523-526 schema
  src/tooling/migrate/plan.ts:773-776 parsePlan
function bf5cc72fd345 ~106 minified bytes
  src/tooling/migrate/sql-lex.ts:193-197 dollarBodies
  src/tooling/migrate/sql-lex.ts:247-251 skipTrivia
function d97a919b87c3 ~106 minified bytes
  src/runtime/conflict.ts:133-138 lookupExisting
  src/runtime/write.ts:1337-1342 insertHead
function f1b4b1c86c4b ~106 minified bytes
  src/dialects/pg/custom.ts:36-39 custom
  src/runtime/safety/index.ts:173-176 (function)
  src/runtime/safety/index.ts:193-196 (function)
  src/runtime/safety/index.ts:223-226 (function)
  src/runtime/safety/index.ts:266-269 (function)
function 285f85fba87c ~105 minified bytes
  src/runtime/sort.ts:202-205 sortable
  src/runtime/write.ts:1595-1598 traitNamed
function 3abc31d3b797 ~105 minified bytes
  src/runtime/topology.ts:608-611 preview
  src/tooling/migrate/sandbox.ts:444-447 runSteps
function 444beef3abbf ~105 minified bytes
  src/dialects/pg/lower.ts:316-318 addValueStatements
  src/runtime/sync.ts:595-597 emitJoinLocked
  src/runtime/tree.ts:255-257 emitStep
  src/runtime/window.ts:120-122 (arrow)
  src/tooling/describe/scan.ts:142-144 callsInFile
  src/tooling/describe/scan.ts:190-192 importedRaw
  src/tooling/untrusted.ts:147-149 keep
function 5d005c2747d5 ~105 minified bytes
  src/runtime/archive.ts:383-387 childUpdate
  src/runtime/archive.ts:403-407 childRestore
function 6a3e1a9e0421 ~105 minified bytes
  src/tooling/migrate/pull-emit.ts:215-217 emitPull
  src/tooling/migrate/pull-emit.ts:1063-1065 typeIsUsed
function 83e86ad4f283 ~105 minified bytes
  src/adapters/pg/pglite.ts:415-419 stampQuery
  src/adapters/pg/session.ts:203-207 stampQuery
function a55b68cd758d ~105 minified bytes
  src/runtime/archive.ts:429-434 primarySql
  src/runtime/sync.ts:784-789 tenantSql
function b245c42eee82 ~105 minified bytes
  src/tooling/migrate/export.ts:573-583 exportFlags
  src/tooling/migrate/import-drizzle.ts:199-209 parseImportArgs
function c84d0b6f5d61 ~105 minified bytes
  src/contracts/error.ts:643-644 fromDriver
  src/dialects/pg/fn/index.ts:443-444 (function)
  src/runtime/client.ts:906-907 callOptions
  src/tooling/describe/lock.ts:214-215 (arrow)
  src/tooling/describe/lock.ts:225-226 (arrow)
function de1a0c0499a3 ~105 minified bytes
  src/runtime/plan.ts:1098-1101 emitOr
  src/runtime/traits/index.ts:487-490 addFields
function e1970e27a880 ~105 minified bytes
  src/runtime/archive.ts:252-256 archiveSql
  src/runtime/archive.ts:304-308 restoreSql
  src/runtime/sort.ts:386-390 moveStatement
literal 26cc11702017 ~105 minified bytes x2
  src/tooling/errors/registry.ts:911
  src/tooling/migrate/baseline.ts:165
function 061009cfc9fa ~104 minified bytes
  src/dialects/pg/lower.ts:315-318 addValueStatements
  src/tooling/describe/scan.ts:189-192 importedRaw
function 1de4f3c711e6 ~104 minified bytes
  src/dialects/pg/schema.ts:1039-1042 uniqueTargets
  src/dialects/pg/schema.ts:1193-1196 compileChecks
function 245ec847a5b0 ~104 minified bytes
  src/runtime/archive.ts:441-444 joinOn
  src/runtime/conflict.ts:136-139 lookupExisting
  src/tooling/untrusted.ts:145-148 keep
function 249d51271b6a ~104 minified bytes
  src/dialects/pg/custom.ts:36-39 custom
  src/runtime/aggregate.ts:217-220 plan
function 28d2052a511b ~104 minified bytes
  src/dialects/pg/schema.ts:524-526 schema
  src/runtime/topology.ts:908-910 openEndpoint
function 2f245197183b ~104 minified bytes
  src/adapters/pg/nodepostgres.ts:159-161 open
  src/runtime/pg/bun.ts:67-69 connect
  src/runtime/pg/neon.ts:79-81 connect
  src/runtime/pg/pg.ts:61-63 connect
function 4be8aceb81c6 ~104 minified bytes
  src/dialects/pg/ops/fragment.ts:128-130 scanLiteral
  src/dialects/pg/table.ts:627-629 snakeCase
function 54a060352955 ~104 minified bytes
  src/runtime/sync.ts:525-529 emitChildMatch
  src/runtime/sync.ts:597-601 emitJoinLocked
  src/runtime/tree.ts:257-261 emitStep
function 5ff7174e474f ~104 minified bytes
  src/tooling/describe/lock.ts:173-177 renderRawTypes
  src/tooling/describe/sync.ts:97-101 buildRawLock
function 678191c6353b ~104 minified bytes
  src/dialects/pg/introspect.ts:256-261 introspectSchema
  src/tooling/migrate/import-drizzle.ts:536-541 catalogOf
function 70c62552919d ~104 minified bytes
  src/tooling/errors/examples.ts:1407-1410 (arrow)
  src/tooling/errors/examples.ts:1412-1415 (arrow)
function 961bb5684082 ~104 minified bytes
  src/runtime/safety/index.ts:389-393 safetyProperty
  src/runtime/sync.ts:485-489 emitSelectLocked
  src/runtime/sync.ts:522-526 emitChildMatch
  src/runtime/sync.ts:540-544 emitSetCase
  src/runtime/sync.ts:581-585 emitDistinct
  src/runtime/tree.ts:222-226 emitKeyList
function b22663b84ad0 ~104 minified bytes
  src/runtime/include.ts:116-118 emitIncludeSelect
  src/runtime/sync.ts:245-247 oneToMany
  src/runtime/write.ts:1888-1890 shapeObserver
  src/tooling/migrate/runner.ts:129-131 runTarget
function 044d49606c4b ~103 minified bytes
  src/tooling/migrate/pg-probe.ts:698-701 readIdent
  src/tooling/migrate/pg-probe.ts:740-743 readLiteral
function 1b4cdcd7705a ~103 minified bytes
  src/dialects/pg/lower.ts:523-526 alterColumn
  src/tooling/migrate/plan.ts:1947-1950 pushSafe
function 307e027eacc4 ~103 minified bytes
  src/runtime/conflict.ts:137-140 lookupExisting
  src/runtime/validate/engine.ts:93-96 finishUpdate
  src/tooling/untrusted.ts:146-149 keep
function 48a276bc7c95 ~103 minified bytes
  src/tooling/migrate/lint-rules.ts:763-765 unsafeSetNotNull
  src/tooling/migrate/lint-rules.ts:832-834 notNullFloorValidate
  src/tooling/migrate/lint-rules.ts:856-858 ownColumnCheckValidate
function 797991105b69 ~103 minified bytes
  src/tooling/cli/parse.ts:289-293 commandWords
  src/tooling/migrate/pull.ts:116-120 parsePullArgs
function 86549603c098 ~103 minified bytes
  src/runtime/sync.ts:277-281 oneToMany
  src/runtime/tree.ts:163-167 emitTree
function 99a56d3cb641 ~103 minified bytes
  src/runtime/warnings/evaluate.ts:119-123 walk
  src/runtime/write.ts:2714-2718 collectSecrets
function a1239170b247 ~103 minified bytes
  src/dialects/pg/lower.ts:315-318 addValueStatements
  src/tooling/describe/scan.ts:141-144 callsInFile
function ac799c516138 ~103 minified bytes
  src/tooling/migrate/pg-probe.ts:477-480 parseAddConstraint
  src/tooling/migrate/pg-probe.ts:688-691 readQualified
function c83f6d991a42 ~103 minified bytes
  src/contracts/error.ts:642-644 fromDriver
  src/dialects/pg/fn/index.ts:442-444 (function)
function d30a5847fd3f ~103 minified bytes
  src/runtime/sort.ts:528-531 tenantColumns
  src/runtime/sync.ts:783-786 tenantSql
function e1f3bc7c0bc5 ~103 minified bytes
  src/tooling/github/post-comment.ts:92-95 listComments
  src/tooling/migrate/check.ts:139-142 checkMigrations
function e7124b4f9edf ~103 minified bytes
  src/runtime/tenancy/composite.ts:397-401 writePredicate
  src/runtime/tenancy/index.ts:400-404 writePredicate
function eaadcaf87610 ~103 minified bytes
  src/contracts/catalog/order.ts:102-106 orderIndexed
  src/tooling/migrate/safe.ts:270-274 functionCalls
function 017fb3e181bd ~102 minified bytes
  src/tooling/migrate/drift.ts:173-176 tableColumns
  src/tooling/testing/facts.ts:202-205 foreignKeys
function 02af0cfa56d3 ~102 minified bytes
  src/contracts/error.ts:643-645 fromDriver
  src/runtime/client.ts:906-908 callOptions
function 313225efa031 ~102 minified bytes
  src/runtime/archive.ts:442-444 joinOn
  src/runtime/conflict.ts:137-139 lookupExisting
  src/tooling/cli/parse.ts:290-292 commandWords
  src/tooling/migrate/pull.ts:117-119 parsePullArgs
  src/tooling/untrusted.ts:146-148 keep
function 3770f06229a5 ~102 minified bytes
  src/tooling/errors/examples.ts:1245-1250 (arrow)
  src/tooling/errors/examples.ts:1526-1531 (arrow)
function 40f998bd5bae ~102 minified bytes
  src/dialects/pg/view/index.ts:487-490 renderQuery
  src/tooling/migrate/sandbox.ts:575-578 prepareCheckSql
function 602c3f638bc2 ~102 minified bytes
  src/tooling/migrate/apply.ts:1000-1004 readHistory
  src/tooling/migrate/status.ts:406-410 readHistory
  src/tooling/migrate/status.ts:432-436 readBackfills
  src/tooling/migrate/status.ts:463-467 readSteps
function 6d0d4d5d0b8e ~102 minified bytes
  src/runtime/include.ts:347-350 readIncludes
  src/runtime/write.ts:1675-1678 insertRow
  src/runtime/write.ts:2105-2108 writeSet
function 71616e87ad57 ~102 minified bytes
  src/dialects/pg/lower.ts:316-318 addValueStatements
  src/runtime/sync.ts:595-597 emitJoinLocked
  src/tooling/describe/scan.ts:142-144 callsInFile
  src/tooling/describe/scan.ts:190-192 importedRaw
function f6aa27e14fde ~102 minified bytes
  src/dialects/pg/schema.ts:624-628 rewritePass
  src/dialects/pg/schema.ts:693-697 collectHooks
  src/dialects/pg/view/client.ts:290-294 readsTenant
literal 4b1078bc4d9b ~102 minified bytes x3
  src/tooling/migrate/apply.ts:759
  src/tooling/migrate/apply.ts:1055
  src/tooling/migrate/baseline.ts:200
function 0a15bd2c0b8f ~101 minified bytes
  src/runtime/conflict.ts:189-193 uniqueColumns
  src/runtime/sort.ts:527-531 tenantColumns
function 337cdb5868fe ~101 minified bytes
  src/runtime/tenancy/composite.ts:546-549 readKeys
  src/runtime/traits/index.ts:432-435 readCascade
function 6407ae71b907 ~101 minified bytes
  src/tooling/describe/lock.ts:52-54 renderLock
  src/tooling/migrate/policy.ts:374-376 listTargets
function 65a6eee08e23 ~101 minified bytes
  src/dialects/pg/custom.ts:36-39 custom
  src/runtime/page.ts:128-131 plan
function 74fe51fc54aa ~101 minified bytes
  src/adapters/pg/postgresjs.ts:367-371 (function)
  src/adapters/pg/session.ts:108-112 (function)
function 807aebefe648 ~101 minified bytes
  src/runtime/lock.ts:85-94 plan
  src/runtime/tree.ts:111-120 open
function cbb855be785a ~101 minified bytes
  src/tooling/describe/protocol.ts:449-455 passwordMessage
  src/tooling/describe/protocol.ts:472-478 saslFinal
function 1f493a751dd5 ~100 minified bytes
  src/runtime/write.ts:1343-1347 insertHead
  src/runtime/write.ts:2069-2073 pathInsert
function 41f01efb9d2d ~100 minified bytes
  src/dialects/pg/schema.ts:1458-1461 tableModel
  src/runtime/archive.ts:429-432 primarySql
function 480101d7859e ~100 minified bytes
  src/runtime/traits/index.ts:486-490 addFields
  src/tooling/testing/factories.ts:210-214 insertPrepared
function 7a797e0f8379 ~100 minified bytes
  src/runtime/include.ts:691-695 walkOperators
  src/runtime/plan.ts:411-415 orderHasRelevance
function 7e3ae010ee5a ~100 minified bytes
  src/runtime/pg/neon.ts:83-86 connect
  src/runtime/pg/pglite.ts:59-62 connect
function 85bcae8d6bf3 ~100 minified bytes
  src/dialects/pg/schema.ts:1546-1548 (arrow)
  src/dialects/pg/schema.ts:1552-1554 (arrow)
function 89da6f8306f6 ~100 minified bytes
  src/tooling/errors/examples.ts:1064-1070 (arrow)
  src/tooling/errors/examples.ts:1077-1080 (arrow)
function addac85c9cec ~100 minified bytes
  src/tooling/describe/protocol.ts:437-441 simpleQuery
  src/tooling/describe/protocol.ts:447-451 passwordMessage
function 25199e35cfe0 ~99 minified bytes
  src/runtime/version.ts:417-420 anyClaimStatement
  src/runtime/write.ts:1414-1417 emitClaim
function 9375dc817814 ~99 minified bytes
  src/contracts/catalog/enum.ts:143-148 sameEnumLabels
  src/runtime/conflict.ts:311-316 same
function b08397677c06 ~99 minified bytes
  src/runtime/tenancy/composite.ts:256-258 rewriteTenant
  src/runtime/tenancy/index.ts:273-275 rewriteTenant
  src/runtime/tenancy/path.ts:215-217 localOf
literal 0c2a1cb8ed1f ~99 minified bytes x2
  src/tooling/errors/examples.ts:1399
  src/tooling/errors/examples.ts:1438
function 22f799329cbb ~98 minified bytes
  src/runtime/batch.ts:114-118 run
  src/runtime/batch.ts:158-162 recover
  src/tooling/migrate/status.ts:320-324 formatStatus
function 4cf71448dea5 ~98 minified bytes
  src/dialects/pg/view/scratch.ts:271-275 reprintAtomicBodies
  src/tooling/describe/types.ts:98-102 loadLabels
  src/tooling/migrate/policy.ts:241-245 assertTargetAlias
function b3177e647956 ~98 minified bytes
  src/runtime/aggregate.ts:386-389 (arrow)
  src/runtime/archive.ts:323-326 restoreSql
  src/runtime/plan.ts:736-739 emitRead
function e497d9af4287 ~98 minified bytes
  src/dialects/pg/archive-bind.ts:170-174 childLinks
  src/tooling/migrate/requirements.ts:161-165 unique
function e95072b5e47c ~98 minified bytes
  src/dialects/pg/view/scratch.ts:272-275 reprintAtomicBodies
  src/tooling/describe/types.ts:99-102 loadLabels
  src/tooling/migrate/policy.ts:242-245 assertTargetAlias
  src/tooling/migrate/requirements.ts:156-159 pushReason
literal edc63e81373e ~98 minified bytes x4
  src/runtime/observe-emit.ts:377
  src/runtime/observe.ts:203
  src/tooling/errors/examples.ts:650
  src/tooling/errors/registry.ts:978
function 0146f7b878e2 ~97 minified bytes
  src/runtime/include.ts:668-674 emitIncludeOrder
  src/runtime/plan.ts:1203-1209 emitPrimaryOrder
function 08e6c483a40d ~97 minified bytes
  src/tooling/errors/examples.ts:717-722 (arrow)
  src/tooling/errors/examples.ts:735-740 (arrow)
  src/tooling/errors/examples.ts:770-775 (arrow)
function 0b4e25a4ff43 ~97 minified bytes
  src/dialects/pg/trait.ts:210-212 contributedFields
  src/tooling/migrate/reference.ts:146-148 rowOf
function 10c5fd50455d ~97 minified bytes
  src/dialects/pg/schema.ts:1251-1254 compileForeignKeys
  src/runtime/validate/engine.ts:92-95 finishUpdate
  src/runtime/validate/engine.ts:120-123 finish
function 2a25f364b7a1 ~97 minified bytes
  src/runtime/sync.ts:472-476 parentLock
  src/runtime/tree.ts:171-175 emitTree
function 2b852ed4ea12 ~97 minified bytes
  src/tooling/migrate/drift.ts:47-54 assertAuthorDrift
  src/tooling/migrate/export.ts:278-285 assertLiveExternal
function 2ecc424f3433 ~97 minified bytes
  src/dialects/pg/schema.ts:1252-1255 compileForeignKeys
  src/runtime/archive.ts:442-445 joinOn
  src/runtime/batch.ts:64-67 batch
function 3704cc517c56 ~97 minified bytes
  src/tooling/testing/record.ts:75-78 (function)
  src/tooling/testing/record.ts:92-95 (function)
function 4b8a69f9d8d7 ~97 minified bytes
  src/runtime/tx.ts:151-153 noteWrites
  src/tooling/describe/lock.ts:225-227 (arrow)
literal e1038edb2a63 ~97 minified bytes x2
  src/tooling/migrate/runner.ts:695
  src/tooling/migrate/step-journal.ts:102
function 1eb7345cb258 ~96 minified bytes
  src/tooling/migrate/export.ts:279-285 assertLiveExternal
  src/tooling/migrate/sandbox.ts:380-386 dropScratch
function 226cdf58cfc1 ~96 minified bytes
  src/tooling/migrate/lint-rules.ts:445-449 sqlWords
  src/tooling/migrate/plan.ts:1590-1594 parseInList
function 46fb2f46ec42 ~96 minified bytes
  src/tooling/migrate/sandbox.ts:509-512 tolerateInstalledExtensions
  src/tooling/migrate/sandbox.ts:572-575 prepareCheckSql
function 4a10270a2ac9 ~96 minified bytes
  src/dialects/pg/archive-bind.ts:207-214 childLinks
  src/dialects/pg/archive-bind.ts:233-240 parentLinks
function 7cd1962f201f ~96 minified bytes
  src/dialects/pg/errors.ts:580-584 splitList
  src/tooling/migrate/pg-probe.ts:587-591 simpleColumns
function cd775a100719 ~96 minified bytes
  src/dialects/pg/introspect.ts:1267-1271 unwrapTriggerWhen
  src/runtime/plan.ts:750-754 emitRead
  src/runtime/tree.ts:186-190 emitTree
  src/tooling/migrate/lint-rules.ts:590-594 unwrap
  src/tooling/migrate/pg-probe.ts:629-633 splitCommas
function d2b40a32f225 ~96 minified bytes
  src/runtime/client.ts:223-228 openClient
  src/runtime/client.ts:313-318 tableApi
function db9264d03da7 ~96 minified bytes
  src/dialects/pg/emit.ts:109-112 readGeneric
  src/tooling/describe/scan.ts:286-289 splitArgs
function e26d8fd42dda ~96 minified bytes
  src/runtime/include.ts:219-222 emitIncludeJoin
  src/tooling/describe/scan.ts:141-144 callsInFile
  src/tooling/untrusted.ts:146-149 keep
function 6989b17445dd ~95 minified bytes
  src/dialects/pg/morph.ts:234-238 (arrow)
  src/runtime/plan.ts:440-444 emitRelationFrom
function 6a7c2d1f3dd9 ~95 minified bytes
  src/tooling/migrate/pg-probe.ts:631-634 splitCommas
  src/tooling/migrate/pg-probe.ts:722-725 readParen
function 834a7a884a2d ~95 minified bytes
  src/runtime/include.ts:293-296 emitNestedAggregate
  src/runtime/plan.ts:753-756 emitRead
  src/runtime/sync.ts:401-404 manyThrough
  src/runtime/sync.ts:542-545 emitSetCase
  src/runtime/tree.ts:189-192 emitTree
  src/runtime/write.ts:1111-1114 updateSliceBody
function 9f31e6115708 ~95 minified bytes
  src/runtime/tx.ts:151-153 noteWrites
  src/tooling/describe/lock.ts:214-216 (arrow)
function d62fedadd068 ~95 minified bytes
  src/runtime/plan.ts:751-754 emitRead
  src/runtime/tree.ts:187-190 emitTree
  src/tooling/migrate/pg-probe.ts:573-576 wrapped
function f063dfddf34e ~95 minified bytes
  src/runtime/write.ts:736-740 planUpdate
  src/runtime/write.ts:981-985 pathSetUpdate
  src/runtime/write.ts:2245-2249 treeSetUpdate
literal f73d1107987d ~95 minified bytes x2
  src/runtime/tenancy/rls.ts:182
  src/runtime/tenancy/rls.ts:198
function 7b099fd0215c ~94 minified bytes
  src/tooling/migrate/export.ts:279-286 assertLiveExternal
  src/tooling/migrate/pull.ts:69-76 pullProject
function 7c50d9f28c9f ~94 minified bytes
  src/dialects/pg/lower.ts:315-318 addValueStatements
  src/dialects/pg/ops/lane.ts:484-487 (arrow)
  src/runtime/bucket-group.ts:184-187 writeGrouped
function a82f60fd2ca2 ~94 minified bytes
  src/tooling/describe/protocol.ts:449-453 passwordMessage
  src/tooling/describe/protocol.ts:460-464 saslInitial
function b9d47cfa696f ~94 minified bytes
  src/runtime/write.ts:890-892 finishVersioned
  src/runtime/write.ts:1150-1152 decodePlanned
function ee8f06671a49 ~94 minified bytes
  src/contracts/catalog/order.ts:101-105 orderIndexed
  src/tooling/migrate/plan.ts:1589-1593 parseInList
function 09a84b1a9d09 ~93 minified bytes
  src/contracts/catalog/identity.ts:172-175 isPlainJsonText
  src/contracts/catalog/json.ts:68-71 encodeString
function 2ac12c6b9519 ~93 minified bytes
  src/tooling/describe/lock.ts:173-176 renderRawTypes
  src/tooling/migrate/plan.ts:917-920 pairSameShape
function 2f28e4fd19d4 ~93 minified bytes
  src/tooling/migrate/lint-rules.ts:444-448 sqlWords
  src/tooling/migrate/safe.ts:269-273 functionCalls
function 41b54583735a ~93 minified bytes
  src/adapters/pg/bunsql-extra.ts:94-96 readStatement
  src/runtime/topology.ts:1407-1409 classOf
function 7260d5258d21 ~93 minified bytes
  src/tooling/migrate/sandbox.ts:237-243 inCheckTransaction
  src/tooling/migrate/sandbox.ts:379-385 dropScratch
function 82b444a70456 ~93 minified bytes
  src/dialects/pg/column.ts:659-661 (function)
  src/dialects/pg/ext/index.ts:137-139 extension
  src/dialects/pg/schema.ts:523-525 schema
function cacfec837e30 ~93 minified bytes
  src/tooling/migrate/lint-rules.ts:718-721 requiredColumn
  src/tooling/migrate/lint-rules.ts:939-941 validates
function fe33d6f203ed ~93 minified bytes
  src/dialects/pg/through.ts:26-28 (arrow)
  src/runtime/include.ts:228-230 emitIncludeJoin
  src/runtime/include.ts:291-293 emitNestedAggregate
  src/runtime/include.ts:502-504 emitMorphJoin
  src/runtime/window.ts:214-216 emitWindow
  src/tooling/testing/factories.ts:387-389 assignForeign
function 5ff8318c5c8d ~92 minified bytes
  src/tooling/migrate/drift.ts:48-53 assertAuthorDrift
  src/tooling/migrate/export.ts:279-284 assertLiveExternal
  src/tooling/migrate/sandbox.ts:238-243 inCheckTransaction
function 80944d7d1870 ~92 minified bytes
  src/runtime/tenancy/via.ts:125-130 (arrow)
  src/tooling/describe/provider.ts:55-60 (arrow)
  src/tooling/init/engine.ts:671-676 (arrow)
function ad78fce56ef5 ~92 minified bytes
  src/tooling/testing/record.ts:79-82 (function)
  src/tooling/testing/record.ts:96-99 (function)
function b0dd54d5a509 ~92 minified bytes
  src/tooling/migrate/sql-lex.ts:87-92 scan
  src/tooling/migrate/sql-lex.ts:407-412 sqlIdentifiers
function bb2e2e880846 ~92 minified bytes
  src/dialects/pg/view/index.ts:260-268 (function)
  src/dialects/pg/view/index.ts:427-435 (function)
function c9c255ac0391 ~92 minified bytes
  src/runtime/validate/engine.ts:594-597 findColumn
  src/runtime/warnings/evaluate.ts:176-179 relationOf
function d1b093052d70 ~92 minified bytes
  src/dialects/pg/ops/fragment.ts:128-130 scanLiteral
  src/tooling/init/paths.ts:53-55 resolveInside
function 3182bf9b677f ~91 minified bytes
  src/dialects/pg/morph.ts:237-241 (arrow)
  src/runtime/include.ts:527-531 emitMorphJoin
  src/runtime/plan.ts:808-812 holdArchive
function 331940870260 ~91 minified bytes
  src/dialects/pg/range.ts:138-141 splitBound
  src/runtime/write.ts:1020-1023 pathListUpdate
function 6205568b8008 ~91 minified bytes
  src/dialects/pg/schema.ts:1507-1511 resolveRelations
  src/runtime/sync.ts:708-712 readIds
function 89ca8c0e922b ~91 minified bytes
  src/runtime/safety/index.ts:389-392 safetyProperty
  src/runtime/sync.ts:485-488 emitSelectLocked
  src/runtime/sync.ts:540-543 emitSetCase
  src/runtime/sync.ts:581-584 emitDistinct
  src/runtime/sync.ts:594-597 emitJoinLocked
  src/runtime/tree.ts:222-225 emitKeyList
  src/runtime/tree.ts:254-257 emitStep
function b9747fa9b843 ~91 minified bytes
  src/tooling/describe/scan.ts:417-422 skipJsxElement
  src/tooling/describe/scan.ts:434-439 skipJsxChildren
function c0326b9aaa5a ~91 minified bytes
  src/tooling/errors/examples.ts:688-690 (arrow)
  src/tooling/errors/examples.ts:705-709 (arrow)
literal 73202956223a ~91 minified bytes x2
  src/dialects/pg/role/check.ts:177
  src/tooling/errors/registry.ts:810
function 05f8bd3b5937 ~90 minified bytes
  src/dialects/ddl-step.ts:97-102 readIdent
  src/tooling/migrate/pg-probe.ts:699-704 readIdent
function 3b1d40fd9379 ~90 minified bytes
  src/tooling/testing/factories.ts:322-326 asScope
  src/tooling/testing/isolation.ts:252-256 scopeFor
function 5965e2ceea23 ~90 minified bytes
  src/tooling/describe/scan.ts:588-590 walk
  src/tooling/migrate/project.ts:818-820 directoryImportsValidate
function 8e163609f91e ~90 minified bytes
  src/tooling/errors/examples.ts:449-451 (arrow)
  src/tooling/errors/examples.ts:454-456 (arrow)
function 9db9e5c9aff7 ~90 minified bytes
  src/runtime/archive.ts:254-258 archiveSql
  src/runtime/archive.ts:385-389 childUpdate
function f3ac49e734d1 ~90 minified bytes
  src/tooling/errors/examples.ts:698-701 (arrow)
  src/tooling/errors/examples.ts:707-710 (arrow)
function fe738813ba4b ~90 minified bytes
  src/tooling/migrate/sql-lex.ts:331-340 takeQuoted
  src/tooling/migrate/sql-lex.ts:345-354 takeIdent
literal 2934de61e212 ~90 minified bytes x2
  src/dialects/pg/ops/fragment.ts:165
  src/dialects/pg/ops/fragment.ts:283
literal f25385e2580e ~90 minified bytes x2
  src/tooling/migrate/lost.ts:14
  src/tooling/migrate/sandbox.ts:336
function 28f5c5e8d4e8 ~89 minified bytes
  src/runtime/validate/engine.ts:120-123 finish
  src/tooling/describe/scan.ts:140-143 callsInFile
function 43600f679730 ~89 minified bytes
  src/dialects/pg/lower.ts:319-322 addValueStatements
  src/tooling/migrate/pg-probe.ts:698-701 readIdent
  src/tooling/migrate/pg-probe.ts:740-743 readLiteral
function b51e74868a83 ~89 minified bytes
  src/dialects/pg/column.ts:523-528 (function)
  src/dialects/pg/enum.ts:41-46 enumColumn
function cb7622bac8a1 ~89 minified bytes
  src/runtime/archive.ts:306-310 restoreSql
  src/runtime/archive.ts:405-409 childRestore
function f436c5af57d7 ~89 minified bytes
  src/tooling/errors/examples.ts:724-726 (arrow)
  src/tooling/errors/examples.ts:745-747 (arrow)
  src/tooling/errors/examples.ts:780-782 (arrow)
literal 050a664b30ed ~89 minified bytes x2
  src/tooling/errors/examples.ts:1394
  src/tooling/errors/examples.ts:1433
literal 0ee31aab661c ~89 minified bytes x3
  src/runtime/lock.ts:60
  src/runtime/topology.ts:2272
  src/runtime/transaction.ts:553
literal 25485e096e87 ~89 minified bytes x2
  src/tooling/errors/registry.ts:879
  src/tooling/migrate/policy.ts:256
function 21f5850fda43 ~88 minified bytes
  src/runtime/conflict.ts:136-139 lookupExisting
  src/runtime/validate/engine.ts:142-145 issuesOf
function 75910d8b8b4d ~88 minified bytes
  src/dialects/pg/schema.ts:1252-1254 compileForeignKeys
  src/runtime/archive.ts:442-444 joinOn
  src/runtime/batch.ts:148-150 recover
function 8b77414c02bb ~88 minified bytes
  src/dialects/pg/geometry.ts:120 pointText
  src/dialects/pg/geometry.ts:126 lineText
literal 7cde9c33bb04 ~88 minified bytes x2
  src/dialects/pg/fn/index.ts:206
  src/tooling/errors/registry.ts:804
literal a77d945ed3ad ~88 minified bytes x2
  src/tooling/migrate/baseline.ts:401
  src/tooling/migrate/status.ts:238
function 6d2c3ab7765f ~87 minified bytes
  src/runtime/validate/engine.ts:120-123 finish
  src/tooling/cli/parse.ts:289-292 commandWords
  src/tooling/migrate/pull.ts:116-119 parsePullArgs
function 6e462b093c9f ~87 minified bytes
  src/runtime/archive.ts:441-444 joinOn
  src/runtime/validate/engine.ts:142-145 issuesOf
  src/tooling/untrusted.ts:145-148 keep
function 5f0fa877cd2b ~86 minified bytes
  src/contracts/catalog/identity.ts:171-174 isPlainJsonText
  src/dialects/pg/operator-fit.ts:153-156 assertNoControl
function 7331586621f4 ~86 minified bytes
  src/dialects/pg/table.ts:626-629 snakeCase
  src/tooling/init/paths.ts:52-55 resolveInside
function b5f9bb5f03c5 ~86 minified bytes
  src/contracts/catalog/enum.ts:142-144 sameEnumLabels
  src/runtime/safety/index.ts:437-439 sameViolations
function e57a2b184461 ~86 minified bytes
  src/runtime/batch.ts:148-151 recover
  src/runtime/conflict.ts:137-140 lookupExisting
  src/tooling/describe/scan.ts:141-144 callsInFile
  src/tooling/untrusted.ts:146-149 keep
literal 89d1a41cbe91 ~86 minified bytes x2
  src/tooling/errors/registry.ts:834
  src/tooling/migrate/export.ts:449
literal c6231c4a316d ~86 minified bytes x2
  src/runtime/topology.ts:2291
  src/tooling/errors/registry.ts:847
function 07a10a51ee01 ~85 minified bytes
  src/runtime/include.ts:537-541 emitMorphJoin
  src/runtime/plan.ts:797-801 emitJoin
function 42ff79390699 ~85 minified bytes
  src/dialects/pg/column.ts:659-663 (function)
  src/tooling/migrate/import-drizzle.ts:537-541 catalogOf
function 540eb0fef3b0 ~85 minified bytes
  src/contracts/catalog/document.ts:1860-1864 parseReferences
  src/runtime/client.ts:907-911 callOptions
function 7941fc2b5c25 ~85 minified bytes
  src/dialects/pg/role/index.ts:511 (arrow)
  src/dialects/pg/role/index.ts:534 (arrow)
literal 3b9687a09dfe ~85 minified bytes x2
  src/tooling/errors/registry.ts:396
  src/tooling/migrate/apply.ts:939
function 02f992e7525e ~84 minified bytes
  src/tooling/cli/parse.ts:90-93 argvHasJson
  src/tooling/cli/parse.ts:321-324 consumesNext
function 10f857747462 ~84 minified bytes
  src/dialects/pg/morph.ts:247-252 (arrow)
  src/runtime/plan.ts:797-802 emitJoin
function 27b962fc6056 ~84 minified bytes
  src/dialects/pg/morph.ts:239-243 (arrow)
  src/runtime/archive.ts:256-260 archiveSql
  src/runtime/include.ts:536-540 emitMorphJoin
function 608b66e867e1 ~84 minified bytes
  src/runtime/page.ts:200-203 (arrow)
  src/runtime/write.ts:1019-1022 pathListUpdate
function 9d4df3cec79e ~84 minified bytes
  src/dialects/pg/column.ts:659-663 (function)
  src/dialects/pg/introspect.ts:257-261 introspectSchema
function a2eaa8d5822c ~84 minified bytes
  src/dialects/pg/geometry.ts:95-98 decodeLine
  src/tooling/migrate/backfill.ts:118-121 parseBackfillHeader
function d228c3742740 ~84 minified bytes
  src/contracts/catalog/document.ts:1860-1863 parseReferences
  src/runtime/client.ts:907-910 callOptions
  src/runtime/page.ts:140-143 plan
function db687272cad1 ~84 minified bytes
  src/adapters/pg/postgresjs.ts:374-378 (arrow)
  src/adapters/pg/session.ts:115-119 (arrow)
function ff7f2b8b1caa ~84 minified bytes
  src/tooling/cli/outcome.ts:85-88 tagOutcome
  src/tooling/cli/outcome.ts:168-171 attachPartial
  src/tooling/errors/shape.ts:96-99 attachCliDetail
literal d37b6c15ad59 ~84 minified bytes x3
  src/tooling/errors/registry.ts:923
  src/tooling/migrate/policy.ts:94
  src/tooling/migrate/protect.ts:37
function 5e2eda32b61b ~83 minified bytes
  src/runtime/plan.ts:1426-1429 literalPattern
  src/tooling/cli/parse.ts:290-293 commandWords
  src/tooling/cli/parse.ts:321-324 consumesNext
  src/tooling/migrate/export.ts:562-565 exportFlags
  src/tooling/migrate/import-drizzle.ts:192-195 parseImportArgs
  src/tooling/migrate/pull.ts:117-120 parsePullArgs
function 7adedba9117a ~83 minified bytes
  src/tooling/cli/parse.ts:90-93 argvHasJson
  src/tooling/cli/parse.ts:290-293 commandWords
function 7fc2fbd62712 ~83 minified bytes
  src/runtime/plan.ts:808-812 holdArchive
  src/runtime/plan.ts:1186-1190 emitOrder
function 8e90417b2c1b ~83 minified bytes
  src/dialects/pg/archive-bind.ts:170-174 childLinks
  src/tooling/describe/types.ts:182-186 uniqueOids
  src/tooling/migrate/requirements.ts:161-165 unique
literal 1753d9411631 ~83 minified bytes x2
  src/dialects/pg/view/client.ts:123
  src/tooling/errors/registry.ts:779
function 23a193295863 ~82 minified bytes
  src/tooling/testing/isolation.ts:112-114 checkTable
  src/tooling/testing/isolation.ts:355-357 checkPath
function 8cb8cd9476bd ~82 minified bytes
  src/dialects/pg/ext/feature.ts:49-51 pinAllows
  src/tooling/migrate/ext-surface.ts:278-280 versionAllows
  src/tooling/migrate/ext.ts:139-141 extensionNeeds
function 907a19a65e28 ~82 minified bytes
  src/dialects/pg/morph.ts:237-241 (arrow)
  src/runtime/include.ts:527-531 emitMorphJoin
  src/runtime/include.ts:668-672 emitIncludeOrder
  src/runtime/plan.ts:808-812 holdArchive
  src/runtime/plan.ts:1186-1190 emitOrder
  src/runtime/plan.ts:1203-1207 emitPrimaryOrder
  src/runtime/sync.ts:526-530 emitChildMatch
  src/runtime/sync.ts:546-550 emitSetCase
  src/runtime/sync.ts:564-568 emitWillChange
  src/runtime/sync.ts:585-589 emitDistinct
  src/runtime/sync.ts:598-602 emitJoinLocked
function a6c4540f9470 ~82 minified bytes
  src/runtime/sync.ts:146 (arrow)
  src/runtime/sync.ts:149 (arrow)
function a9fea3865be4 ~82 minified bytes
  src/runtime/plan.ts:1426-1429 literalPattern
  src/tooling/cli/parse.ts:90-93 argvHasJson
  src/tooling/cli/parse.ts:290-293 commandWords
  src/tooling/migrate/export.ts:562-565 exportFlags
  src/tooling/migrate/import-drizzle.ts:192-195 parseImportArgs
  src/tooling/migrate/pull.ts:117-120 parsePullArgs
function cd376a5a73fa ~82 minified bytes
  src/dialects/pg/table.ts:625-628 snakeCase
  src/runtime/plan.ts:1425-1428 literalPattern
function de1e46495cc7 ~82 minified bytes
  src/runtime/batch.ts:148-151 recover
  src/runtime/validate/engine.ts:93-96 finishUpdate
function e52dca0c7035 ~82 minified bytes
  src/tooling/errors/examples.ts:634-637 (arrow)
  src/tooling/errors/examples.ts:639-642 (arrow)
literal 8f0ff27f9d2a ~82 minified bytes x2
  src/tooling/errors/examples.ts:1385
  src/tooling/errors/examples.ts:1424
function 7b130f5f086f ~81 minified bytes
  src/tooling/describe/types.ts:184-186 uniqueOids
  src/tooling/describe/types.ts:194-196 oidList
function cb7f9360ce93 ~81 minified bytes
  src/runtime/tenancy/rls.ts:927-929 isWriteSql
  src/runtime/tenancy/rls.ts:935-937 isReadSql
function d7465875f5fb ~80 minified bytes
  src/runtime/tenancy/rls.ts:927-929 isWriteSql
  src/runtime/tenancy/rls.ts:935-937 isReadSql
  src/runtime/topology.ts:1399-1401 classOf
function 12424cee1222 ~79 minified bytes
  src/dialects/pg/introspect.ts:377-381 introspectSchema
  src/tooling/migrate/ext-surface.ts:354-358 visibleOperator
function 46a1b12c3de0 ~79 minified bytes
  src/tooling/errors/examples.ts:882 (arrow)
  src/tooling/errors/examples.ts:886 (arrow)
  src/tooling/errors/examples.ts:898 (arrow)
  src/tooling/errors/examples.ts:906 (arrow)
  src/tooling/errors/examples.ts:910 (arrow)
  src/tooling/errors/examples.ts:1361 (arrow)
  src/tooling/errors/examples.ts:1371 (arrow)
function fbc25fe755eb ~78 minified bytes
  src/tooling/errors/examples.ts:1216-1219 (arrow)
  src/tooling/errors/examples.ts:1221-1224 (arrow)
function 2638510e1a83 ~77 minified bytes
  src/tooling/errors/examples.ts:982-986 (arrow)
  src/tooling/errors/examples.ts:990-994 (arrow)
  src/tooling/errors/examples.ts:1002-1006 (arrow)
  src/tooling/errors/examples.ts:1010-1014 (arrow)
function 3b53d0d5d4d8 ~77 minified bytes
  src/dialects/pg/emit.ts:42-45 emitRowTypes
  src/tooling/migrate/import-drizzle.ts:322-325 collect
function b23af94e6a3b ~77 minified bytes
  src/tooling/migrate/status.ts:466-469 readSteps
  src/tooling/migrate/step-journal.ts:42-45 readMarker
function 54ac9f38ee27 ~76 minified bytes
  src/dialects/pg/errors.ts:108-110 mapPostgresError
  src/runtime/write.ts:616-618 planInsert
function 04909e1020a1 ~75 minified bytes
  src/contracts/catalog/routine.ts:204-206 triggerObject
  src/tooling/migrate/plan-json.ts:105-107 (arrow)
function 1dae74e138a0 ~75 minified bytes
  src/runtime/archive-handle.ts:95-97 (function)
  src/runtime/archive-handle.ts:98-100 (function)
  src/runtime/client.ts:427-429 (function)
  src/runtime/client.ts:430-432 (function)
function 00496d2f5856 ~73 minified bytes
  src/tooling/errors/examples.ts:298-300 (arrow)
  src/tooling/errors/examples.ts:1539-1541 (arrow)
  src/tooling/errors/examples.ts:1551-1553 (arrow)
  src/tooling/errors/examples.ts:1567-1569 (arrow)
  src/tooling/errors/examples.ts:1580-1582 (arrow)
  src/tooling/errors/examples.ts:1594-1596 (arrow)
  src/tooling/errors/examples.ts:1606-1608 (arrow)
function a33bf881f3f1 ~72 minified bytes
  src/tooling/migrate/lint-rules.ts:833-834 notNullFloorValidate
  src/tooling/migrate/lint-rules.ts:857-858 ownColumnCheckValidate
  src/tooling/migrate/lint-rules.ts:898-899 (arrow)
function 139c4ea59363 ~71 minified bytes
  src/tooling/migrate/lint-rules.ts:917-918 widenValidate
  src/tooling/migrate/lint-rules.ts:940-941 validates
function 85362357485e ~71 minified bytes
  src/dialects/pg/ext/feature.ts:50-51 pinAllows
  src/tooling/migrate/ext-surface.ts:279-280 versionAllows
  src/tooling/migrate/ext.ts:140-141 extensionNeeds
  src/tooling/migrate/ext.ts:242-243 versionAccepted
function a07373d1dc85 ~71 minified bytes
  src/dialects/pg/schema.ts:1508-1511 resolveRelations
  src/tooling/describe/lock.ts:173-176 renderRawTypes
function bad031d7a71c ~71 minified bytes
  src/tooling/describe/protocol.ts:530-533 columnsOf
  src/tooling/describe/protocol.ts:550-553 dataRow
function 7abc4004fe6d ~70 minified bytes
  src/runtime/ids/uuid.ts:37-40 mintUuidV7
  src/tooling/testing/random.ts:102-105 (function)
function 9ac5fd85a2e0 ~70 minified bytes
  src/tooling/errors/examples.ts:923 (arrow)
  src/tooling/errors/examples.ts:932 (arrow)
function cb426b9a59b3 ~70 minified bytes
  src/tooling/errors/examples.ts:434-437 (arrow)
  src/tooling/errors/examples.ts:440-443 (arrow)
function 15a2e28d2c4c ~69 minified bytes
  src/tooling/errors/examples.ts:1333 (arrow)
  src/tooling/errors/examples.ts:1451 (arrow)
function 075421727b1b ~68 minified bytes
  src/adapters/pg/call.ts:46-47 nextTransactionDepth
  src/tooling/testing/record.ts:46-50 isTransactionControl
function 8221c981ef79 ~67 minified bytes
  src/tooling/migrate/pg-probe.ts:444-446 parseDropIndex
  src/tooling/migrate/pg-probe.ts:495-497 parseAddEnum
function 145e5712240d ~65 minified bytes
  src/runtime/tenancy/composite.ts:109-112 (function)
  src/runtime/tenancy/index.ts:129-132 (function)
function 151cf04a292e ~65 minified bytes
  src/tooling/migrate/lint-rules.ts:764-765 unsafeSetNotNull
  src/tooling/migrate/lint-rules.ts:898-899 (arrow)
function 699b8a091820 ~65 minified bytes
  src/dialects/pg/decimal.ts:154 numericText
  src/dialects/pg/quote.ts:40 isBareNumber
function 3b4b70788eb6 ~62 minified bytes
  src/tooling/migrate/lint-rules.ts:475-476 sqlWords
  src/tooling/migrate/pg-probe.ts:713-714 readIdent
function 23a1651f9bbf ~55 minified bytes
  src/adapters/error.ts:158-160 isSqlstate
  src/contracts/connection.ts:107-109 isState
function 63c99152cf84 ~55 minified bytes
  src/runtime/sort.ts:492-496 compareText
  src/tooling/canonical-json.ts:75-79 compareUtf16
  src/tooling/migrate/import-drizzle.ts:858-862 compare
  src/tooling/migrate/pull-emit.ts:1287-1291 compare
  src/tooling/migrate/pull-routines.ts:650-654 compare
function 091b3bf32434 ~54 minified bytes
  src/tooling/describe/lock.ts:182 (arrow)
  src/tooling/testing/factories.ts:108 (arrow)
function b5138ec8b747 ~54 minified bytes
  src/dialects/pg/ext/call.ts:58-62 fnDistance
  src/dialects/pg/ext/call.ts:108-112 digestEquals
function 122d59874d0b ~51 minified bytes
  src/runtime/validate/engine.ts:443-444 precisionOk
  src/tooling/migrate/pull-emit.ts:741-742 typedCall
function 9bb39d1a5406 ~49 minified bytes
  src/runtime/topology.ts:689 readMaxLag
  src/runtime/topology.ts:845 readProbe
function 9638c1b40f94 ~47 minified bytes
  src/dialects/pg/decimal.ts:154 numericText
  src/dialects/pg/quote.ts:40 isBareNumber
  src/runtime/validate/engine.ts:458 plainDecimal
function 8d99d4876c9b ~42 minified bytes
  src/tooling/migrate/doctor.ts:115 (arrow)
  src/tooling/migrate/requirements.ts:92 (arrow)

