# Driver spike findings

Question: can one driver contract and one capability registry be honest across postgres.js 3.4.9 and PGlite 0.5.8, and does atomic `batch` mean the same thing on both?

Server versions from the conformance run: Postgres 17.11 (Docker primary) and PGlite 18.3. The compatibility table is `COMPATIBILITY.md`, rendered from `results.json`. Timings below are one run on this machine. They are not a baseline.

## Recommendation

Yes for the contract, if capabilities are data and every declared flag has a conformance test. postgres.js can declare interactive transactions, stream, listen, cancel, describe, and prepared `named` / `unnamed` / `none`. PGlite can declare interactive transactions, listen, describe, and prepared `unnamed` / `none`. It cannot declare `cancel`. A batch-mode harness can declare `transactions: "batch"`, `cancel`, and prepared `none`, and must not expose `reserve` or `tx`.

Atomic `batch` means the same thing for commit, rollback, failure index, deferred constraints at commit, sequences, and a savepoint inside `tx()`. It does not mean the same thing for cancellation: PGlite cannot abort an in-flight statement, and it does not enforce `statement_timeout`. The batch-mode harness is not a native HTTP batch. It is `BEGIN` … `COMMIT` on postgres.js with `reserve` and `tx` hidden. That matches the public surface the prompt asked for. It does not exercise the spec's "request already sent" path.

## What worked

- One `DriverPool` shape (`execute`, required `batch`, `stats`, `close`, and `reserve` / `tx` / `stream` / `listen` / `describe` only when declared) ran the same suite on all three adapters. Undeclared cases skip with a stable reason. `assertRegistryLinked` fails if a declared capability has no test id in the suite.
- Wire text for int, bigint, numeric, boolean, timestamptz, jsonb, and arrays matched on both drivers after the postgres.js serializers were overridden. Unique violations expose `sqlstate`, `constraint`, and `table`. Notices arrive on both.
- postgres.js `cancel()` aborts `pg_sleep` with SQLSTATE 57014. The same `pg_backend_pid()` accepts the next statement. A pre-aborted `AbortSignal` fails before the statement starts, on both drivers, and the insert does not land.
- Named prepares show up in `pg_prepared_statements` (a `BEFORE INSERT` trigger reads the view). Unnamed extended statements do not: `current_query()` contains `$1` and the view is `<none>`. Simple protocol inlines the literal. PGlite `query()` is unnamed extended; `exec()` is simple. There is no named prepare API.
- `batch` commits in order, rolls back a failure at index 0, 1, or 2, reports a deferred constraint failure at commit with `batchIndex` null, leaves a sequence advanced, and on an interactive driver uses a savepoint so the outer transaction keeps the rows outside the failed batch.
- Killing the backend with `pg_terminate_backend` during `pg_sleep` inside the batch rejects as `outcome_unknown`. A later `SELECT 1` on the pool succeeds. The probed row count was 0. The driver still does not claim a rollback.

## What differs

- PGlite runs the statement on the JavaScript thread. `AbortSignal` cannot interrupt it. `statement_timeout` is stored (`SHOW` returns the value) and not enforced. `cancel` stays false. The timeout case on PGlite is a locked negative: `pg_sleep(0.35)` after `statement_timeout` 40ms took 352ms.
- postgres.js `unsafe()` defaults to `prepare: false`, and to the simple protocol when there are no parameters, even when the connection was opened with `prepare: true`. The connection flag is ANDed with the per-call flag. The adapter passes `{ prepare, simple }` on every call. Without that, `prepared: "named"` would be a lie.
- postgres.js serializes parameters with JavaScript types. Boolean `serialize` is `value === true ? "t" : "f"`, so the wire text `"t"` is sent as `f`. JSON and date serializers rewrite wire text too. The adapter replaces those serializers with identity functions. Codecs stay in the dialect only if the adapter refuses this rewrite.
- A multi-statement simple query returns one result (the last command). Ordered batch results need one protocol message per statement.
- Queuing `COMMIT` and later statements before the first await, then killing the backend, makes postgres.js throw `TypeError: null is not an object (evaluating 'socket.write')` from a `setImmediate` outside the query promise. The atomic batch therefore runs one statement at a time and does not send `ROLLBACK` after connection loss. The dead reserved connection is not checked back in.
- Neither adapter clears session state on release. `set_config('okm.p06', 'yes', false)` was still visible on the next checkout (`sessionLeaked: yes` on postgres.js and on PGlite).
- postgres.js does not expose pool counters. `stats()` is the adapter's: `size` is the configured max (4), not the number of live sockets.
- The batch-mode adapter can cancel, because it sits on postgres.js. An HTTP driver that has already sent the request would report `outcome_unknown` instead. This harness does not model that. `outcome_unknown` here is the killed backend.

## Classification

| Item                                                                                  | Class              | Evidence                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PGlite cannot cancel an in-flight statement and does not enforce `statement_timeout`  | missing capability | `pg_sleep(0.35)` took 352ms after `statement_timeout` 40ms. `cancel` is not declared. Pre-abort before the call still rejects.                                                                                                                                                                                |
| postgres.js `unsafe` ignores the connection `prepare` flag unless the call repeats it | DX                 | Named prepares were invisible until the call passed `{ prepare: true, simple: false }`. Connection `prepare: false` makes a per-call `prepare: true` a no-op (`options.prepare && query.prepare`).                                                                                                            |
| postgres.js rewrites wire-text parameters in its serializers                          | DX                 | Boolean `"t"` was stored as false until serialize was overridden. The spec says values cross as wire text and codecs live in the dialect.                                                                                                                                                                     |
| Unnamed extended statements do not appear in `pg_prepared_statements`                 | DX                 | The trigger saw `<none>` and `current_query()` containing `$1`. Named statements appear with a non-empty name. Simple protocol shows the quoted literal.                                                                                                                                                      |
| postgres.js throws off-promise if a write is queued after `pg_terminate_backend`      | bug                | `socket.write` of null in `connection.js` `nextWrite`. The batch does not pipeline, so the suite does not hit it. A pipelined commit did.                                                                                                                                                                     |
| Kind for a timeout is `timeout` in the error table and `cancelled` for a batch        | contradiction      | Error table lists `timeout` (transient) and does not list `cancelled`. Section 15 says an aborted call fails as `cancelled`, and the batch paragraph says a timeout on a driver that can cancel is `cancelled`. This spike uses `timeout` for `execute` and `cancelled` for `batch`. The spec was not edited. |
| Deferred constraint failure has `batchIndex` null                                     | contradiction      | Section 15 says the failing statement's error carries `batchIndex`. The failure is `COMMIT` (SQLSTATE 23505), which is not one of the caller's statements. The suite records null.                                                                                                                            |
| No session reset when a connection is released                                        | bug                | Both adapters left `okm.p06=yes` visible after `release`.                                                                                                                                                                                                                                                     |
| postgres.js has no `stats()`                                                          | missing capability | Adapter counters. `size` stays at the configured max after a backend is killed.                                                                                                                                                                                                                               |
| Batch-mode harness is `BEGIN`/`COMMIT`, not a native atomic batch, and it can cancel  | missing capability | The public surface has no `reserve` or `tx`. It does not model "HTTP request already sent → `outcome_unknown`". Neon is not in this spike.                                                                                                                                                                    |
| Atomic batch sends N+2 statements and does not pipeline                               | performance        | 8 statements plus `BEGIN` and `COMMIT` is 10 protocol messages. Mean 1.794ms on postgres.js. A raw pipeline of 8 `SELECT 1` with no transaction was 0.607ms.                                                                                                                                                  |

## Measurements

Cancel and timeout are the range of two conformance runs. Batch and pipeline figures are a 20-sample run against the same primary. Overhead is from a conformance run (30 samples after 5 warmup calls).

| Measurement                                  | postgres.js                                         | PGlite                                             | batch-mode                                      |
| -------------------------------------------- | --------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| `execute` cancel of `pg_sleep(8)`            | 33–36ms, same backend pid                           | not declared                                       | 33–34ms, pool accepted the next statement       |
| `execute` timeout budget 80ms                | 84–94ms, kind `timeout`                             | not enforced (352ms for a 350ms sleep)             | 84–85ms, kind `timeout`                         |
| `batch` cancel                               | 44–45ms, table empty, kind `cancelled`              | not declared                                       | 43ms                                            |
| `batch` timeout budget 80ms                  | 86–88ms, kind `cancelled`                           | not declared                                       | 84–85ms                                         |
| `pg_terminate_backend` mid-batch             | 9–13ms, kind `outcome_unknown`, observed rows 0     | no separate backend                                | 9–10ms, kind `outcome_unknown`, observed rows 0 |
| `batch` of 8 `SELECT 1`                      | 1.794ms mean, p99 2.645ms, 10 statements            | 1.319ms mean, p99 3.359ms, 10 statements           | 2.199ms mean, p99 9.128ms                       |
| 8 sequential `execute("SELECT 1")`           | 1.230ms mean                                        | 1.062ms mean                                       | 1ms in the coarse conformance log               |
| Raw pipeline of 8 `SELECT 1`, no transaction | 0.607ms mean, p99 1.085ms                           | n/a                                                | n/a                                             |
| `SELECT 1` overhead, mean                    | adapter 175µs, raw client 270µs (p99 332µs / 396µs) | adapter 62µs, raw `query` 58µs (adapter p99 112µs) | not separated from postgres.js                  |

The wrapper did not add a round trip. On this run the postgres.js adapter was faster than a fresh raw client (175µs vs 270µs), and the PGlite adapter was 4µs slower than `query()` (62µs vs 58µs). A second conformance run was 209µs vs 256µs and 63µs vs 60µs. That is noise next to a local call.

## Not honest yet

`prepared: "named"` on postgres.js is honest only because the adapter forces the per-call options and undoes the serializers. Shipping the driver without those two overrides would make the flag and the wire-text rule false.

`stats().size` is the configured pool size. It is not the number of connected sockets.

The batch-mode adapter's `cancel: true` is honest for this process. It would be a lie for an HTTP driver that cannot abort after send.
