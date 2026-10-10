# Size and cold start

The table in this section is the 0.5.0 release sample. The graphs on `main` after 0.5.1 are in [M2 budget audit (P80)](#m2-budget-audit-p80), measured 2026-10-10. Numbers in that section are from the same bundler walk as `bun run size` ([`scripts/size.ts`](../scripts/size.ts)). CI job `check` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `bun run check`, which runs that script. Cold import is the median of five fresh Node processes (D134). The failing cold-import gate is 25 ms, and it applies to the runtime entry only. A local sample above 15 ms is printed and does not fail the script.

Byte gates fail in that CI job. Install size is the unminified `dist/` and is printed, not gated.

| Graph | Minified | Gzip | Cold import | Gate |
| --- | ---: | ---: | ---: | --- |
| Runtime entry `okmodel` | 5,288 | 2,026 | 2.347 ms | 6,100 / 2,250 bytes, CI cold import 25 ms |
| App startup (10 tables, one find) | 89,751 | 29,801 | 15.061 ms | 90,900 / 30,000 bytes (D160, P27; P27b adds 115 / 60, D178; P28 adds 330 / 168, D180; P29 adds 215 / 225, D181; P60 adds 100 / 37, D201; P61 adds 190 / 23, D202; P62 minified +0, gzip +15 from a rename, D203). Cold import is printed, not gated |
| App startup, `postgres` stubbed | | | 6.686 ms | local reference 15 ms, not gated |
| App startup, every 0.2 feature in use (P30) | 120,132 | 39,162 | 15.956 ms | printed, not gated. `scripts/app-full.ts` |
| App total graph, lazy chunks included | 190,009 | 61,660 | | printed, not gated |
| Feature-full app total graph, lazy chunks included | 234,589 | 75,151 | | printed, not gated |
| `okmodel/testing` | 139,951 | 44,959 | 5.367 ms | printed, not gated |
| `okmodel/pg` barrel | 77,244 | 24,401 | 5.101 ms | printed, not gated |
| Connect `okmodel/pg/postgresjs` startup | 41,137 | 14,502 | 9.590 ms | 41,600 / 14,600 (D160, P27; P60 +98 / +27, D201; P61 +49 / +33, D202; P62 minified +0, gzip -2 from a rename, D203). Cold import printed, not gated |
| Connect postgres.js, driver stubbed | | | 3.579 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pglite` startup | 39,135 | 13,889 | 12.612 ms | 39,300 / 13,980 (D160, P27; P60 +105 / +32, D201; P61 +73 / +25, D202; P62 minified +0, gzip +1 from a rename, D203). Cold import printed, not gated |
| Connect PGlite, driver stubbed | | | 3.216 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pg` startup | 41,547 | 14,672 | 18.338 ms | 42,400 / 14,920 (D160, P27; P60 +96 / +27, D201; P61 +49 / +30, D202; P62 minified +0, gzip +0, D203). Cold import printed, not gated |
| Connect `okmodel/pg/pg`, driver stubbed | | | 6.430 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/bun` startup | 40,395 | 14,183 | | 41,200 / 14,470 (D160, P27; P60 +96 / +24, D201; P61 +48 / +19, D202; P62 minified +0, gzip +1 from a rename, D203). Node cold import skipped: Bun.sql runs only on Bun |
| Connect Bun.sql, driver stubbed | | | 4.650 ms | local reference 15 ms, not gated |
| Install size (`dist/`) | 1,440,218 bytes unminified | | | printed, not gated |

Adapter entries, driver included, are printed and not gated on cold import: postgres.js 13.473 ms, PGlite 15.410 ms. Their minified bytes that are not already in the runtime entry are gated: postgres.js 14,531 of 15,093, PGlite 10,155 of 12,010. The PGlite adapter sample is above the 15 ms local reference and is not a gate.

Moving `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders to `okmodel/internal` changed the runtime entry from 24,426 / 8,584 to 5,525 / 2,042. The runtime-entry gate is that measurement plus 10 percent (6,100 / 2,250). Taking `compileColumn`, `emitRowTypes`, `mapPostgresError`, and the operator tag helpers off `okmodel/pg` changed that barrel from 70,059 / 21,873 to 62,063 / 19,409. The app startup graph stayed 77,537 / 25,625. Connect startup graphs stayed 37,952 / 13,158 and 36,330 / 12,862. The internal entry is not on the application import path.

The app startup graph is 1.3% under its minified ceiling and 0.7% under its gzip ceiling. The gates are the P27 measurement plus 3 percent (D160, D176), and the gzip gate is the 30,000 cap. What a feature costs an app that uses it is in the table below; none of those is a gate. The `manyThrough` resolver and emitter travel with the relation, so they sit in the startup graph of an app that declares one; the `page` and `aggregate` planners are lazy chunks. An application that declares presets pays for the dispatch already counted in the featureless graph and loads the preset chunk (a lazy chunk) on its first preset call. Under the gates of 90,900 / 30,000 the featureless graph has 1,149 minified bytes and 199 gzip left. The postgres.js connect entry has 463 minified and 98 gzip left. The PGlite connect entry has 165 minified and 91 gzip left. node-postgres has 853 and 248 left. Bun.sql has 805 and 287 left. The `route` key spends part of that room (D202). P62 does not change those minified counts. The gzip moves (app +15, postgres.js -2, PGlite +1, node-postgres +0, Bun.sql +1) come from the bundler renaming same-length locals when the lazy topology chunk changes (D203). Each of those graphs keeps at least 60 gzip bytes. Commit positions (P63) stay in that chunk. The lazy topology chunk on this sample is 21,380 minified and 6,698 gzip (D205 recorded 21,379 / 6,689). It is printed, not gated.

First find on the local sample was 0.604 ms. First include was 0.953 ms. Those are one run of `scripts/query-latency.ts`, printed by the size script, and they are not a gate. This sample's app startup cold import is 15.061 ms and the node-postgres connect cold import is 18.338 ms. Both are above the 15 ms local reference and neither is a gate.

## What a feature costs (P30)

The feature-full app (`scripts/app-full.ts`) turns on everything the 0.2 train adds in one 10-table app: column tenancy with one global table, `archivable()` with a cascade on five tables, `timestamps()` on three, a validation rule on one column, `one`, `many` and `manyThrough` relations, three presets, and calls to `include`, `page`, `aggregate`, `archive`, `tx` and `batch` inside a function that does not run at import. It measures 120,132 minified and 39,162 gzip bytes at startup, and 234,589 / 75,151 with every lazy chunk. That is 30,381 / 9,361 above the plain app, and 29,232 / 9,162 above the cap of 90,900 / 30,000 that applies to the plain app. The full app is printed and is not a gate: the cap is for an app that uses none of these, and each feature is paid by the app that uses it (D129).

| App | Startup min | Startup gzip | Over the plain app (min / gzip) |
| --- | ---: | ---: | ---: |
| Plain (gated) | 89,751 | 29,801 | |
| `manyThrough`, `page`, `aggregate` | 91,620 | 30,484 | +1,869 / +683 |
| Validation | 94,890 | 31,536 | +5,139 / +1,735 |
| `archivable()` on one table | 99,664 | 32,956 | +9,913 / +3,155 |
| Every 0.2 feature (full) | 120,132 | 39,162 | +30,381 / +9,361 |

The three rows above the full app add up to +16,921 / +5,573; the full app also carries column tenancy, `timestamps()`, presets, `one` and `many`, `tx` and `batch`, which have no row of their own.

### The entry-chunk size pass: what it could save

Measured, not built. The idea is to move code that an app needs only at its first query out of the startup graph, so a cold start parses less.

- Ceiling. At P30 the plain app without `connect` (schema, types and `OkmError` only) was 57,765 minified and 18,697 gzip bytes. The plain app with it was 88,938 / 29,778. So the most a pass could ever take out of startup is 31,173 / 11,081 (35% and 37%): the client, the planner and the adapter, all behind a first-call dynamic import. For the feature-full app the same ceiling was 24,160 / 8,239. The current graphs are in the table above.
- What is in that ceiling, by the bundler's own count: `src/runtime/plan.ts` 14,394 bytes, `src/runtime/client.ts` 7,910, `src/adapters/pg/postgresjs.ts` and its result and call helpers 7,313, `src/contracts/error.ts` 4,977 (needed by the entry anyway), `src/dialects/pg/array-literal.ts` 1,847, `src/contracts/nearest.ts` 956.
- A realistic pass moves the read planner out of `plan.ts` (the `emit*`, `bindCall`, `compileCall`, `appliedRules` half), `array-literal.ts` and `nearest.ts`. That is an estimate of 8,000 to 12,000 minified bytes and 2,700 to 4,000 gzip bytes. It is an estimate, not a measurement: `plan.ts` mixes helpers that write, archive and the adapters also use, and those must stay.
- Risk. The first query pays one more chunk load (the P30 sample's first `find` was 0.540 ms, so the added cost is probably a few tenths of a millisecond, once). A bundler that does not split dynamic imports inlines the chunk, which gives no saving and no loss. The client facade must stay synchronous to build, so the lazy edge sits at the first call and every table method becomes an async hop. `plan.ts` is imported by 20 runtime files, so the split touches the planner, the writes, archive, `batch` and `tx`; the property tests in this PR are the net for it. The gates would be re-measured, and room under the cap would grow by the amount moved.
- Not done in P30. It needs its own prompt and a decision on whether the cap is the right shape, because the savings come from the client and not from any one feature.

## M2 budget audit (P80)

Measured 2026-10-10 on `0952fa8` (the `main` tip this branch started from). No gate, cap, or ceiling moved. The prototypes were reverted; nothing under `src/` changed. D218 records the facts. It does not choose a byte policy.

Graph minified and gzip bytes use the walk in `scripts/size.ts`: `bun build --target node --minify`, `--splitting` except the runtime entry, the static-import closure only, chunk ids normalised to a fixed id of the same length, then gzip level 9 of the concatenated startup chunks. Two runs of all six graphs matched to the byte. Per-file minified bytes are the bun metafile `bytesInOutput` on those startup outputs. Per-file gzip is that file's share of its own chunk's gzip, allocated by minified bytes so the shares of one chunk sum to the chunk. They do not sum to the gated graph gzip, which gzips the chunks as one buffer. The app's directory shares sum to 30,794 gzip against a graph gzip of 30,157 (637 bytes of cross-chunk compression). Bytes in the output that the metafile does not attribute to a source file are listed as glue.

Cold import is the median of five fresh Node processes, timer around `import()` only, from the same script. This sample: runtime entry 1.960 ms, featureless app 10.688 ms (driver stubbed 5.483 ms), postgres.js 8.478 ms (stubbed 2.861 ms), PGlite 10.918 ms (stubbed 3.375 ms), node-postgres 12.634 ms (stubbed 2.924 ms), Bun.sql stubbed 2.767 ms (Node cold import skipped). All of them are under the 15 ms local reference. The 25 ms CI gate stays on the runtime entry. `okmodel/testing` is 143,589 / 46,312, cold import 5.088 ms, printed and not gated. The featureless app's total graph, lazy chunks included, is 196,141 / 63,749, printed and not gated.

### Headroom

Gates are the constants in `scripts/size.ts` (D214 for the connect entries and the app gzip gate, D144 for the runtime entry, D160 for the app minified gate). Left is gate minus measured.

| Graph | Minified | Gzip | Gate | Left (min / gzip) |
| --- | ---: | ---: | --- | ---: |
| Runtime entry | 5,288 | 2,026 | 6,100 / 2,250 | 812 / 224 |
| Featureless app | 90,851 | 30,157 | 90,900 / 30,170 | 49 / 13 |
| postgres.js | 42,382 | 14,898 | 42,450 / 14,920 | 68 / 22 |
| PGlite | 40,393 | 14,257 | 40,450 / 14,280 | 57 / 23 |
| node-postgres | 42,795 | 15,048 | 42,850 / 15,070 | 55 / 22 |
| Bun.sql | 41,643 | 14,592 | 41,700 / 14,620 | 57 / 28 |

Gzip is the binding number on the app (13 bytes) and on every connect entry (22 to 28). The runtime entry is not the constraint.

### Graph composition

Directory rows are files in that directory only, not its children. Glue is not in the directory sums. The app has 8 files at or under 150 minified bytes (588 minified, gzip share 200) besides the rows below. Each connect graph has one such file, `src/runtime/safety-hook.ts` at 65.

#### Featureless app

Glue 327 minified. 48 source files.

| Directory | Files | Minified | Gzip share |
| --- | ---: | ---: | ---: |
| `src/dialects/pg` | 21 | 33,159 | 11,219 |
| `src/runtime` | 3 | 23,535 | 8,038 |
| `src/contracts/catalog` | 9 | 15,045 | 5,130 |
| `src/contracts` | 7 | 9,916 | 3,384 |
| `src/adapters/pg` | 3 | 6,862 | 2,344 |
| `scripts` | 1 | 808 | 273 |
| `src/runtime/pg` | 1 | 716 | 241 |
| `src/adapters` | 2 | 451 | 154 |
| `src/dialects/pg/ops` | 1 | 32 | 11 |

| File | Minified | Gzip share |
| --- | ---: | ---: |
| `src/dialects/pg/schema.ts` | 17,057 | 5,754 |
| `src/runtime/plan.ts` | 14,977 | 5,115 |
| `src/runtime/client.ts` | 8,493 | 2,901 |
| `src/contracts/catalog/object.ts` | 6,220 | 2,124 |
| `src/adapters/pg/postgresjs.ts` | 5,048 | 1,724 |
| `src/contracts/error.ts` | 4,977 | 1,700 |
| `src/dialects/pg/column.ts` | 4,911 | 1,677 |
| `src/contracts/catalog/identity.ts` | 2,651 | 905 |
| `src/contracts/sha256.ts` | 2,165 | 739 |
| `src/dialects/pg/array-literal.ts` | 1,847 | 631 |
| `src/dialects/pg/compile.ts` | 1,740 | 587 |
| `src/contracts/catalog/json.ts` | 1,378 | 471 |
| `src/dialects/pg/table.ts` | 1,374 | 463 |
| `src/contracts/catalog/identifier.ts` | 1,217 | 416 |
| `src/adapters/pg/result.ts` | 1,205 | 412 |
| `src/contracts/catalog/order.ts` | 1,137 | 383 |
| `src/contracts/utf8.ts` | 1,114 | 380 |
| `src/dialects/pg/keys.ts` | 1,019 | 344 |
| `src/dialects/pg/decimal.ts` | 969 | 327 |
| `src/contracts/nearest.ts` | 956 | 326 |
| `src/contracts/catalog/build.ts` | 825 | 278 |
| `scripts/app-startup.ts` | 808 | 273 |
| `src/contracts/catalog/words.ts` | 805 | 275 |
| `src/runtime/pg/postgresjs.ts` | 716 | 241 |
| `src/dialects/pg/filters.ts` | 702 | 237 |
| `src/dialects/pg/temporal.ts` | 693 | 234 |
| `src/contracts/catalog/enum.ts` | 681 | 233 |
| `src/adapters/pg/call.ts` | 609 | 208 |
| `src/dialects/pg/integer.ts` | 499 | 168 |
| `src/dialects/pg/json.ts` | 487 | 166 |
| `src/contracts/location.ts` | 373 | 126 |
| `src/adapters/failure.ts` | 354 | 121 |
| `src/contracts/generator.ts` | 331 | 113 |
| `src/dialects/pg/tenancy.ts` | 296 | 100 |
| `src/dialects/pg/quote.ts` | 282 | 96 |
| `src/dialects/pg/bool.ts` | 270 | 91 |
| `src/dialects/pg/time.ts` | 224 | 76 |
| `src/dialects/pg/operators.ts` | 189 | 65 |
| `src/dialects/pg/relations.ts` | 169 | 57 |
| `src/dialects/pg/finite.ts` | 168 | 57 |

#### Runtime entry

One file, no splitting. Glue 109. `src/contracts/index.ts` contributes 0. `src/contracts/error.ts` is 5,179 minified and the whole 2,026 gzip. `throwNamed` and `nearest.ts` are not in this bundle: the entry does not export them.

#### Connect entries

Each table is the whole startup graph (fewer than 25 files). Glue: postgres.js 264, PGlite 190, node-postgres 239, Bun.sql 237.

| File | postgres.js | PGlite | node-postgres | Bun.sql |
| --- | ---: | ---: | ---: | ---: |
| `src/runtime/plan.ts` | 14,863 / 5,236 | 14,851 / 5,246 | 14,859 / 5,232 | 14,859 / 5,215 |
| `src/runtime/client.ts` | 8,395 / 2,957 | 8,384 / 2,962 | 8,385 / 2,953 | 8,385 / 2,943 |
| `src/contracts/error.ts` | 4,971 / 1,751 | 4,971 / 1,756 | 4,971 / 1,751 | 4,971 / 1,745 |
| Adapter body | `postgresjs.ts` 4,998 / 1,761 | `pglite.ts` 3,260 / 1,339 | `nodepostgres.ts` 3,159 / 1,112 | `bunsql.ts` 2,060 / 723 |
| `src/adapters/pg/session.ts` | | | 2,285 / 805 | 2,234 / 784 |
| `src/adapters/error.ts` | 2,182 / 769 | 2,182 / 771 | 2,182 / 768 | 2,182 / 766 |
| `src/adapters/pg/result.ts` | 1,205 / 424 | 1,191 / 489 | 1,205 / 424 | 1,205 / 423 |
| `src/contracts/utf8.ts` | 961 / 339 | 961 / 340 | 961 / 338 | 961 / 337 |
| `src/contracts/nearest.ts` | 920 / 324 | 921 / 325 | 921 / 324 | 921 / 323 |
| `src/contracts/catalog/words.ts` | 805 / 284 | 805 / 284 | 805 / 284 | 805 / 283 |
| `src/contracts/catalog/identifier.ts` | 736 / 259 | 736 / 260 | 736 / 259 | 736 / 258 |
| Connect entry file | 711 / 450 | 583 / 240 | 711 / 445 | 711 / 445 |
| `src/adapters/pg/call.ts` | 608 / 214 | 603 / 248 | 608 / 214 | 608 / 213 |
| `src/adapters/failure.ts` | 354 / 125 | 348 / 143 | 359 / 127 | 359 / 126 |
| `src/dialects/pg/operators.ts` | 190 / 67 | 190 / 67 | 190 / 67 | 190 / 67 |
| `src/adapters/capabilities.ts` | 154 / 54 | 152 / 62 | 154 / 54 | 154 / 54 |
| `src/runtime/safety-hook.ts` | 65 / 23 | 65 / 23 | 65 / 23 | 65 / 23 |

`plan.ts`, `client.ts`, and `error.ts` are the shared core. They are in the app and in every connect entry. The app's copies are slightly larger (14,977, 8,493, and 4,977) because that bundle keeps the schema-facing paths. `nearest.ts`, `utf8.ts`, `words.ts`, `identifier.ts`, `call.ts`, `failure.ts`, `operators.ts`, `capabilities.ts`, and `safety-hook.ts` are in every connect entry and in the app. `session.ts` is shared by node-postgres and Bun.sql only. The postgres.js adapter body is in the app and in the postgres.js connect entry. Catalog object builders, `schema.ts`, `column.ts`, `sha256.ts`, and `array-literal.ts` are in the app only.

Already lazy, so they are not in the tables above. On the app: topology 22,184 / 6,971, write 16,259 / 5,626, transaction 7,251 / 2,987, conflict 4,383 / 1,719, filter parse 2,845 / 1,070, watch 530 / 320. The same chunks exist on the connect entries. A hook that lands in one of them does not move a gated graph.

### What each 0.6 hook costs

Each row is a throwaway patch, measured twice, then reverted. The two runs matched unless the row says otherwise. "Gated" is the featureless app and the connect entries. A module the featureless app does not import costs 0 on those gates. An app that imports it pays the other column, and that app is not gated.

| Hook | Where it sits | Gated startup | Other cost |
| --- | --- | --- | --- |
| P81 hidden `where` / `orderBy`, opt-in flags read on the column | Two branches in `plan.ts` (`emitPredicate`, `emitOrder`) | App +148 / +45 (90,999 / 30,202). Connect entries +146 minified and +36 to +43 gzip. Runtime +0 / +0. Over every gzip gate | Cannot move to `import()` while planning stays synchronous |
| P81 tenant `onConflict` | Branch in `conflict.ts`, already loaded from `write.ts` | Minified +0. App gzip 30,158 against 30,157 on both runs (rename noise; postgres.js and Bun.sql +0 / +0) | Lazy conflict chunk 4,383 / 1,719 to 4,474 / 1,738 (+91 / +19) |
| P81 `refresh()` | Method plus `import()` on the view handle | +0 / +0 (the featureless app does not import the view module) | View-using app +72 / +42 (96,837 / 32,102). Lazy chunk 79 / 93 |
| P81 timeout race, kept in the lazy watch | `call.ts` delegates to `raceCall` in `watch.ts` | App −45 / −16. postgres.js −45 / −8. PGlite −45 / −22. node-postgres −45 / −17. Bun.sql −45 / −17 | Watch chunk 530 / 320 to 767 / 399 (+237 / +79). This is not the D216 fix |
| P81 PGlite outer-client branch, on top of that race | Branch in `pglite.ts` before `runCall` | PGlite net +45 / +6 against today's baseline (40,438 / 14,263), 12 minified and 17 gzip still left. App and Bun.sql stay at the race's smaller size | The D216 fix was +191 / +92 on PGlite and was removed. That number still stands |
| P82 `composite` and `path`, P83 `rls`: smallest accept | `readTenancy` requires a string `strategy` and a `rewrite` function, and does not name the strategy | App +1 / −8 (90,852 / 30,149), both runs. Connect entries do not contain `tenancy.ts` | |
| P82 / P83 named strategy strings, measured because they are larger | `strategy !== "column"` extended with `composite`, then `path`, then `rls` | App +21 / +11, then +33 / +17, then +44 / +19. postgres.js +0 / +0. The `path` step is gzip 30,174, 4 over the 30,170 gate | |
| P82 `composite` module, imported | Stub `rewrite` plus `import()` of a SQL file | +0 / +0 when the file exists and the app does not import it | Importing app +134 / +53 (90,985 / 30,210). Lazy SQL chunk 69 / 87 |
| P82 `path` module, imported | Same shape | +0 / +0 if not imported | Importing app +124 / +58 (90,975 / 30,215). Lazy SQL chunk 62 / 82 |
| P83 `rls` module, imported | Same shape, policy string in the lazy file | +0 / +0 if not imported | Importing app +122 / +56 (90,973 / 30,213). Lazy SQL chunk 133 / 130 |
| P83 session variable | One-slot `runRls` called from `tx()` | +0 beyond the strategy check. The transaction chunk is already lazy | Transaction chunk 7,251 / 2,987 to 7,283 / 3,007 (+32 / +20) |
| P83 `security_invoker` | Branch in `view()` while building the catalog record | +0 / +0 on the featureless app | View-using app +57 / +40 (97,721 / 32,241 against 97,664 / 32,201) |
| P84 column grant, reporting role, `okm_meta` SELECT | Three functions appended to `role/sql.ts` | App +0 from these functions (the role module is not in the app graph) | Role entry 11,450 / 4,040, then +81 / +35, +60 / +17, and +73 / +25. Not a gated graph |
| P84 ownership `ignored` | Branch in `compile.ts` | App +21 / +12 (90,872 / 30,169), 28 minified and 1 gzip left. postgres.js +0 / +0 | `compile.ts` is not in the connect startup graphs |
| P85 one new `filters()` operator | `overlaps` in `filter-parse.ts` | +0 / +0 | Parse chunk 2,845 / 1,070 to 2,897 / 1,084 (+52 / +14) |
| P85 relation branch inside synchronous `filters()` | Extra check in `filters.ts` | App +95 / +43 (90,946 / 30,200), over the gzip gate. postgres.js +0 / +0 | D161 keeps `filters()` synchronous. New operators can stay in the parser |
| P85 view `isolation()` | Branch in `okmodel/testing` | App and postgres.js +0 / +0 | Testing entry 143,589 / 46,312 to 143,660 / 46,327 (+71 / +15). Not gated |

The hidden check is the only 0.6 hook that has to sit in `plan.ts` on every gated graph. It does not fit. Everything else can stay at 0 on the gated graphs, or in a module the featureless app does not import, or in tooling or `okmodel/testing`.

### Shrink candidates

Each saving is a reverted experiment, two runs, against the same baseline. They were not applied, and they were not measured as a stack. Gzip savings do not add.

| Candidate | Saving (min / gzip) | Safe? |
| --- | --- | --- |
| Move `effectivePredicate` to a module imported only by `write.ts` and `archive.ts` | App −553 / −160. postgres.js −551 / −172. PGlite −564 / −151. node-postgres −554 / −160. Bun.sql −554 / −183. The write chunk grows by about that minified amount (16,259 / 5,626 to 16,812 / 5,815 on the app) | Yes. Those two lazy modules are the only callers. The boundary already exists |
| Keep the timeout race in `watch.ts` (the P81 row) | App −45 / −16 and −45 minified on every connect entry (−8 to −22 gzip) | Yes. `call.ts` already dynamic-imports `watch.ts`. The prototype also added the race; the net is still smaller |
| Stop `ColumnBuilder.array()` referencing `array-literal.ts` | App −1,857 / −574 (88,994 / 29,583). The dropped file is `array-literal.ts` (−1,847) and `column.ts` (−10) | No. Encode and decode are synchronous methods on the class, so `import()` cannot take the scanner. postgres.js, which does not contain that file, still re-minified untouched modules by +24 / −7 (42,406 / 14,891), both runs. That is not code added to the connect graph |
| Drop `nearestName` from `throwNamed` | App −1,074 / −477. Connect entries about −1,038 minified and −450 to −491 gzip. Runtime entry +0 / +0 | No. The throw is synchronous, and the suggestion is part of the error text. Not behind a lazy boundary |
| Replace catalog builders (`object.ts`, `enum.ts`, `build.ts`) with local throws inside `schema.ts` | App −4,717 / −1,210. postgres.js +0 / +0 | No. This is a ceiling. `schema()` closes over the builders and `.catalog` is synchronous, so they cannot move to the lazy document chunk without an API change |
| Remove the `filters.ts` import from `table()` | App −799 / −252. postgres.js +0 / +0 | No. D161 requires the synchronous check |

Ranked by saving against risk: the predicate move first, then the watch move. Both sit behind a lazy boundary that already exists. The array, nearest, and catalog numbers are larger and are not safe to take. The filters-module number is blocked by D161.

## P81 after the predicate move

Ali chose D218 option d: move first, then spend (D219). No gate, cap, or ceiling moves. `effectivePredicate` now loads with writes and archive. `orFail` stays in `plan.ts`. The table is one `bun run size` run after that move. The runtime entry is unchanged at 5,288 / 2,026.

| Graph | Before (D218) | After the move | Delta (min / gzip) | Gate | Left (min / gzip) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Runtime entry | 5,288 / 2,026 | 5,288 / 2,026 | 0 / 0 | 6,100 / 2,250 | 812 / 224 |
| Featureless app | 90,851 / 30,157 | 90,506 / 30,063 | −345 / −94 | 90,900 / 30,170 | 394 / 107 |
| postgres.js | 42,382 / 14,898 | 42,038 / 14,805 | −344 / −93 | 42,450 / 14,920 | 412 / 115 |
| PGlite | 40,393 / 14,257 | 40,049 / 14,163 | −344 / −94 | 40,450 / 14,280 | 401 / 117 |
| node-postgres | 42,795 / 15,048 | 42,451 / 14,965 | −344 / −83 | 42,850 / 15,070 | 399 / 105 |
| Bun.sql | 41,643 / 14,592 | 41,299 / 14,504 | −344 / −88 | 41,700 / 14,620 | 401 / 116 |

Cold import after the move: runtime 1.801 ms, app 10.898 ms (stubbed 5.643 ms), postgres.js 8.732 ms (stubbed 2.822 ms), PGlite 11.015 ms (stubbed 2.931 ms), node-postgres 14.817 ms (stubbed 2.871 ms), Bun.sql stubbed 2.664 ms. All are under the 15 ms local reference. The app total graph is 196,139 / 63,765. The prototype's larger saving is not this measurement: `orFail` still ships in the read planner.
