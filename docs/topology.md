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

Reads use the first replica whose circuit is closed, in the order they were configured. A successful write on that connect, including one through `reserve()` and through `for()`, keeps later reads on the primary until P63. `route: "primary"` or `"replica"` on a read forces the endpoint. `db.using("primary" | "replica")` returns a client that forces one route. That client has no `close` and no `using`. Only the root closes the pools, and that close stops the probes. `onRoute` receives `{ op, endpoint, reason }`. A throw from it is ignored. `routing.fallback` is `"primary"` or `"error"`. `routing.select`, `consistency`, and `maxLag` throw OKM1061. `inspect()` reports `single-endpoint`. Routing reasons in `inspect()` are the M2 dev inspector. A string or a pool serves either `route` from its one endpoint and has no `using`. A shape this module does not accept throws OKM1120.

Each replica is probed in the background. The default interval is one second (`"1s"`, `"500ms"`, `"1m"`, or a positive number of milliseconds). The probe is `SELECT 1` plus a replay position. Two failures in a row open that replica's circuit. The next wait is `probe * 2^min(max(failures - 1, 1), 8)`, and it never exceeds 30 seconds. A success closes the circuit and stores the position. The timers are unref'd, and `close()` clears them and closes every pool this connect opened.

`replication.position` is detected per endpoint at connect and stored. Routing does not read it yet. Tests pass `replicaState` so the position comes from an independent database instead of `pg_last_wal_replay_lsn()`.

Migrations do not resolve a replica. A `database` or `targets` value that carries `primary`, `replicas`, `weight`, or `pool` is OKM1845.

The router, `using`, and `onRoute` stay in the lazy topology chunk. The connect entries carry the `route` key only (D202). That is the exception to D201's stop line, and the gates do not move. Selection is P62. Commit positions are P63. Streaming replication in CI is P64.

The design this implements, and the routing rules that are not built yet, are §15.1 of the [API design](okmodel-api-design.md#151-topology-routing-and-consistency).
