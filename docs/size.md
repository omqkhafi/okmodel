# Size and cold start

Numbers are from `bun run size` (`scripts/size.ts`) on this release commit. CI job `check` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `bun run check`, which runs that script. Cold import is the median of five fresh Node processes (D134). The failing cold-import gate is 25 ms, and it applies to the runtime entry only. A local sample above 15 ms is printed and does not fail the script.

Byte gates fail in that CI job. Install size is the unminified `dist/` and is printed, not gated.

| Graph | Minified | Gzip | Cold import | Gate |
| --- | ---: | ---: | ---: | --- |
| Runtime entry `okmodel` | 5,288 | 2,026 | 1.991 ms | 6,100 / 2,250 bytes, CI cold import 25 ms |
| App startup (10 tables, one find) | 88,938 | 29,778 | 10.380 ms | 90,900 / 30,000 bytes (D160, P27; P27b adds 115 / 60, D178; P28 adds 330 / 168, D180; P29 adds 215 / 225, D181). Cold import is printed, not gated |
| App startup, `postgres` stubbed | | | 5.456 ms | local reference 15 ms, not gated |
| App startup, every 0.2 feature in use (P30) | 113,705 | 37,506 | 12.068 ms | printed, not gated. `scripts/app-full.ts` |
| App total graph, lazy chunks included | 164,394 | 54,571 | | printed, not gated |
| Feature-full app total graph, lazy chunks included | 203,225 | 66,295 | | printed, not gated |
| `okmodel/pg` barrel | 74,380 | 23,591 | 3.338 ms | printed, not gated |
| Connect `okmodel/pg/postgresjs` startup | 40,990 | 14,591 | 8.036 ms | 41,600 / 14,600 (D160, P27). Cold import printed, not gated |
| Connect postgres.js, driver stubbed | | | 2.823 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pglite` startup | 38,957 | 13,974 | 11.063 ms | 39,300 / 13,980 (D160, P27). Cold import printed, not gated |
| Connect PGlite, driver stubbed | | | 3.063 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pg` startup | 41,402 | 14,770 | 11.637 ms | 42,400 / 14,920 (D160, P27). Cold import printed, not gated |
| Connect `okmodel/pg/pg`, driver stubbed | | | 2.924 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/bun` startup | 40,251 | 14,285 | | 41,200 / 14,470 (D160, P27). Node cold import skipped: Bun.sql runs only on Bun |
| Connect Bun.sql, driver stubbed | | | 2.743 ms | local reference 15 ms, not gated |
| Install size (`dist/`) | 956,020 bytes unminified | | | printed, not gated |

Adapter entries, driver included, are printed and not gated on cold import: postgres.js 7.979 ms, PGlite 10.319 ms. Their minified bytes that are not already in the runtime entry are gated: postgres.js 14,531 of 15,093, PGlite 10,155 of 12,010.

Moving `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders to `okmodel/internal` changed the runtime entry from 24,426 / 8,584 to 5,525 / 2,042. The runtime-entry gate is that measurement plus 10 percent (6,100 / 2,250). Taking `compileColumn`, `emitRowTypes`, `mapPostgresError`, and the operator tag helpers off `okmodel/pg` changed that barrel from 70,059 / 21,873 to 62,063 / 19,409. The app startup graph stayed 77,537 / 25,625. Connect startup graphs stayed 37,952 / 13,158 and 36,330 / 12,862. The internal entry is not on the application import path.

The app startup graph is 2.2% under its minified ceiling and 0.7% under its gzip ceiling. The gates are the P27 measurement plus 3 percent (D160, D176), and the gzip gate is the 30,000 cap. What a feature costs an app that uses it is in the table below; none of those is a gate. The `manyThrough` resolver and emitter travel with the relation, so they sit in the startup graph of an app that declares one; the `page` and `aggregate` planners are lazy chunks. An application that declares presets pays for the dispatch already counted in the featureless graph and loads the preset chunk (a lazy chunk) on its first preset call. Under the 0.2 cap of 91,000 / 30,000 the featureless graph has 2,062 minified bytes and 222 gzip left, and the postgres.js and PGlite connect entries have 9 and 6 gzip bytes left.

First find on the local sample was 0.540 ms. First include was 0.842 ms. Those are one run of `scripts/query-latency.ts`, printed by the size script, and they are not a gate.

## What a feature costs (P30)

The feature-full app (`scripts/app-full.ts`) turns on everything the 0.2 train adds in one 10-table app: column tenancy with one global table, `archivable()` with a cascade on five tables, `timestamps()` on three, a validation rule on one column, `one`, `many` and `manyThrough` relations, three presets, and calls to `include`, `page`, `aggregate`, `archive`, `tx` and `batch` inside a function that does not run at import. It measures 113,705 minified and 37,506 gzip bytes at startup, 12.068 ms cold import, and 203,225 / 66,295 with every lazy chunk. That is 24,767 / 7,728 above the plain app, and 22,705 / 7,506 above the cap of 91,000 / 30,000 that applies to the plain app. The full app is printed and is not a gate: the cap is for an app that uses none of these, and each feature is paid by the app that uses it (D129).

| App | Startup min | Startup gzip | Over the plain app (min / gzip) |
| --- | ---: | ---: | ---: |
| Plain (gated) | 88,938 | 29,778 | |
| `manyThrough`, `page`, `aggregate` | 90,935 | 30,479 | +1,997 / +701 |
| Validation | 94,076 | 31,485 | +5,138 / +1,707 |
| `archivable()` on one table | 98,856 | 32,881 | +9,918 / +3,103 |
| Every 0.2 feature (full) | 113,705 | 37,506 | +24,767 / +7,728 |

The three rows above the full app add up to +17,053 / +5,511; the full app also carries column tenancy, `timestamps()`, presets, `one` and `many`, `tx` and `batch`, which have no row of their own.

### The entry-chunk size pass: what it could save

Measured, not built. The idea is to move code that an app needs only at its first query out of the startup graph, so a cold start parses less.

- Ceiling. The plain app without `connect` (schema, types and `OkmError` only) is 57,765 minified and 18,697 gzip bytes. The plain app with it is 88,938 / 29,778. So the most a pass could ever take out of startup is 31,173 / 11,081 (35% and 37%): the client, the planner and the adapter, all behind a first-call dynamic import. For the feature-full app the same ceiling is 24,160 / 8,239.
- What is in that ceiling, by the bundler's own count: `src/runtime/plan.ts` 14,394 bytes, `src/runtime/client.ts` 7,910, `src/adapters/pg/postgresjs.ts` and its result and call helpers 7,313, `src/contracts/error.ts` 4,977 (needed by the entry anyway), `src/dialects/pg/array-literal.ts` 1,847, `src/contracts/nearest.ts` 956.
- A realistic pass moves the read planner out of `plan.ts` (the `emit*`, `bindCall`, `compileCall`, `appliedRules` half), `array-literal.ts` and `nearest.ts`. That is an estimate of 8,000 to 12,000 minified bytes and 2,700 to 4,000 gzip bytes. It is an estimate, not a measurement: `plan.ts` mixes helpers that write, archive and the adapters also use, and those must stay.
- Risk. The first query pays one more chunk load (today's first `find` is 0.540 ms, so the added cost is probably a few tenths of a millisecond, once). A bundler that does not split dynamic imports inlines the chunk, which gives no saving and no loss. The client facade must stay synchronous to build, so the lazy edge sits at the first call and every table method becomes an async hop. `plan.ts` is imported by 20 runtime files, so the split touches the planner, the writes, archive, `batch` and `tx`; the property tests in this PR are the net for it. The gates would be re-measured, and room under the cap would grow by the amount moved.
- Not done in P30. It needs its own prompt and a decision on whether the cap is the right shape, because the savings come from the client and not from any one feature.
