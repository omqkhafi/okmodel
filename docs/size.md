# Size and cold start

Numbers are from `bun run size` (`scripts/size.ts`) on this release commit. CI job `check` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `bun run check`, which runs that script. Cold import is the median of five fresh Node processes (D134). The failing cold-import gate is 25 ms, and it applies to the runtime entry only. A local sample above 15 ms is printed and does not fail the script.

Byte gates fail in that CI job. Install size is the unminified `dist/` and is printed, not gated.

| Graph | Minified | Gzip | Cold import | Gate |
| --- | ---: | ---: | ---: | --- |
| Runtime entry `okmodel` | 5,190 | 1,996 | 1.726 ms | 6,100 / 2,250 bytes, CI cold import 25 ms |
| App startup (10 tables, one find) | 87,148 | 28,938 | 10.962 ms | 87,900 / 29,210 bytes (D160). Cold import is printed, not gated |
| App startup, `postgres` stubbed | | | 5.851 ms | local reference 15 ms, not gated |
| App total graph, lazy chunks included | 139,805 | 45,280 | | printed, not gated |
| `okmodel/pg` barrel | 71,270 | 22,425 | 3.314 ms | printed, not gated |
| Connect `okmodel/pg/postgresjs` startup | 39,641 | 13,895 | 8.186 ms | 40,200 / 14,090 (D160). Cold import printed, not gated |
| Connect postgres.js, driver stubbed | | | 2.699 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pglite` startup | 37,350 | 13,263 | 11.048 ms | 37,800 / 13,450 (D160). Cold import printed, not gated |
| Connect PGlite, driver stubbed | | | 2.794 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pg` startup | 40,316 | 14,178 | 11.457 ms | 40,900 / 14,410 (D160). Cold import printed, not gated |
| Connect `okmodel/pg/pg`, driver stubbed | | | 2.901 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/bun` startup | 39,217 | 13,741 | | 39,700 / 13,940 (D160). Node cold import skipped: Bun.sql runs only on Bun |
| Connect Bun.sql, driver stubbed | | | 2.718 ms | local reference 15 ms, not gated |
| Install size (`dist/`) | 793,284 bytes unminified | | | printed, not gated |

Adapter entries, driver included, are printed and not gated on cold import: postgres.js 8.222 ms, PGlite 10.391 ms. Their minified bytes that are not already in the runtime entry are gated: postgres.js 14,089 of 15,093, PGlite 9,821 of 12,010.

Moving `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders to `okmodel/internal` changed the runtime entry from 24,426 / 8,584 to 5,525 / 2,042. The runtime-entry gate is that measurement plus 10 percent (6,100 / 2,250). Taking `compileColumn`, `emitRowTypes`, `mapPostgresError`, and the operator tag helpers off `okmodel/pg` changed that barrel from 70,059 / 21,873 to 62,063 / 19,409. The app startup graph stayed 77,537 / 25,625. Connect startup graphs stayed 37,952 / 13,158 and 36,330 / 12,862. The internal entry is not on the application import path.

The app startup graph is 0.9% under its minified ceiling and 0.9% under its gzip ceiling. The gates stay at the P24 measurement plus 3 percent (D160, D170). An application that uses `timestamps()` measures 85,744 / 28,503 on the same fixture; that figure is not a gate (D163). An application that uses column tenancy measures 91,802 / 30,411; that figure is not a gate (D167). An application that uses `archivable()` measures 95,725 / 31,604 at startup and 155,844 / 50,118 with lazy chunks; that figure is not a gate (D170). Under the 0.2 cap of 91,000 / 30,000 the featureless graph has 3,852 minified bytes and 1,062 gzip left.

First find on the local sample was 0.491 ms. First include was 1.048 ms. Those are one run of `scripts/query-latency.ts`, printed by the size script, and they are not a gate.
