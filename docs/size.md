# Size and cold start

Numbers are from `bun run size` (`scripts/size.ts`) on this release commit. CI job `check` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `bun run check`, which runs that script. Cold import is the median of five fresh Node processes (D134). The failing cold-import gate is 25 ms, and it applies to the runtime entry only. A local sample above 15 ms is printed and does not fail the script.

Byte gates fail in that CI job. Install size is the unminified `dist/` and is printed, not gated.

| Graph | Minified | Gzip | Cold import | Gate |
| --- | ---: | ---: | ---: | --- |
| Runtime entry `okmodel` | 5,190 | 1,996 | 1.832 ms | 6,100 / 2,250 bytes, CI cold import 25 ms |
| App startup (10 tables, one find) | 83,043 | 27,666 | 11.154 ms | 85,500 / 28,490 bytes (D164). Cold import is printed, not gated |
| App startup, `postgres` stubbed | | | 5.619 ms | local reference 15 ms, not gated |
| App total graph, lazy chunks included | 135,071 | 43,745 | | printed, not gated |
| `okmodel/pg` barrel | 68,985 | 21,787 | 3.210 ms | printed, not gated |
| Connect `okmodel/pg/postgresjs` startup | 37,842 | 13,289 | 8.523 ms | 38,970 / 13,680 (D164). Cold import printed, not gated |
| Connect postgres.js, driver stubbed | | | 2.751 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pglite` startup | 35,545 | 12,675 | 10.916 ms | 36,600 / 13,050 (D164). Cold import printed, not gated |
| Connect PGlite, driver stubbed | | | 2.764 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pg` startup | 38,511 | 13,596 | 11.538 ms | 39,660 / 14,000 (D164). Cold import printed, not gated |
| Connect `okmodel/pg/pg`, driver stubbed | | | 2.811 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/bun` startup | 37,412 | 13,158 | | 38,530 / 13,550 (D164). Node cold import skipped: Bun.sql runs only on Bun |
| Connect Bun.sql, driver stubbed | | | 2.749 ms | local reference 15 ms, not gated |
| Install size (`dist/`) | 716,504 bytes unminified | | | printed, not gated |

Adapter entries, driver included, are printed and not gated on cold import: postgres.js 8.989 ms, PGlite 10.344 ms. Their minified bytes that are not already in the runtime entry are gated: postgres.js 14,089 of 15,093, PGlite 9,821 of 12,010.

Moving `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders to `okmodel/internal` changed the runtime entry from 24,426 / 8,584 to 5,525 / 2,042. The runtime-entry gate is that measurement plus 10 percent (6,100 / 2,250). Taking `compileColumn`, `emitRowTypes`, `mapPostgresError`, and the operator tag helpers off `okmodel/pg` changed that barrel from 70,059 / 21,873 to 62,063 / 19,409. The app startup graph stayed 77,537 / 25,625. Connect startup graphs stayed 37,952 / 13,158 and 36,330 / 12,862. The internal entry is not on the application import path.

The app startup graph is 2.9% under its minified ceiling and 2.9% under its gzip ceiling. The gates are the size-audit measurement plus 3 percent (D164). An application that uses `timestamps()` measures 85,744 / 28,503 on the same fixture; that figure is not a gate (D163). Under the 0.2 cap of 91,000 / 30,000 the no-trait graph has 7,957 minified bytes and 2,334 gzip left.

First find on the local sample was 0.484 ms. First include was 1.008 ms. Those are one run of `scripts/query-latency.ts`, printed by the size script, and they are not a gate.
