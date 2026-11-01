# postgres.js kill-storm uncaught exceptions (B-02)

**Upstream.** Not an OKModel adapter queueing bug. A kill storm against
postgres.js alone raises the same uncaught `TypeError` and unhandled
rejections. The adapter cannot stop `connection.js` `nextWrite` from calling
`socket.write` after `closed()` has set `socket` to `null`.

| Field        | Value                                                                 |
| ------------ | --------------------------------------------------------------------- |
| Issue        | [#363](https://github.com/omqkhafi/okmodel/issues/363) (B-02)         |
| Driver       | [postgres.js](https://github.com/porsager/postgres) **3.4.9**         |
| Symptom      | Uncaught `TypeError` from `nextWrite`; unhandled `CONNECTION_CLOSED` / 57P01 |
| OKModel path | `okmodel/pg/postgresjs`                                               |
| Recommendation | Prefer `okmodel/pg/pg` or `okmodel/pg/bun` where backend failover or kill storms are expected |

## What happens

During concurrent queries, `pg_terminate_backend` on the app role closes the
TCP socket. postgres.js clears a pending write timer in `closed()`, then sets
`socket = null`. A write that was already scheduled (or queued after the fatal
`ErrorResponse`) still runs `nextWrite`, which evaluates `socket.write` and
throws outside the query promise:

- Bun: `TypeError: null is not an object (evaluating 'socket.write')`
- Node: `TypeError: Cannot read properties of null (reading 'write')`

Unhandled rejections also appear (`write CONNECTION_CLOSED`,
`terminating connection due to administrator command` / SQLSTATE `57P01`).

The reserved-connection `onclose` / `lost` guard in the OKModel adapter stops
*our* later statements from scheduling a write after the socket is gone. It
does not stop postgres.js from scheduling its own `nextWrite`. Routing every
call through `reserve()` does not remove the crash. A process-level
`uncaughtException` listener (D294) can keep the process alive and rebuild the
pool; it does **not** eliminate the exception. Process-level handling is not a
fix.

`pg` (node-postgres) and Bun.sql show 0 uncaught under the same storm shape.

## Evidence (this tree, Postgres 17 topology)

Raw postgres.js only (`docs/postgresjs-kill-storm.mjs`, no OKModel):

| Runtime | Runs | Total crash events | Clean runs |
| ------- | ---- | ------------------ | ---------- |
| Bun     | 5    | 20                 | 0 / 5      |
| Node 22 | 5    | 20                 | 0 / 5      |

OKModel `okmodel/pg/postgresjs` under the same storm (counting every
`uncaughtException` / `unhandledRejection`, including those the adapter
listener swallows):

| Runtime | Runs | Total events | `socket.write` | Clean runs |
| ------- | ---- | ------------ | -------------- | ---------- |
| Bun     | 5    | 152          | 124            | 0 / 5      |
| Node 22 | 3    | 102          | 90             | 0 / 3      |

Reserve-only adapter traffic (every call `reserve` → `execute` → `release`)
still produced 121 `socket.write` uncaught in a single 3 s Bun run.

## Reproduction

Needs a reachable Postgres URL (the local topology is fine:
`postgres://okm:okm@127.0.0.1:55432/okm` after `bun run db:up`).

```bash
DATABASE_URL=postgres://okm:okm@127.0.0.1:55432/okm bun docs/postgresjs-kill-storm.mjs
DATABASE_URL=postgres://okm:okm@127.0.0.1:55432/okm node docs/postgresjs-kill-storm.mjs
```

The script prints one JSON line (`crashes`, `socket`, `samples`) and exits 1
when any uncaught or unhandled event was seen. Exit 0 would mean the upstream
bug is gone for that run.

## What to use instead

Where backends can be terminated under load (failover, pooler recycling, ops
kills), use:

- `okmodel/pg/pg` (node-postgres), or
- `okmodel/pg/bun` (Bun.sql on Bun)

The docs site Drivers page
(`site/content/docs/operate/drivers.mdx`) repeats the recommendation.
