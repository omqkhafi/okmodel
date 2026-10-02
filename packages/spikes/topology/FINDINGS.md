# Topology spike findings

Question: on one primary and two hot standbys, can reads go to a replica while primary-required work stays on the primary, and does `pg_current_wal_insert_lsn()` after commit give a watermark that never lets a later read see older data?

Server: Postgres 17 from the compose topology (ports 55432–55434). Timings are one run on this machine. They are not a baseline.

## Recommendation

The commit-position mechanism is confirmed. The watermark is `pg_current_wal_insert_lsn()` read after commit, on the committing connection. `pg_current_wal_lsn()` is unsafe when `synchronous_commit` is off, and the insert LSN read before `COMMIT` is the start of the commit record.

Section 15.1 should change one phrase. It says an in-transaction reading is "below the commit record". On this server that reading is the start LSN of the commit record (delta 0). A replay position at that LSN has not applied the commit. The after-commit insert LSN is past the record. The spec was not edited.

## What worked

- Automatic reads used an eligible replica. Writes, batches, locking reads, advisory locks, and user transactions stayed on the primary. A property test sent no primary-required SQL to either replica.
- `.replica()` never returned the primary. With no healthy, caught-up replica it failed as OKM1843. `.primary()` stayed on the primary. `.replica()` on a primary-required operation failed as OKM1840 before any SQL.
- An internal read-only transaction (`BEGIN READ ONLY`) ran on a replica.
- Health, `maxLag`, and the session watermark filtered before selection. Strategies covered weighted, round-robin, least connections, latency, random, and a custom function. `fallback: "error"` was OKM1844.
- Each endpoint has its own pool. One transaction kept one connection. A full pool failed as OKM1846 and did not borrow from another endpoint. A transport failure before any result re-routed once, and a strict replica read did not then use the primary.
- After commit, the insert LSN was past the end of the commit record for a single insert, three inserts in one transaction, a batch, and `synchronous_commit` on and off. The commit record was 34 bytes. The insert LSN was 40 bytes past its start (6 bytes past the record, MAXALIGN).
- With both replicas paused, 20 reads after an update all returned the new row from the primary. After one replica resumed and caught the watermark, 10 reads returned the new row from that replica. Violations: 0. A strict `.replica()` while both were behind was OKM1843.
- A failed position read left the commit in place and marked the session position-unknown. The next read used the primary. The next successful position read cleared the flag.
- Revoking `EXECUTE` from `PUBLIC` and connecting the replicas as a non-superuser made the position probe fail while `SELECT 1` still worked. After a write, automatic reads used the primary (`fallback:position-unknown`) and `.replica()` was OKM1843. The grants were restored.
- `for(id)` kept its own watermark. `unscoped()` shared the root. The replay cache did not move backward. A caught-up replica reported 0 byte lag and 0 time lag while `pg_last_xact_replay_timestamp()` was 159ms old.
- Eventual consistency, and a client with no replicas, sent no position statement.

## What the WAL showed

`pg_waldump` on the primary, same transaction id as `pg_current_xact_id()` inside the transaction.

| Shape                               | Commit record                      | Insert LSN after commit               | In-transaction insert LSN         | `pg_current_wal_lsn()`            |
| ----------------------------------- | ---------------------------------- | ------------------------------------- | --------------------------------- | --------------------------------- |
| Single insert, sync on              | 34 bytes at the in-transaction LSN | 40 bytes past the start               | equal to the record start         | past the record                   |
| Three inserts, sync on              | 34 bytes                           | 40 bytes past the start               | equal to the record start         | past the record                   |
| Batch watermark                     | 34 bytes                           | 40 bytes past the start               | not read after the adapter commit | not compared                      |
| `synchronous_commit` off, 7 samples | 34 bytes                           | 40 bytes past the start, every sample | equal to the record start         | behind the commit record on all 7 |

The in-transaction insert LSN is too early: it is the first byte of the commit record. The after-commit insert LSN is safe on every sample here. It is conservative by 6 bytes of alignment when nothing else writes WAL before the position read, and by more when other records land first.

`pg_current_wal_lsn()` matched the insert LSN when `synchronous_commit` was on. With it off, that function was still at an older record on all 7 samples while the insert LSN was already past the commit. Using it as the watermark would be too early.

Replay on replica `a` was paused across one commit. Its replay LSN stayed at the pre-commit position, behind the commit record. After resume, a 400ms poll never saw a replay LSN inside the 40-byte gap (`sawGap: false`). The replica jumped over it. The paused reading is the evidence the watermark is ahead of a replica that has not applied the commit.

## Classification

| Item                                                                                                                      | Class                            | Evidence                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| In-transaction insert LSN equals the commit-record start. Section 15.1 says "below the commit record".                    | contradiction                    | Delta 0 on every sample. The record is 34 bytes and starts at that LSN. The spec was not edited.                                                                                                                                     |
| `pg_current_wal_lsn()` under `synchronous_commit` off sits before the commit record                                       | bug if used as the watermark     | 7 of 7 sync-off samples. The insert LSN was past the record on the same round trip.                                                                                                                                                  |
| postgres.js adapter holds one mutex for the whole pool, so a second checkout waits until the first connection is released | bug                              | A position sample that acquired a second primary connection while still holding the first failed as OKM1846 after 2000ms. The spike semaphore would have allowed it. Pool tests use `max: 1` and still show per-endpoint exhaustion. |
| `connection.batch()` inside an open SQL transaction commits the outer transaction                                         | bug                              | The spike runs batches inside `tx()` as savepoints (`okm_sp_N`). The adapter batch is `BEGIN`/`COMMIT`.                                                                                                                              |
| Position read is a second round trip after `COMMIT`, not pipelined with it                                                | performance                      | One `pg_current_wal_insert_lsn` per committed write. Spec section 15.1 says the extra statement is pipelined. This adapter sends one statement at a time.                                                                            |
| Prompt names `random` and `least-loaded`; section 15.1 names `leastConnections` and `latencyAware`                        | DX                               | `least-loaded` is `leastConnections`. `random` is implemented as well. `latencyAware` follows the spec.                                                                                                                              |
| `PUBLIC` can execute the position functions on this image                                                                 | missing capability is still real | `has_function_privilege` is true for `PUBLIC`. The probe still reports the capability missing when `EXECUTE` is revoked and the replica login is not a superuser.                                                                    |

## Measurements

| Measurement                                                              | Result                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Routing decision, 5000 calls                                             | mean 0.367µs, p99 1.208µs                                                                   |
| Pool acquire, idle checkout, 20 each                                     | primary mean 3.292µs p99 10.083µs; replica a 2.927µs / 8.083µs; replica b 2.323µs / 5.125µs |
| Fallback rate, both replicas paused, 20 reads                            | 1 (all primary)                                                                             |
| Fallback rate after one replica caught the watermark, 10 reads           | 0 (all that replica)                                                                        |
| On-demand replay queries while both replicas were behind                 | 2 per read (40 across 20 reads)                                                             |
| On-demand replay queries once a cached replica was caught up             | 0                                                                                           |
| Extra statements per committed write                                     | 1 `pg_current_wal_insert_lsn`                                                               |
| Extra statements per write with `consistency: "eventual"` or no replicas | 0                                                                                           |
| First read after a write (cache cold)                                    | 1 replay query, 0.648ms for the whole read                                                  |
| Next read (cache hit)                                                    | 0 replay queries, 0.164ms for the whole read                                                |
| Read-your-writes violations                                              | 0                                                                                           |
| Commit record vs after-commit insert LSN                                 | record 34 bytes, insert LSN 40 bytes past the start                                         |
| Idle primary time lag on a caught-up replica                             | 0ms, while the replay timestamp was 159ms old                                               |

## Not in this spike

Invariants G, H, I, and J (targets, plans, batch atomicity, provisioning) belong to later prompts. Carrying a session watermark across processes is out of scope. `latencyAware` is covered by the pure selector tests, not by injected network delay on the live replicas.
