# Size and cold start

Numbers are from `bun run size` (`scripts/size.ts`) on this release commit. CI job `check` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `bun run check`, which runs that script. Cold import is the median of five fresh Node processes (D134). The failing cold-import gate is 25 ms, and it applies to the runtime entry only. A local sample above 15 ms is printed and does not fail the script.

Byte gates fail in that CI job. Install size is the unminified `dist/` and is printed, not gated.

| Graph | Minified | Gzip | Cold import | Gate |
| --- | ---: | ---: | ---: | --- |
| Runtime entry `okmodel` | 5,525 | 2,042 | 1.770 ms | 6,100 / 2,250 bytes, CI cold import 25 ms |
| App startup (10 tables, one find) | 84,258 | 27,811 | 10.261 ms | 85,100 / 28,000 bytes (D158). Cold import is printed, not gated |
| App startup, `postgres` stubbed | | | 5.191 ms | local reference 15 ms, not gated |
| App total graph, lazy chunks included | 132,804 | 42,925 | | printed, not gated |
| `okmodel/pg` barrel | 68,500 | 21,534 | 3.224 ms | printed, not gated |
| Connect `okmodel/pg/postgresjs` startup | 40,310 | 13,934 | 8.969 ms | 40,800 / 14,100 (D158). Cold import printed, not gated |
| Connect postgres.js, driver stubbed | | | 2.735 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pglite` startup | 37,496 | 13,217 | 10.807 ms | 38,146 / 13,505. Cold import printed, not gated |
| Connect PGlite, driver stubbed | | | 2.814 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pg` startup | 40,464 | 14,120 | 11.502 ms | 41,000 / 14,250 (D158). Cold import printed, not gated |
| Connect `okmodel/pg/pg`, driver stubbed | | | 2.837 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/bun` startup | 39,365 | 13,686 | | 39,800 / 13,800 (D158). Node cold import skipped: Bun.sql runs only on Bun |
| Connect Bun.sql, driver stubbed | | | 2.775 ms | local reference 15 ms, not gated |
| Install size (`dist/`) | 688,210 bytes unminified | | | printed, not gated |

Adapter entries, driver included, are printed and not gated on cold import: postgres.js 7.705 ms, PGlite 9.589 ms. Their minified bytes that are not already in the runtime entry are gated: postgres.js 13,620 of 15,093, PGlite 9,753 of 12,010.

Moving `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders to `okmodel/internal` changed the runtime entry from 24,426 / 8,584 to 5,525 / 2,042. The runtime-entry gate is that measurement plus 10 percent (6,100 / 2,250). Taking `compileColumn`, `emitRowTypes`, `mapPostgresError`, and the operator tag helpers off `okmodel/pg` changed that barrel from 70,059 / 21,873 to 62,063 / 19,409. The app startup graph stayed 77,537 / 25,625. Connect startup graphs stayed 37,952 / 13,158 and 36,330 / 12,862. The internal entry is not on the application import path.

The app startup graph is 1.0% under its minified ceiling and 0.7% under its gzip ceiling. Each connect entry is within 3% of its minified ceiling. `okmodel/pg/pg` gzip is 0.9% under its ceiling and Bun.sql gzip is 0.8% under its ceiling. Those gates were not moved.

First find on the local sample was 0.448 ms. First include was 0.970 ms. Those are one run of `scripts/query-latency.ts`, printed by the size script, and they are not a gate.
