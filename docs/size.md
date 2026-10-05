# Size and cold start

Numbers are from `bun run size` (`scripts/size.ts`) on this release commit. CI job `check` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `bun run check`, which runs that script. Cold import is the median of five fresh Node processes (D134). The failing cold-import gate is 25 ms, and it applies to the runtime entry only. A local sample above 15 ms is printed and does not fail the script.

Byte gates fail in that CI job. Install size is the unminified `dist/` and is printed, not gated.

| Graph | Minified | Gzip | Cold import | Gate |
| --- | ---: | ---: | ---: | --- |
| Runtime entry `okmodel` | 5,288 | 2,026 | 1.714 ms | 6,100 / 2,250 bytes, CI cold import 25 ms |
| App startup (10 tables, one find) | 88,723 | 29,553 | 10.705 ms | 90,900 / 30,000 bytes (D160, P27; P27b adds 115 / 60, D178; P28 adds 330 / 168, D180). Cold import is printed, not gated |
| App startup, `postgres` stubbed | | | 5.367 ms | local reference 15 ms, not gated |
| App total graph, lazy chunks included | 153,167 | 50,426 | | printed, not gated |
| `okmodel/pg` barrel | 74,380 | 23,591 | 3.566 ms | printed, not gated |
| Connect `okmodel/pg/postgresjs` startup | 40,695 | 14,390 | 8.542 ms | 41,600 / 14,600 (D160, P27). Cold import printed, not gated |
| Connect postgres.js, driver stubbed | | | 2.823 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pglite` startup | 38,455 | 13,763 | 11.052 ms | 39,300 / 13,980 (D160, P27). Cold import printed, not gated |
| Connect PGlite, driver stubbed | | | 3.063 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/pg` startup | 41,419 | 14,668 | 11.424 ms | 42,400 / 14,920 (D160, P27). Cold import printed, not gated |
| Connect `okmodel/pg/pg`, driver stubbed | | | 2.924 ms | local reference 15 ms, not gated |
| Connect `okmodel/pg/bun` startup | 40,320 | 14,243 | | 41,200 / 14,470 (D160, P27). Node cold import skipped: Bun.sql runs only on Bun |
| Connect Bun.sql, driver stubbed | | | 2.743 ms | local reference 15 ms, not gated |
| Install size (`dist/`) | 916,858 bytes unminified | | | printed, not gated |

Adapter entries, driver included, are printed and not gated on cold import: postgres.js 7.965 ms, PGlite 10.351 ms. Their minified bytes that are not already in the runtime entry are gated: postgres.js 14,089 of 15,093, PGlite 9,821 of 12,010.

Moving `sha256`, `throwNamed`, `nearestName`, `catalogError`, and the catalog builders to `okmodel/internal` changed the runtime entry from 24,426 / 8,584 to 5,525 / 2,042. The runtime-entry gate is that measurement plus 10 percent (6,100 / 2,250). Taking `compileColumn`, `emitRowTypes`, `mapPostgresError`, and the operator tag helpers off `okmodel/pg` changed that barrel from 70,059 / 21,873 to 62,063 / 19,409. The app startup graph stayed 77,537 / 25,625. Connect startup graphs stayed 37,952 / 13,158 and 36,330 / 12,862. The internal entry is not on the application import path.

The app startup graph is 2.4% under its minified ceiling and 1.5% under its gzip ceiling. The gates are the P27 measurement plus 3 percent (D160, D176), and the gzip gate is the 30,000 cap. An application that uses `timestamps()` measures 85,744 / 28,503 on the earlier fixture; that figure is not a gate (D163). An application that uses column tenancy measures 91,802 / 30,411 (D167), and one that uses `archivable()` measures 97,043 / 31,980 at startup and 166,847 / 54,183 with lazy chunks (D170). An application that validates measures 93,423 / 31,055. An application that uses `manyThrough`, `page`, and `aggregate` measures 90,145 / 29,994 at startup and 152,522 / 50,184 with lazy chunks. None of those is a gate. The `manyThrough` resolver and emitter travel with the relation, so they sit in the startup graph of an app that declares one; the `page` and `aggregate` planners are lazy chunks (3,502 and 3,974 bytes). An application that declares presets pays for the dispatch already counted in the featureless graph and loads the preset chunk (a lazy chunk) on its first preset call; it is not a gate. Under the 0.2 cap of 91,000 / 30,000 the featureless graph has 2,277 minified bytes and 447 gzip left.

First find on the local sample was 0.532 ms. First include was 1.019 ms. Those are one run of `scripts/query-latency.ts`, printed by the size script, and they are not a gate.
