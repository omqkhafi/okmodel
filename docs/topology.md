# Topology

`connect({ primary, replicas }, options)` opens one pool per endpoint. The first argument is still a string or an existing pool, and that path does not load this code. A topology returns a promise on every driver. PGlite already returned a promise for a string.

```ts
import { connect } from "okmodel/pg/postgresjs";

export const db = await connect(
  {
    primary: process.env.DATABASE_URL!,
    replicas: [{ url: process.env.REPLICA_URL!, weight: 2, name: "east", pool: { max: 4 } }],
  },
  { schema: app, max: 10, routing: { probe: "1s" } },
);
```

`max` is the default pool size. A replica's `pool.max` overrides it for that endpoint. The primary is named `primary`. It is not `replica-0`. A replica with no name is `replica-1`, `replica-2`, and so on. A URL replica has weight 1.

An automatic read chooses one eligible replica. The stages stay separate: every replica, then health (a closed circuit), then consistency and lag, then capacity, then `routing.select`. The default is `"weighted"`, smooth weighted round-robin on the topology handle. Equal weights rotate in the order they were configured. `weight` must be a positive number. `0` is OKM1120, so `weighted` only sees positive weights.

`roundRobin` ignores weights and rotates through the eligible replicas. `leastConnections` sends the read to the replica with the fewest statements this router already has in flight. A tie stays in config order. The count is the router's, not `stats().inflight`. `latencyAware` sends the read to the lowest moving average of round-trip time (alpha 0.2). Successful reads and the health probe both feed it. The first sample is kept as itself. A replica with no sample loses to one that has one. Ties stay in config order.

```ts
routing: { select: "roundRobin" }
routing: { select: "leastConnections" }
routing: { select: "latencyAware" }
routing: {
  select(candidates, ctx) {
    // candidates: { name, weight, inflight, latencyMs, lag }
    // lag is bytes behind the primary, or null when unknown
    // ctx: { op: "read" }
    return candidates[0] ?? "east";
  },
}
```

A function must return one of the candidate objects it was given, or that candidate's `name`. Anything else is OKM1120 and the message names the return value. A throw is not replaced with OKM1120. The function runs only when an automatic read has two or more candidates. `route: "replica"` and `using("replica")` do not call it.

A replica is saturated when it was given a `max` and `stats()` reports no idle connection, at least one waiter, and `size` at or above that max. An automatic read skips it. If every healthy replica is saturated, the read uses the primary and the reason is `fallback:saturated`, or OKM1844 when `fallback` is `"error"`. `route: "replica"` and `using("replica")` ignore capacity and wait for a connection.

A successful write on that connect moves one watermark shared by the root, `for()`, `unscoped()`, `using()`, and `reserve()`. A later read uses a replica whose replay position has reached that watermark. `routing.consistency` is `"session"` (the default) or `"eventual"`. `"eventual"` keeps no watermark. `routing.maxLag` is `"5s"`, `"500ms"`, `"2m"`, `"16MB"`, `"512KB"`, `"1GB"`, or `"4096B"`. A bare number is OKM1120. `route: "primary"` or `"replica"` on a read forces the endpoint. `route: "replica"` and `using("replica")` still require the watermark and `maxLag`, and they never fall back to the primary (OKM1843). `db.using("primary" | "replica")` returns a client that forces one route. That client has no `close` and no `using`. Only the root closes the pools, and that close stops the probes. `onRoute` receives `{ op, endpoint, reason }`. A throw from it is ignored. Reasons include `auto:<name>`, `fallback:behind`, `fallback:position-unknown`, `fallback:saturated`, `fallback:unhealthy`, and `fallback:no-replicas`. `behind` means healthy replicas exist and none satisfies the watermark or `maxLag`. `routing.fallback` is `"primary"` or `"error"`. `inspect()` reports `single-endpoint`. Routing reasons in `inspect()` are the M2 dev inspector. A string or a pool serves either `route` from its one endpoint and has no `using`. A shape this module does not accept throws OKM1120. One connection failure retries the read once, with the same strategy, over the replicas that remain.

When replicas are configured and consistency is `"session"`, the write's promise waits for one extra round trip: `pg_current_wal_insert_lsn()` on the primary pool after an autocommit `execute` or `batch`, and on the reserved connection after a successful `COMMIT`. A rollback does not read it. The position is compared as an integer from the `X/Y` hex form and never moves backwards. If that read fails, the handle is position-unknown: automatic reads use the primary (`fallback:position-unknown`, or OKM1844 when `fallback` is `"error"`) until a later write or a primary probe reads a position. A replica may serve from the last position a probe or an earlier check already saw. If that value is behind the watermark or outside `maxLag`, one on-demand replay check runs, then the next candidate. A caught-up replica has lag zero, including while the primary is idle. `maxLag` in time uses the replica's replay timestamp only while its replay position is behind the primary. A replica or a primary without `replication.position` cannot be checked: after a write, automatic reads use the primary and a required replica is OKM1843. A read with no write yet and no `maxLag` still uses replicas. `"eventual"` needs positions only for `maxLag`.

A watermark per `for()` client is deferred. The router cannot tell which client issued a statement, and teaching it that would add bytes to `client.ts`. Carrying the position across processes stays deferred (spec section 25).

Each replica is probed in the background. The default interval is one second (`"1s"`, `"500ms"`, `"1m"`, or a positive number of milliseconds). The probe is `SELECT 1` plus a replay position. When `maxLag` is a duration, the replica probe also reads `pg_last_xact_replay_timestamp()`. The primary is probed on the same interval when a watermark or `maxLag` needs its insert position. Two failures in a row open that replica's circuit. The next wait is `probe * 2^min(max(failures - 1, 1), 8)`, and it never exceeds 30 seconds. A success closes the circuit and stores the position. A primary probe failure does not open a circuit. The timers are unref'd, and `close()` clears them and closes every pool this connect opened.

`replication.position` is detected per endpoint at connect and stored. Routing uses it for the watermark and for `maxLag`. Tests pass `replicaState` so the position comes from an independent database instead of `pg_last_wal_replay_lsn()`. The on-demand check uses that same seam.

Migrations do not resolve a replica. A `database` or `targets` value that carries `primary`, `replicas`, `weight`, or `pool` is OKM1845.

The router, `using`, `onRoute`, selection, and commit positions stay in the lazy topology chunk (D203, D204, D205). The connect entries carry the `route` key only (D202). The gates do not move.

## Conformance

The CI topology is the compose file `packages/harness/docker/compose.yml`: one primary and two hot standbys (`replica-a`, `replica-b`). `bun run db:up` starts it. `bun test tests/topology-conformance.test.ts` runs the suite against that topology. The Postgres job already starts the same compose project, and `scripts/postgres-suite.ts` picks the file up with the rest of the suite. It is not listed in `POSTGRES_EXCLUSIONS`.

The named tests are `routing.auto`, `routing.classes`, `routing.strict`, `pool.separation`, `tx.affinity`, and `consistency.position`. Selection and health (`selection.weighted`, `selection.weighted-return`, `selection.leastConnections`, `selection.latencyAware`, `selection.maxLag`, `selection.health`, `selection.failure`, `selection.custom`, `selection.primary-fallback`) run on the same primary and replicas. `pool.separation: PGlite reserve` uses in-memory databases. The suite waits on replay positions, circuits, and caught-up reads.

Measured in CI on this topology, 40 inserts after 3 warmup. The extra cost is the session sample's percentile minus the eventual sample's percentile.

- Postgres 15: p50 0.24 ms (session 0.92 ms, eventual 0.68 ms), p95 0.36 ms (session 1.16 ms, eventual 0.80 ms).
- Postgres 18: p50 0.19 ms (session 0.90 ms, eventual 0.71 ms), p95 −0.48 ms (session 0.98 ms, eventual 1.46 ms). The negative p95 is the two samples' percentiles, so one slow eventual insert moves it.
- Fallback rate with `consistency: "session"`. One writer inserts 20 rows as fast as it can while two find loops run. Replicas are replaying and are not paused. Postgres 15: 0 of 24 reads in 29 ms. Postgres 18: 0 of 27 reads in 30 ms. A local sample before that was 1 of 24 (0.042) over 15 ms.
- Replica read share under a read-heavy mix, 8 rounds of 1 write and 8 reads: 64 of 64 reads used a replica on Postgres 15 and on Postgres 18.

With weights 5 and 1, one pick while the lighter replica is out, then 24 reads together, the sequence is `abaaaaabaaaaabaaaaabaaaa` (20 of the heavier replica, 4 of the lighter, first read on the heavier). The same schedule before `current` was cleared for a replica that sat the pick out was `baaaaabaaaaabaaaaabaaaaa` (the same 20 and 4, first read on the lighter). D205.

The design this implements, and the routing rules that are not built yet, are §15.1 of the [API design](okmodel-api-design.md#151-topology-routing-and-consistency).
