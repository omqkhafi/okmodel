# Known limits

These builders and options throw OKM1061, or are not methods yet. The version is the release train in [`okmodel-execution-plan.md`](okmodel-execution-plan.md). `later` means the plan has not assigned a 0.x release.

`okmodel/internal` has no stability promise. Names on that subpath can change or disappear in any release. Its exports are marked `@internal`.

| Item | Version | Prompt |
| --- | --- | --- |
| `t.domain` | 0.3 | P40 |
| extensions | 0.3 | P40 |
| functions | 0.3 | P41 |
| triggers | 0.3 | P41 |
| views | 0.3 | P42 |
| `reference` | 0.4 | P53A |
| `okmodel/testing` | 0.4 | P54 |
| `morph` | later | M2 |
| `computed` | later | no 0.x prompt |
| `policies` | later | no 0.x prompt |

`.hidden()` stays out of default selects and includes. `.sensitive()` redacts values in logs, errors, and `inspect()`.

`one()`, `many()` and `manyThrough()` work. A relation value that is not one of those throws OKM1061.

An `interval` that mixes signs, such as `1 day -01:00:00`, cannot be one `Temporal.Duration`, so a read that selects it fails with OKM1210. The decoders take the default `IntervalStyle` (`postgres`) and ISO-8601; `sql_standard` and `postgres_verbose` output is not read. A `timetz` with a seconds offset such as `+05:30:15` is OKM1210 (D179).

`iStartsWith`, `iContains` and `iEndsWith` are not in 0.2 (D176). Use `ilike()` with an escaped pattern. `aggregate()` has no `having` and no `bucket` (M2). `sum` and `avg` over a `text` column pass the types and fail when the call runs (OKM1124), because the row types cannot tell a `numeric` string from a `text` string.

Installing the head snapshot, snapshot-versus-replay equivalence (OKM1521), and `reference` rows arrive in P53A. In 0.1, `okm migrate apply` replays migration files. See [environments](environments.md).

A postgres.js pool opened with `ssl` still uses the driver's socket and its 30 s idle timer (D152). Measured on Postgres 17 with TLS 1.3, one query, and no `close()`: the process exited in 30.10 s on Bun and 30.07 s on Node 26. A plain pool (no `ssl`) exits on its own. `close()` or `await using` releases a TLS pool without waiting.

node-postgres sets `allowExitOnIdle` and `idleTimeoutMillis: 0`. A plain pool exits after the last query, and an idle connection stays open while the process is alive. The same unref applies to the TLS stream `pg` uses after the handshake. This tree has no TLS server, so that path is unread. `pg` cannot describe a statement without running it. That conformance case is skipped.

Bun.sql keeps `idleTimeout` at 0, which is Bun's default (no idle timer). A finished Bun script exits without `close()`. `Query.cancel()` does not abort the backend statement on Bun 1.4, and Bun.sql does not surface `RAISE NOTICE`. Those conformance cases are skipped. Bun.sql also cannot describe a statement without running it. `okmodel/pg/bun` loads only on Bun.

A unique that a trait adds after the tenancy rewrite is not widened (D168). `columnTenancy().rewrite()` runs first and widens uniques the table already declared. Trait `apply` runs after that, so a unique introduced by the trait stays on the trait's columns only. `timestamps()` adds no unique. `archivable()` adds no unique either: it turns uniques that already exist into partial unique indexes (`WHERE archived_at IS NULL`) after the rewrite, so a tenant unique stays `(tenant key, column)` with that predicate. The primary key stays a full constraint.
