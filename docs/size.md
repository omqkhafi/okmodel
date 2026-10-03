# Size and cold start

Numbers are from `bun run size` (`scripts/size.ts`) on this release commit. CI job `check` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `bun run check`, which runs that script. Cold import is the median of five fresh Node processes (D134). The failing cold-import gate is 25 ms, and it applies to the runtime entry only. A local sample above 15 ms is printed and does not fail the script.

Byte gates fail in that CI job. Install size is the unminified `dist/` and is printed, not gated.

| Graph | Minified | Gzip | Cold import | Gate |
| --- | ---: | ---: | ---: | --- |
| Runtime entry `okmodel` | 5,525 | 2,042 | 1.792 ms | 6,100 / 2,250 bytes, CI cold import 25 ms |
| App startup (10 tables, one find) | 77,537 | 25,625 | 9.681 ms | 79,849 / 26,410 bytes. Cold import is printed, not gated |
| App startup, `postgres` stubbed | | | 4.193 ms | local reference 15 ms, not gated |
| App total graph, lazy chunks included | 112,014 | 36,207 | | printed, not gated |
| `okmodel/pg` barrel | 62,063 | 19,409 | 3.074 ms | printed, not gated |
| Connect `okmodel/pg/postgresjs` startup | 37,952 | 13,158 | 8.080 ms | 39,849 / 13,815. Cold import printed, not gated |
| Connect postgres.js, driver stubbed | | | 2.592 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pglite` startup | 36,330 | 12,862 | 10.496 ms | 38,146 / 13,505. Cold import printed, not gated |
| Connect PGlite, driver stubbed | | | 2.691 ms | local reference 15 ms, not gated |
| Install size (`dist/`) | 555,770 bytes unminified | | | printed, not gated |

Adapter entries, driver included, are printed and not gated on cold import: postgres.js 8.040 ms, PGlite 10.106 ms. Their minified bytes that are not already in the runtime entry are gated: postgres.js 12,074 of 15,093, PGlite 9,608 of 12,010.

Moving `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders to `okmodel/internal` changed the runtime entry from 24,426 / 8,584 to 5,525 / 2,042. The runtime-entry gate is that measurement plus 10 percent (6,100 / 2,250). Taking `compileColumn`, `emitRowTypes`, `mapPostgresError`, and the operator tag helpers off `okmodel/pg` changed that barrel from 70,059 / 21,873 to 62,063 / 19,409. The app startup graph stayed 77,537 / 25,625. Connect startup graphs stayed 37,952 / 13,158 and 36,330 / 12,862. The internal entry is not on the application import path.

The app startup graph is 2.9% under its minified ceiling and 3.0% under its gzip ceiling.

First find on the local sample was 0.415 ms. First include was 0.776 ms. Those are one run of `scripts/query-latency.ts`, printed by the size script, and they are not a gate.
