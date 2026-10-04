# Size and cold start

Numbers are from `bun run size` (`scripts/size.ts`) on this release commit. CI job `check` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `bun run check`, which runs that script. Cold import is the median of five fresh Node processes (D134). The failing cold-import gate is 25 ms, and it applies to the runtime entry only. A local sample above 15 ms is printed and does not fail the script.

Byte gates fail in that CI job. Install size is the unminified `dist/` and is printed, not gated.

| Graph | Minified | Gzip | Cold import | Gate |
| --- | ---: | ---: | ---: | --- |
| Runtime entry `okmodel` | 5,525 | 2,042 | 1.929 ms | 6,100 / 2,250 bytes, CI cold import 25 ms |
| App startup (10 tables, one find) | 85,568 | 28,329 | 11.493 ms | 87,454 / 28,857 bytes (D160). Cold import is printed, not gated |
| App startup, `postgres` stubbed | | | 5.188 ms | local reference 15 ms, not gated |
| App total graph, lazy chunks included | 134,967 | 43,508 | | printed, not gated |
| `okmodel/pg` barrel | 69,510 | 21,840 | 3.310 ms | printed, not gated |
| Connect `okmodel/pg/postgresjs` startup | 40,270 | 13,929 | 9.075 ms | 41,519 / 14,352 (D160). Cold import printed, not gated |
| Connect postgres.js, driver stubbed | | | 2.720 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pglite` startup | 37,496 | 13,214 | 11.201 ms | 38,620 / 13,613 (D160). Cold import printed, not gated |
| Connect PGlite, driver stubbed | | | 3.875 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pg` startup | 40,464 | 14,112 | 12.150 ms | 41,677 / 14,543 (D160). Cold import printed, not gated |
| Connect `okmodel/pg/pg`, driver stubbed | | | 3.046 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/bun` startup | 39,365 | 13,683 | | 40,545 / 14,096 (D160). Node cold import skipped: Bun.sql runs only on Bun |
| Connect Bun.sql, driver stubbed | | | 2.764 ms | local reference 15 ms, not gated |
| Install size (`dist/`) | 712,327 bytes unminified | | | printed, not gated |

Adapter entries, driver included, are printed and not gated on cold import: postgres.js 8.782 ms, PGlite 10.552 ms. Their minified bytes that are not already in the runtime entry are gated: postgres.js 13,620 of 15,093, PGlite 9,753 of 12,010.

Moving `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders to `okmodel/internal` changed the runtime entry from 24,426 / 8,584 to 5,525 / 2,042. The runtime-entry gate is that measurement plus 10 percent (6,100 / 2,250). Taking `compileColumn`, `emitRowTypes`, `mapPostgresError`, and the operator tag helpers off `okmodel/pg` changed that barrel from 70,059 / 21,873 to 62,063 / 19,409. The app startup graph stayed 77,537 / 25,625. Connect startup graphs stayed 37,952 / 13,158 and 36,330 / 12,862. The internal entry is not on the application import path.

The app startup graph is 2.2% under its minified ceiling and 1.8% under its gzip ceiling. The gates stay at the D160 numbers. An application that uses `timestamps()` measures 88,273 / 29,144 on the same fixture; that figure is not a gate (D163).

First find on the local sample was 0.452 ms. First include was 1.175 ms. Those are one run of `scripts/query-latency.ts`, printed by the size script, and they are not a gate.
