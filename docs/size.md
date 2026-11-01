# Size and cold start

Numbers are from `bun run size` ([`scripts/size.ts`](../scripts/size.ts)). Gates live in that script; do not copy them from memory. CI runs the same check. Cold import is the median of five fresh Node processes (D134). The failing cold-import gate is 25 ms on the runtime entry only. A local sample above 15 ms is printed and does not fail the script.

The gated bytes are the static startup graph: every relative dynamic `import()` is an empty module. The reference rows are the full `bun build`, printed and not gated. The runtime entry has no dynamic import, so its gate is the single-file build. Adapter incremental bytes are still the full adapter build; lazy adapter chunks count (D245). Those adapter gates are 17,000 and 12,700. Byte gates fail in CI. Install size is the unminified `dist/` and is printed, not gated.

Sample on `d528978` (P101):

| Graph | Minified | Gzip | Cold import | Gate |
| --- | ---: | ---: | ---: | --- |
| Runtime entry `okmodel` | 5,288 | 2,026 | 7.032 ms | 6,100 / 2,250 bytes, CI cold import 25 ms. No dynamic import |
| App startup (10 tables, one find) | 90,823 | 29,432 | | 90,900 / 30,170 bytes. Dynamic imports stubbed |
| App startup, full build (reference) | 92,526 | 30,822 | 36.341 ms | not gated. Driver stubbed cold import 17.925 ms |
| Connect `okmodel/pg/postgresjs` startup | 40,236 | 14,028 | | 42,450 / 14,920. Dynamic imports stubbed |
| Connect postgres.js, full build (reference) | 42,940 | 15,178 | 23.631 ms | not gated. Driver stubbed cold import 6.808 ms |
| Connect `okmodel/pg/pglite` startup | 38,650 | 13,433 | | 40,450 / 14,280. Dynamic imports stubbed |
| Connect PGlite, full build (reference) | 41,245 | 14,568 | 29.431 ms | not gated. Driver stubbed cold import 8.615 ms |
| Connect `okmodel/pg/pg` startup | 40,195 | 13,984 | | 42,850 / 15,070. Dynamic imports stubbed |
| Connect `okmodel/pg/pg`, full build (reference) | 42,857 | 15,116 | 48.879 ms | not gated. Driver stubbed cold import 8.134 ms |
| Connect `okmodel/pg/bun` startup | 39,822 | 13,861 | | 41,700 / 14,620. Dynamic imports stubbed. Node cold import skipped: Bun.sql runs only on Bun |
| Connect Bun.sql, full build (reference) | 43,033 | 15,163 | | not gated. Driver stubbed cold import 7.601 ms |

Earlier measurement dumps and the 2026-10-21 size audit live in git history.
