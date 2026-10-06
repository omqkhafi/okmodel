# Size and cold start

Numbers are from `bun run size` (`scripts/size.ts`) on this release commit. CI job `check` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `bun run check`, which runs that script. Cold import is the median of five fresh Node processes (D134). The failing cold-import gate is 25 ms, and it applies to the runtime entry only. A local sample above 15 ms is printed and does not fail the script.

Byte gates fail in that CI job. Install size is the unminified `dist/` and is printed, not gated.

| Graph | Minified | Gzip | Cold import | Gate |
| --- | ---: | ---: | ---: | --- |
| Runtime entry `okmodel` | 5,288 | 2,026 | 2.563 ms | 6,100 / 2,250 bytes, CI cold import 25 ms |
| App startup (10 tables, one find) | 89,461 | 29,720 | 13.379 ms | 90,900 / 30,000 bytes (D160, P27; P27b adds 115 / 60, D178; P28 adds 330 / 168, D180; P29 adds 215 / 225, D181). Cold import is printed, not gated |
| App startup, `postgres` stubbed | | | 5.954 ms | local reference 15 ms, not gated |
| App startup, every 0.2 feature in use (P30) | 119,936 | 39,121 | 13.745 ms | printed, not gated. `scripts/app-full.ts` |
| App total graph, lazy chunks included | 167,755 | 55,205 | | printed, not gated |
| Feature-full app total graph, lazy chunks included | 212,438 | 68,646 | | printed, not gated |
| `okmodel/testing` | 139,191 | 44,768 | 5.418 ms | printed, not gated |
| `okmodel/pg` barrel | 77,244 | 24,401 | 4.002 ms | printed, not gated |
| Connect `okmodel/pg/postgresjs` startup | 40,990 | 14,446 | 13.186 ms | 41,600 / 14,600 (D160, P27). Cold import printed, not gated |
| Connect postgres.js, driver stubbed | | | 3.338 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pglite` startup | 38,957 | 13,826 | 12.818 ms | 39,300 / 13,980 (D160, P27). Cold import printed, not gated |
| Connect PGlite, driver stubbed | | | 2.995 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pg` startup | 41,402 | 14,616 | 11.875 ms | 42,400 / 14,920 (D160, P27). Cold import printed, not gated |
| Connect `okmodel/pg/pg`, driver stubbed | | | 2.912 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/bun` startup | 40,251 | 14,134 | | 41,200 / 14,470 (D160, P27). Node cold import skipped: Bun.sql runs only on Bun |
| Connect Bun.sql, driver stubbed | | | 2.852 ms | local reference 15 ms, not gated |
| Install size (`dist/`) | 1,379,009 bytes unminified | | | printed, not gated |

Adapter entries, driver included, are printed and not gated on cold import: postgres.js 9.583 ms, PGlite 13.200 ms. Their minified bytes that are not already in the runtime entry are gated: postgres.js 14,531 of 15,093, PGlite 10,155 of 12,010.

Moving `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders to `okmodel/internal` changed the runtime entry from 24,426 / 8,584 to 5,525 / 2,042. The runtime-entry gate is that measurement plus 10 percent (6,100 / 2,250). Taking `compileColumn`, `emitRowTypes`, `mapPostgresError`, and the operator tag helpers off `okmodel/pg` changed that barrel from 70,059 / 21,873 to 62,063 / 19,409. The app startup graph stayed 77,537 / 25,625. Connect startup graphs stayed 37,952 / 13,158 and 36,330 / 12,862. The internal entry is not on the application import path.

The app startup graph is 1.6% under its minified ceiling and 0.9% under its gzip ceiling. The gates are the P27 measurement plus 3 percent (D160, D176), and the gzip gate is the 30,000 cap. What a feature costs an app that uses it is in the table below; none of those is a gate. The `manyThrough` resolver and emitter travel with the relation, so they sit in the startup graph of an app that declares one; the `page` and `aggregate` planners are lazy chunks. An application that declares presets pays for the dispatch already counted in the featureless graph and loads the preset chunk (a lazy chunk) on its first preset call. Under the gates of 90,900 / 30,000 the featureless graph has 1,439 minified bytes and 280 gzip left. The postgres.js connect entry has 610 minified and 154 gzip left. The PGlite connect entry has 343 minified and 154 gzip left.

First find on the local sample was 0.566 ms. First include was 2.035 ms. Those are one run of `scripts/query-latency.ts`, printed by the size script, and they are not a gate.

## What a feature costs (P30)

The feature-full app (`scripts/app-full.ts`) turns on everything the 0.2 train adds in one 10-table app: column tenancy with one global table, `archivable()` with a cascade on five tables, `timestamps()` on three, a validation rule on one column, `one`, `many` and `manyThrough` relations, three presets, and calls to `include`, `page`, `aggregate`, `archive`, `tx` and `batch` inside a function that does not run at import. It measures 119,936 minified and 39,121 gzip bytes at startup, and 212,438 / 68,646 with every lazy chunk. That is 30,475 / 9,401 above the plain app, and 29,036 / 9,121 above the cap of 90,900 / 30,000 that applies to the plain app. The full app is printed and is not a gate: the cap is for an app that uses none of these, and each feature is paid by the app that uses it (D129).

| App | Startup min | Startup gzip | Over the plain app (min / gzip) |
| --- | ---: | ---: | ---: |
| Plain (gated) | 89,461 | 29,720 | |
| `manyThrough`, `page`, `aggregate` | 91,444 | 30,433 | +1,983 / +713 |
| Validation | 94,714 | 31,479 | +5,253 / +1,759 |
| `archivable()` on one table | 99,468 | 32,891 | +10,007 / +3,171 |
| Every 0.2 feature (full) | 119,936 | 39,121 | +30,475 / +9,401 |

The three rows above the full app add up to +17,243 / +5,643; the full app also carries column tenancy, `timestamps()`, presets, `one` and `many`, `tx` and `batch`, which have no row of their own.

### The entry-chunk size pass: what it could save

Measured, not built. The idea is to move code that an app needs only at its first query out of the startup graph, so a cold start parses less.

- Ceiling. At P30 the plain app without `connect` (schema, types and `OkmError` only) was 57,765 minified and 18,697 gzip bytes. The plain app with it was 88,938 / 29,778. So the most a pass could ever take out of startup is 31,173 / 11,081 (35% and 37%): the client, the planner and the adapter, all behind a first-call dynamic import. For the feature-full app the same ceiling was 24,160 / 8,239. The current graphs are in the table above.
- What is in that ceiling, by the bundler's own count: `src/runtime/plan.ts` 14,394 bytes, `src/runtime/client.ts` 7,910, `src/adapters/pg/postgresjs.ts` and its result and call helpers 7,313, `src/contracts/error.ts` 4,977 (needed by the entry anyway), `src/dialects/pg/array-literal.ts` 1,847, `src/contracts/nearest.ts` 956.
- A realistic pass moves the read planner out of `plan.ts` (the `emit*`, `bindCall`, `compileCall`, `appliedRules` half), `array-literal.ts` and `nearest.ts`. That is an estimate of 8,000 to 12,000 minified bytes and 2,700 to 4,000 gzip bytes. It is an estimate, not a measurement: `plan.ts` mixes helpers that write, archive and the adapters also use, and those must stay.
- Risk. The first query pays one more chunk load (the P30 sample's first `find` was 0.540 ms, so the added cost is probably a few tenths of a millisecond, once). A bundler that does not split dynamic imports inlines the chunk, which gives no saving and no loss. The client facade must stay synchronous to build, so the lazy edge sits at the first call and every table method becomes an async hop. `plan.ts` is imported by 20 runtime files, so the split touches the planner, the writes, archive, `batch` and `tx`; the property tests in this PR are the net for it. The gates would be re-measured, and room under the cap would grow by the amount moved.
- Not done in P30. It needs its own prompt and a decision on whether the cap is the right shape, because the savings come from the client and not from any one feature.
