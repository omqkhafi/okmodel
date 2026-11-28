# Notes

The sections below are the tail of `okmodel-decisions.md`, unchanged.

## Neon conformance notes

Addendum to D269. These rows are postgres.js and node-postgres pointed at Neon endpoints, from the channel-binding audit on [#291](https://github.com/omqkhafi/okmodel/pull/291). They are not the `okm driver test neon` result, which was 64 pass, 0 fail, and 18 unsupported. `select 1` succeeded for postgres.js, node-postgres, Neon HTTP, and Neon WebSocket on primary and primary pool. The audit did not mention `channel_binding`. Those drivers were not changed.

| Driver | Endpoint | Pass | Fail | Unsupported |
| --- | --- | ---: | ---: | ---: |
| postgres.js | primary | 7 | 75 | 0 |
| postgres.js | primary pool | 7 | 75 | 0 |
| node-postgres | primary | 77 | 4 | 1 |
| node-postgres | primary pool | 4 | 77 | 1 |

postgres.js on both endpoints starts failing at `wire.execute-returns-rows`, and the rest of the wire cases fail after that. Cause: unclassified.

node-postgres on primary fails `wire.acquire-timeout-is-okm1846-and-does-not-use-another-pool`, `tx.tx-signal-cancels-the-transaction-and-rolls-it-back`, `r2.commit-loss`, and `r2.batch-commit-loss`. Cause of each: unclassified. The unsupported case is not named. Which case: unclassified.

node-postgres on the primary pool fails the same way postgres.js does, from `wire.execute-returns-rows`. Cause: unclassified. The unsupported case is not named. Which case: unclassified.

node-postgres prints a warning that `sslmode=require` is treated as `verify-full`. The audit does not establish that warning as the cause of a failure.

The audit names primary and primary pool only. It does not report these two drivers against r1 or r2.

Two postgres.js observations are recorded in D263 and repeated in D264. They are notes for a possible upstream report. They are not filed issues, and they are not established as the cause of the rows above. `fetchArrayTypes` can reject with no handler when the backend dies during connect: `ReadyForQuery` returns that call with no `.catch()`. A queued `sql.reserve()` can be dropped without settling when a connection slot closes. okmodel starts that reserve again.

Gates after P67 (D210). Minified / gzip.

| Graph | D209 measured | P67 measured | Old gate | New gate |
|---|---:|---:|---:|---|
| Runtime entry | 5,288 / 2,026 | 5,288 / 2,026 | 6,100 / 2,250 | unchanged |
| Featureless app | 89,751 / 29,801 | 90,535 / 30,026 | 90,900 / 30,000 | 90,900 / 30,030 |
| postgres.js | 41,137 / 14,502 | 41,918 / 14,746 | 41,600 / 14,600 | 41,950 / 14,750 |
| PGlite | 39,135 / 13,889 | 39,929 / 14,119 | 39,300 / 13,980 | 40,000 / 14,130 |
| node-postgres | 41,547 / 14,672 | 42,331 / 14,904 | 42,400 / 14,920 | unchanged |
| Bun.sql | 40,395 / 14,183 | 41,179 / 14,440 | 41,200 / 14,470 | unchanged |

Gates after P69 (D214). Minified / gzip. The cap is D210 plus +800 / +250 for each connect graph.

| Graph | D210 base | P69 measured | Old gate | New gate |
|---|---:|---:|---:|---|
| Runtime entry | 5,288 / 2,026 | 5,288 / 2,026 | 6,100 / 2,250 | unchanged |
| Featureless app | 90,535 / 30,026 | 90,848 / 30,147 | 90,900 / 30,030 | 90,900 / 30,170 |
| postgres.js | 41,918 / 14,746 | 42,382 / 14,898 | 41,950 / 14,750 | 42,450 / 14,920 |
| PGlite | 39,929 / 14,119 | 40,393 / 14,257 | 40,000 / 14,130 | 40,450 / 14,280 |
| node-postgres | 42,331 / 14,904 | 42,795 / 15,048 | 42,400 / 14,920 | 42,850 / 15,070 |
| Bun.sql | 41,179 / 14,440 | 41,643 / 14,592 | 41,200 / 14,470 | 41,700 / 14,620 |

Adapter increments stay under their gates: postgres.js 14,869 (gate 15,093) and PGlite 10,489 (gate 12,010).

## Appendix: M0 findings resolved by decisions

M0-01, M0-34 → D117; M0-08, M0-09, M0-12 → D120; M0-14, M0-15 → D125; M0-16, M0-17, M0-18 → D126; M0-28, M0-29, M0-30, M0-54 → D124; M0-40, M0-41, M0-47 → D118; M0-42, M0-45, M0-48 → D119; M0-51, M0-55 → D121; M0-58, M0-59, M0-63 → D122; M0-61, M0-62 → D123; budgets and cold start → D127.
