# Size and cold start

Numbers are from `bun run size` (`scripts/size.ts`) on this release commit. CI job `check` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `bun run check`, which runs that script. Cold import is the median of five fresh Node processes (D134). The failing cold-import gate is 25 ms, and it applies to the runtime entry only. A local sample above 15 ms is printed and does not fail the script.

Byte gates fail in that CI job. Install size is the unminified `dist/` and is printed, not gated.

| Graph | Minified | Gzip | Cold import | Gate |
| --- | ---: | ---: | ---: | --- |
| Runtime entry `okmodel` | 5,525 | 2,042 | 1.758 ms | 6,100 / 2,250 bytes, CI cold import 25 ms |
| App startup (10 tables, one find) | 77,537 | 25,625 | 9.922 ms | 84,500 / 27,500 bytes (D157). Cold import is printed, not gated |
| App startup, `postgres` stubbed | | | 4.101 ms | local reference 15 ms, not gated |
| App total graph, lazy chunks included | 112,033 | 36,204 | | printed, not gated |
| `okmodel/pg` barrel | 62,063 | 19,409 | 3.100 ms | printed, not gated |
| Connect `okmodel/pg/postgresjs` startup | 37,952 | 13,158 | 8.364 ms | 40,100 / 13,815 (D157). Cold import printed, not gated |
| Connect postgres.js, driver stubbed | | | 2.526 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pglite` startup | 36,330 | 12,861 | 10.794 ms | 38,146 / 13,505. Cold import printed, not gated |
| Connect PGlite, driver stubbed | | | 2.666 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pg` startup | 38,732 | 13,516 | | 40,000 / 13,950 (D157). Cold import printed, not gated |
| Connect `okmodel/pg/bun` startup | 37,633 | 13,086 | | 38,900 / 13,500 (D157). Node cold import skipped: Bun.sql runs only on Bun |
| Install size (`dist/`) | 555,786 bytes unminified | | | printed, not gated |

Adapter entries, driver included, are printed and not gated on cold import: postgres.js 8.563 ms, PGlite 10.090 ms. Their minified bytes that are not already in the runtime entry are gated: postgres.js 12,074 of 15,093, PGlite 9,608 of 12,010.

Moving `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders to `okmodel/internal` changed the runtime entry from 24,426 / 8,584 to 5,525 / 2,042. The runtime-entry gate is that measurement plus 10 percent (6,100 / 2,250). Taking `compileColumn`, `emitRowTypes`, `mapPostgresError`, and the operator tag helpers off `okmodel/pg` changed that barrel from 70,059 / 21,873 to 62,063 / 19,409. The app startup graph stayed 77,537 / 25,625. Connect startup graphs stayed 37,952 / 13,158 and 36,330 / 12,862. The internal entry is not on the application import path.

The app startup graph is 2.9% under its minified ceiling and 3.0% under its gzip ceiling.

First find on the local sample was 0.425 ms. First include was 0.800 ms. Those are one run of `scripts/query-latency.ts`, printed by the size script, and they are not a gate.
