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

An automatic read chooses one eligible replica. The stages stay separate: every replica, then health (a closed circuit), then consistency and lag (a no-op until P63), then capacity, then `routing.select`. The default is `"weighted"`, smooth weighted round-robin on the topology handle. Equal weights rotate in the order they were configured. `weight` must be a positive number. `0` is OKM1120, so `weighted` only sees positive weights.

`roundRobin` ignores weights and rotates through the eligible replicas. `leastConnections` sends the read to the replica with the fewest statements this router already has in flight. A tie stays in config order. The count is the router's, not `stats().inflight`. `latencyAware` sends the read to the lowest moving average of round-trip time (alpha 0.2). Successful reads and the health probe both feed it. The first sample is kept as itself. A replica with no sample loses to one that has one. Ties stay in config order.

```ts
routing: { select: "roundRobin" }
routing: { select: "leastConnections" }
routing: { select: "latencyAware" }
routing: {
  select(candidates, ctx) {
    // candidates: { name, weight, inflight, latencyMs, lag }
    // ctx: { op: "read" }
    return candidates[0] ?? "east";
  },
}
```

A function must return one of the candidate objects it was given, or that candidate's `name`. Anything else is OKM1120 and the message names the return value. A throw is not replaced with OKM1120. The function runs only when an automatic read has two or more candidates. `route: "replica"` and `using("replica")` do not call it.

A replica is saturated when it was given a `max` and `stats()` reports no idle connection, at least one waiter, and `size` at or above that max. An automatic read skips it. If every healthy replica is saturated, the read uses the primary and the reason is `fallback:saturated`, or OKM1844 when `fallback` is `"error"`. `route: "replica"` and `using("replica")` ignore capacity and wait for a connection.

A successful write on that connect, including one through `reserve()` and through `for()`, keeps later reads on the primary until P63. `route: "primary"` or `"replica"` on a read forces the endpoint. `db.using("primary" | "replica")` returns a client that forces one route. That client has no `close` and no `using`. Only the root closes the pools, and that close stops the probes. `onRoute` receives `{ op, endpoint, reason }`. A throw from it is ignored. Reasons include `auto:<name>` and `fallback:saturated`. `routing.fallback` is `"primary"` or `"error"`. `consistency` and `maxLag` throw OKM1061. `inspect()` reports `single-endpoint`. Routing reasons in `inspect()` are the M2 dev inspector. A string or a pool serves either `route` from its one endpoint and has no `using`. A shape this module does not accept throws OKM1120. One connection failure retries the read once, with the same strategy, over the replicas that remain.

Each replica is probed in the background. The default interval is one second (`"1s"`, `"500ms"`, `"1m"`, or a positive number of milliseconds). The probe is `SELECT 1` plus a replay position. Two failures in a row open that replica's circuit. The next wait is `probe * 2^min(max(failures - 1, 1), 8)`, and it never exceeds 30 seconds. A success closes the circuit and stores the position. The timers are unref'd, and `close()` clears them and closes every pool this connect opened.

`replication.position` is detected per endpoint at connect and stored. Routing does not read it yet. Tests pass `replicaState` so the position comes from an independent database instead of `pg_last_wal_replay_lsn()`.

Migrations do not resolve a replica. A `database` or `targets` value that carries `primary`, `replicas`, `weight`, or `pool` is OKM1845.

The router, `using`, `onRoute`, and selection stay in the lazy topology chunk (D203). The connect entries carry the `route` key only (D202). The gates do not move. Commit positions are P63. Streaming replication in CI is P64.

The design this implements, and the routing rules that are not built yet, are §15.1 of the [API design](okmodel-api-design.md#151-topology-routing-and-consistency).
