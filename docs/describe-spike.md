# Describe spike (F7a)

Typed `raw()` needs, per statement and without executing it: parameter type OIDs, result column names, result type OIDs, and for each result column the source table OID and attribute number. Today's `DescribeResult` is only `columns: string[]` and `parameterCount`. postgres.js and PGlite implement `describe`. `pg`, Bun.sql, and Neon do not.

This is a measurement, not a design change. Nothing under `src/` moved. The scripts are [packages/spikes/describe/run.ts](../packages/spikes/describe/run.ts). The raw numbers are [packages/spikes/describe/results.json](../packages/spikes/describe/results.json).

## What was run

| Piece | Version |
| --- | --- |
| Postgres | 15.19, 16.15, 17.11, 18.6 (Debian images) |
| PGlite | 0.5.8, bundled PostgreSQL 18.3 |
| PgBouncer | 1.26.1 (`edoburu/pgbouncer` v1.26.1-p0), `pool_mode=transaction`, `default_pool_size=1`, in front of each major |
| postgres.js | 3.4.9, pool opened with `prepare: false` (the adapter's default) |
| node-postgres | 8.23.1 |
| Bun.sql | Bun 1.4.2 |
| Neon WebSocket | `@neondatabase/serverless` 1.2.0, bytes copied by a local WebSocket-to-TCP bridge |
| Neon HTTP | not run |

`NEON_URL` was unset, so there was no Neon host. The WebSocket driver was pointed at local Postgres through a bridge that does not parse the protocol. Neon's own pooler was not on the path.

Every describe is an unnamed Parse, a statement Describe, and Sync. No Bind and no Execute. A `plpgsql` function that inserts into `spike.log` was described and the log stayed empty. The same function was executed once during setup, then the log was cleared, so the side effect is real. `INSERT` did not add a row. `CREATE TABLE` did not create the table.

The four Postgres majors and the four PgBouncer fronts agreed on every statement. PGlite agreed on shape (OIDs of user types differ, as they must). Driver output matched the built-in client with zero mismatches wherever the driver can describe.

## Matrix

Route is `public` (a documented method), `internal` (an undocumented hook that worked), `not possible`, or `untested`.

| Adapter | Servers | Parameter OIDs | Column names | Column type OIDs | Table OID + attnum |
| --- | --- | --- | --- | --- | --- |
| postgres.js | 15, 16, 17, 18, and each through PgBouncer | public | public | public | public |
| node-postgres | 15, 16, 17, 18, and each through PgBouncer | internal | internal | internal | internal |
| Bun.sql | 15, 16, 17, 18, and each through PgBouncer | not possible | not possible | not possible | not possible |
| PGlite | bundled 18.3 only | public | public | public | public |
| Neon WebSocket | 15, 16, 17, 18, and each through PgBouncer, via a local bridge | internal | internal | internal | internal |
| Neon HTTP | 15, 16, 17, 18 | untested | untested | untested | untested |

postgres.js `PendingQuery.describe()` returns `types` and `columns[].name`, `type`, `table`, `number`. That is the whole set. It still describes when the connection was opened with `prepare: false`, because `.describe()` forces an unnamed Parse.

node-postgres `client.query()` always Binds and Executes. The package exports no describe. `query` accepts an object with a `submit` function (the hook `pg-cursor` uses). That function can send `Connection.parse`, `describe({ type: "S" })`, and `sync`. The `rowDescription` fields are `name`, `tableID`, `columnID`, `dataTypeID`. The same hook works on the Neon WebSocket client, which subclasses node-postgres. Treat both as private. A release can remove the hook.

Bun.sql `SQL.Query` exposes `cancel`, `simple`, `execute`, `raw`, and `values`. A reserved connection adds pool methods (`unsafe`, `begin`, `transaction`, …) and no describe. There is nothing to call that does not run the statement.

PGlite `describeQuery` returns parameter OIDs and result fields whose keys are `name`, `dataTypeID`, and `parser`. It drops table OID and attnum. `protocol.serialize` plus `execProtocol` is also public and returns the full `RowDescription`, including `tableID` and `columnID`. The adapter's `describe` today uses `describeQuery`, so it does not yet surface table OID or attnum. The protocol path does, and it did not execute.

Neon HTTP exports `query`, `unsafe`, and `transaction`. Every call POSTs the SQL to Neon's `/sql` endpoint. This run had no Neon host, so the cell stays untested. The client has no describe method to call.

## Provider order for `okm check`

1. The project driver, when it can describe without executing and can return all four fields. Today that is postgres.js `.describe()`. For PGlite it is `execProtocol`, not `describeQuery`.
2. Otherwise a built-in extended-protocol client on one direct connection. That is the fallback for node-postgres, Bun.sql, and Neon. Do not adopt the `submit` hook as the supported path.

Cost on this machine, minimum of five warm describes of `SELECT id, name FROM spike.item WHERE id = $1`, and three fresh connections for the built-in client. Not a gate.

| Path | Time |
| --- | --- |
| Built-in client, connection already open | 0.05–0.10 ms |
| Built-in client, new connection, SCRAM, then one describe | 2.95–3.26 ms direct; 1.25–1.32 ms through the local PgBouncer |
| postgres.js `.describe()` on an open pool | 0.10–0.19 ms |
| PGlite `execProtocol` | 0.05 ms |

The check should describe on a connection it already holds. Opening a new connection is one handshake plus one round trip. PgBouncer 1.26.1 in transaction mode accepted unnamed Parse, Describe, and Sync on all four majors, did not execute, and reused one backend (`pg_backend_pid()` matched across two connections, pool size 1). Direct connections got a new pid each time.

The built-in client is [packages/spikes/describe/protocol.ts](../packages/spikes/describe/protocol.ts). No dependency beyond `node:net` and `node:crypto`.

| Measure | Bytes |
| --- | ---: |
| Source | 13,812 |
| Source gzip | 4,099 |
| Minified (`bun build --minify --target node`) | 5,694 |
| Minified gzip | 2,188 |

It fits a tooling subpath as a lazy module. It does not fit the runtime entry: that gate is 6,100 minified and 2,250 gzip, and this file would spend almost all of it. Tooling stays off `src/contracts/index.ts`. The sample speaks trust, cleartext, MD5, and SCRAM-SHA-256. It does not negotiate TLS. A host that requires SSL needs that before this client can be the fallback, and TLS would add bytes.

## What typed `raw()` may rely on

- Parameter OIDs from `ParameterDescription`, in `$1` order.
- Result name, type OID, table OID, and attnum from `RowDescription`. Table OID 0 and attnum 0 mean the output is not a simple column reference.
- The server refuses more than one command in a Parse (`42601`, `cannot insert multiple commands into a prepared statement`). A trailing semicolon is still one command.
- A statement that fails to plan returns `ErrorResponse` from Parse and does not run. `SELECT * FROM spike.missing` is `42P01`.
- A statement that fails only at execution still describes. `SELECT 1/0` came back as `int4`. `INSERT` of NULL into a `NOT NULL` column described as NoData. Neither ran.
- `SELECT *` expands to the base columns with table OID and attnum set.
- `INSERT … RETURNING id, name` keeps those columns' table OID and attnum. `name || '!'` has table OID 0.
- User type OIDs are not stable and need `pg_type`. The lookup that was run is `TYPE_LOOKUP_SQL` in [packages/spikes/describe/nullability.ts](../packages/spikes/describe/nullability.ts). `typtype` is `e` enum, `c` composite, `d` domain, `r` range. `typcategory` `A` is an array (`_text` oid 1009, `typelem` 25). `int4range` is oid 3904.
- A domain column's `RowDescription` type OID is the base type (`int4`, 23), not the domain. `pg_attribute.atttypid` is the domain. An explicit cast `$5::spike.pos` puts the domain OID on the parameter and the base type OID on the result column. `WHERE pos = $1` infers the parameter as `int4`, not the domain.
- `SELECT $1` does not error on 15 through 18 or on PGlite. The parameter OID is `text` (25). `SELECT $1 + 1` infers `int4` (23). Describe does not leave an unknown OID. `PREPARE s AS SELECT $1` also succeeds on 17.11. Refusing an uncast parameter takes a SQL parse in the checker. The server will not do it.

## What it must not rely on

- The current `DescribeResult`. Names and a parameter count cannot type a column or prove nullability.
- Bun.sql, or a public `query()` on node-postgres or Neon. Those run the statement. Neon HTTP was not executed here.
- The `submit` hook as a stable API.
- Table OID plus `attnotnull` as proof that the result column is NOT NULL.

`anything not proven NOT NULL is nullable` still holds, and the wire description is not enough to prove it for an arbitrary statement.

Executed proof, same database the describe read:

| Statement | RowDescription | A row that came back |
| --- | --- | --- |
| `item LEFT JOIN other` | `other.id` is NOT NULL (`attnotnull`) | `('b', null)` |
| `item RIGHT JOIN other` | `item.name` is NOT NULL | `(null, '2')` |
| CTE of that left join, then `SELECT id` | still `other.id`, attnum 1 | the join can null it |
| `UNION ALL` | table OID 0 | not a column reference |
| `SELECT` from a view of `id, name` | table OID is the view, `relkind` `v`, `attnotnull` false | the base `name` is NOT NULL and the view column is not proven |
| `RETURNING name \|\| '!'` | table OID 0 | expression |
| `doubled int GENERATED ALWAYS AS (score * 2) STORED` | base column, `attgenerated` `s`, `attnotnull` false | stored generated is not proof |
| `checked int CHECK (checked IS NOT NULL)` | `attnotnull` false | a check is not proof |

A simple CTE and a simple subquery of `SELECT id, name FROM spike.item` also keep `item`'s OID. A non-zero table OID does not mean "this was a single-table select". Outer joins, views, and CTEs are not visible as a flag on `RowDescription`.

## Nullability query

`$1` is the table OID. `$2` is `attnum`. This is the query that was run.

```sql
SELECT
  a.attnotnull,
  a.attidentity,
  a.attgenerated,
  a.atttypid,
  t.typname,
  t.typtype,
  t.typnotnull AS domain_not_null,
  t.typbasetype,
  c.relkind,
  c.relname,
  n.nspname
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE a.attrelid = $1::oid
  AND a.attnum = $2::int
  AND a.attisdropped = false
```

PostgreSQL 18 stores NOT NULL as `pg_constraint` (`contype` `n`). 15 through 17 accept the comparison and return no rows.

```sql
SELECT c.oid, c.conname, c.convalidated, pg_get_constraintdef(c.oid) AS def
FROM pg_constraint c
WHERE c.conrelid = $1::oid
  AND c.contype = 'n'
  AND c.conkey = ARRAY[$2::int]::int2[]
```

Catalog proof for a base column (`relkind` `r` or `p`), before any join is considered:

- `attidentity` is `a` or `d`, or
- the type is a domain and `typnotnull` is true, or
- on 15–17, `attnotnull` is true, or
- on 18, a `contype = 'n'` row for that attribute has `convalidated` true.

On 18.6, `ALTER TABLE spike.item ADD CONSTRAINT item_note_nn NOT NULL note NOT VALID` was accepted. `attnotnull` became true and `convalidated` was false. The same statement is a syntax error on 15, 16, and 17. After the read, the constraint was dropped. `attnotnull` alone is the wrong flag on 18.

Identity `id` is proven on every version (`attidentity` `a`). Domain `pos` is proven only through `typnotnull` (`attnotnull` is false). `name` and `score` are `attnotnull` on every version. On 18 those columns also have a validated not-null constraint (`item_name_not_null`, `item_score_not_null`), and the primary key on `other.id` does too.

That catalog proof is still not a result-nullability proof. Use it only for a statement the checker can see is a single base relation with no outer join, no `UNION`, no view, and no CTE or subquery that could hide one. Otherwise the column stays nullable.

## Open risks

- Neon HTTP was not run. The client has no describe method; a live `/sql` call was not made.
- Neon WebSocket was not run against a Neon host or Neon's pooler. The local bridge shows the client can issue Parse and Describe. It does not show what Neon's proxy does with that exchange.
- PgBouncer older than 1.21, and `max_prepared_statements = 0`, were not tested. 1.26.1 with the default of 200 accepted the unnamed statement. Named prepares were not sent.
- Describe success is not execution success. `SELECT 1/0` describes.
- A bare `$1` becomes `text`. An API that wants to reject it cannot learn that from the OID.
- `RowDescription` type OID is the domain's base type. The domain OID is `atttypid`.
- A NOT VALID not-null constraint on 18 sets `attnotnull` before the scan has passed.
- The built-in client has no TLS, no GSS, and no certificate authentication.
- PGlite's current adapter `describe` stops at `describeQuery` and will not satisfy typed `raw()` until it keeps `tableID` and `columnID`.
