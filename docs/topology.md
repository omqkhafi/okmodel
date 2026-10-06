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

Until P61 every operation uses the primary, including reads. `inspect()` reports `single-endpoint`. `routing.select`, `consistency`, `fallback`, and `maxLag` throw OKM1061. A shape this module does not accept throws OKM1120.

Each replica is probed in the background. The default interval is one second (`"1s"`, `"500ms"`, `"1m"`, or a positive number of milliseconds). The probe is `SELECT 1` plus a replay position. Two failures in a row open that replica's circuit. The next wait is `probe * 2^min(max(failures - 1, 1), 8)`, and it never exceeds 30 seconds. A success closes the circuit and stores the position. The timers are unref'd, and `close()` clears them and closes every pool this connect opened.

`replication.position` is detected per endpoint at connect and stored. Routing does not read it yet. Tests pass `replicaState` so the position comes from an independent database instead of `pg_last_wal_replay_lsn()`.

Migrations do not resolve a replica. A `database` or `targets` value that carries `primary`, `replicas`, `weight`, or `pool` is OKM1845.

P61, P62, and P63 (routing, selection, consistency) stay in the lazy topology chunk. They do not add bytes to the connect entries (D201). Streaming replication in CI is P64.

The design this implements, and the routing rules that are not built yet, are §15.1 of the [API design](okmodel-api-design.md#151-topology-routing-and-consistency).
