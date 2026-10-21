---
okmVersion: "0.10.0"
since: "0.10"
dialects: [postgres]
codes: [OKM1401, OKM1890, OKM2200]
---
# Observer events (`okm.observe/1`)

Normative event shape for write observers (G-0). Additive-only changes inside
`okm.observe/1`. Postgres only in this train.

`Hookm` is unchanged. Write observers are a separate `connect` option, `onWrite`,
exported from `okmodel/observe` (lazy). `hookm.onTransaction` and unit events are
two views of the same executor moments and are emitted from one internal point.

A process crash yields no event: outcomes are only those this process observed.
Anything that must survive a crash is an outbox table plus a relay.

## Vocabulary

| Term | Meaning |
| --- | --- |
| `unit` | Opaque string id from the library (not the database). One `tx()`, one `batch()`, or one autocommit statement. |
| `seq` | 0-based per unit, in the order statements were sent. |
| `dialect` | `"postgres"`. |
| `op` | `insert` \| `update` \| `delete` \| `upsert` \| `archive` \| `restore` \| `raw`. |
| `rowCountMode` | `changed` \| `matched` \| `returned` \| `unknown`. |
| `rowCount` | `null` exactly when the mode is `unknown`. |
| `keys` | Primary-key records for a table named in `writeObserver({ keys })`. Omitted otherwise. |
| `source` | `client` or `raw`. |
| `tenant` | `null`, or the scope keys and values. |

No event carries row values or bound parameters. `keys` carries only the primary-key columns of a table that opted in.

## Registry

<!-- support: writeObserver.unit -->
Postgres: native. Cost: transaction | batch. Proof passes (`proof:writeObserver.unit`).
<!-- /support -->

<!-- support: writeObserver.keys -->
Postgres: native. Cost: returning. Proof passes (`proof:writeObserver.keys`).
<!-- /support -->

<!-- support: writeObserver.rowCount -->
Postgres: native. Cost: mixed. Proof passes (`proof:writeObserver.rowCount`).
<!-- /support -->

## Events

```ts
type WriteEvent = {
  type: "write";
  unit: string;
  seq: number;
  dialect: "postgres";
  table: string | null;
  op: "insert" | "update" | "delete" | "upsert" | "archive" | "restore" | "raw";
  rowCount: number | null;
  rowCountMode: "changed" | "matched" | "returned" | "unknown";
  keys?: readonly Key[]; // primary key, only when that table opted in
  tenant: Readonly<Record<string, unknown>> | null;
  settings: readonly string[]; // names only, never values
  durationMs: number;
  tag?: string;
  source: "client" | "raw";
};

type SavepointEvent = {
  type: "savepoint";
  unit: string;
  name: string;
  state: "released" | "rolled_back";
  depth: number;
};

type OutcomeEvent = {
  type: "outcome";
  unit: string;
  outcome: "committed" | "rolled_back" | "unknown";
  writes: number; // surviving savepoint rollbacks
  dbTxId?: string;
};
```

`WriteEvent.durationMs` is the statement's own time (send to result). When the
driver runs several statements as one `batch` with no per-statement signal, each
write in that batch shares the wall time of the whole batch.

## Delivery

1. A unit's events are delivered after its COMMIT or ROLLBACK returns, in `seq`
   order, then the `outcome` event last. No statement-time delivery for G-3.
2. Writes inside a rolled-back savepoint are removed from the unit's surviving
   writes before `outcome`; a `savepoint` event with `rolled_back` is emitted so
   tooling can follow. The helper never delivers those writes.
3. Outcome is tri-state: `committed` (COMMIT acknowledged), `rolled_back`
   (explicit rollback, or a failed statement that ended the unit), `unknown`
   (COMMIT sent and the connection lost: `outcome_unknown`, OKM1401). Consumers
   treat `unknown` as "maybe committed" and must be idempotent.
4. Autocommit: a single statement is a unit of one write; `outcome` follows its
   result.
5. `batch()` on a driver with no per-statement signal: one unit, one outcome for
   the whole batch; `seq` still orders the statements.
6. A process crash yields no event (see above).
7. No global order across units.
8. A handler that throws or rejects is caught and sent to
   `onObserverError(err, event)`; it never reaches the write path and never
   changes an outcome. Handlers are not awaited on the write path; returned
   promises are tracked; `await observer.flush()` (from `writeObserver()`)
   resolves when all tracked handler promises have settled and never throws on
   handler errors. Attaching `flush` on every connected client overflows the
   featureless app size gate, so the helper owns `flush`.
9. Backpressure: the buffer is bounded per client (default 10,000 pending
   events). Overflow drops the oldest unit's events and emits one
   `onObserverError` with OKM2200; the write path never waits.

## Helper (`okmodel/observe`)

```ts
writeObserver({
  keys?: readonly string[], // schema table names
  committed?: (u: { unit: string; writes: readonly WriteEvent[] }) => void | Promise<void>,
  rolledBack?: (u: { unit: string }) => void | Promise<void>,
  unknown?: (u: { unit: string; writes: readonly WriteEvent[] }) => void | Promise<void>,
  onObserverError?: (err: unknown, event: WriteEvent | OutcomeEvent) => void,
  onEvent?: (e: WriteEvent | SavepointEvent | OutcomeEvent) => void,
  tag?: string, // 1–64 characters from [A-Za-z0-9_.:/-]
});
```

`connect({ onWrite: writeObserver({ ... }) })` also accepts the raw low-level
handler. The helper buffers per unit and calls exactly one of
`committed` | `rolledBack` | `unknown` once per unit. A unit with zero surviving
writes calls nothing. An observer cannot veto or alter a write.

`keys` names schema tables. For each of those tables the write planner appends
`RETURNING` of the primary key when the statement is a simple `INSERT`,
`UPDATE`, or `DELETE`. The extra columns show in `sql()` and `inspect()`.
`describe()` labels caller columns `"caller"` and appended primary-key columns
`"observer"`. `WriteEvent.keys` is one record per returned row. A successful
statement that opted in and could return the key sets `keys` (an empty array
when no row came back). A failure omits `keys`.

A table with no primary key, or a name that is not in the schema, is OKM1890
at connect and again when the write is planned (`sql()` does not wait for
`connected`).

Statements whose `RETURNING` is not terminal (a parent guard, a versioned
close, an archive CTE) are not rewritten. They fill `keys` only when the
caller already returns every primary-key column. A sortable lock statement is
not a key statement. A first-or-create lookup does not attach keys.

## Row counts

`rowCount` is the command-tag count the driver reported (`ExecuteResult.reported`).
A fixture that omits `reported` is `unknown` with `rowCount: null`. The caller's
result still uses `count`, which falls back to the row list when the tag is absent.

| Mode | When |
| --- | --- |
| `changed` | `insert`, `update`, or `delete` whose SQL has no `RETURNING`. An `upsert` (`ON CONFLICT`) is always `changed` when a tag exists, including `ON CONFLICT DO UPDATE` (inserted plus updated) and `ON CONFLICT DO NOTHING` (inserted only). |
| `returned` | Any other op whose SQL ran `RETURNING`, including primary-key `RETURNING` added for `keys`. |
| `unknown` | The driver reported no command tag (`reported` null or absent). `rowCount` is null. |
| `matched` | Reserved. Not emitted. |

| Driver | Field | Insert, update, delete | `RETURNING` | Nothing |
| --- | --- | --- | --- | --- |
| postgres.js | `count` (null until CommandComplete) | `changed` | `returned` (upsert stays `changed`) | null → `unknown` |
| pg | `rowCount` | `changed` | `returned` (upsert stays `changed`) | null → `unknown` |
| Neon | `rowCount` (same shape as pg) | `changed` | `returned` (upsert stays `changed`) | null → `unknown` |
| Bun.sql | `count` (postgres.js-shaped) | `changed` | `returned` (upsert stays `changed`) | null or absent → `unknown` |
| PGlite | `rowCount` is the per-statement tag. `affectedRows` is cumulative and is used only when `rowCount` is absent | `changed` | `returned` (upsert stays `changed`) | neither a number → `unknown` |

An own field that is present and not a finite number (null) is "nothing". A later field is not a fallback. `count` on the caller result is still `reported ?? rows.length`.

```ts
import { writeObserver } from "okmodel/observe";

const onWrite = writeObserver({
  committed: ({ unit, writes }) => {
    /* …
     */
  },
});
const db = connect(url, { schema, onWrite });
await onWrite.flush();
```

`tag` on `writeObserver({ tag })` is copied onto each write. The same option on
`queryObserver({ tag })` is copied onto each query event. A tag is 1–64 characters
from `[A-Za-z0-9_.:/-]`. Anything else is `invalid` at helper construction. A raw
handler may set a `tag` property; a value that fails the grammar is omitted.

## Query events

`connect({ onQuery })` delivers one `QueryEvent` per statement, reads and writes,
after the statement settles. Types are exported from `okmodel/observe`. The entry
stays lazy. With no observer the client does not build an event and does not read
the clock.

```ts
type QueryEvent = {
  id: string;
  unit?: string; // inside a transaction, a batch, or an autocommit write
  seq?: number;
  dialect: "postgres";
  table: string | null;
  op: string;
  summary: string; // library-built, low cardinality, e.g. "SELECT tasks"
  fingerprint: string; // plan.fingerprint, the value inspect() already reports
  text: string; // parameterised; literals replaced with ?. Unsanitisable text becomes summary
  durationMs: number;
  queueMs: number | null; // null: no driver reports pool-queue wait
  queryMs: number;
  decodeMs: number | null; // null for a write whose SQL has no RETURNING
  rowCount: number | null;
  rowCountMode: "changed" | "matched" | "returned" | "unknown";
  route: { endpoint: string; role: "primary" | "replica" };
  error?: { kind: string; category: string; code: string; sqlstate?: string };
  tag?: string;
  limit?: { value: number; source: string }; // source "caller" when the call passed limit. Absent until a default limit exists
  params?: readonly unknown[]; // only when queryObserver({ params: true })
  stack?: string; // only when queryObserver({ stack: true })
};
```

`summary` is `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `UPSERT`, or `SQL`, plus the
table name when the statement has one. `text` keeps `$n` placeholders. String and
numeric literals become `?`. A comment, a dollar quote, or an unbalanced quote is
replaced by `summary`, so raw text is never shipped. `fingerprint` for a write is
the fingerprint of that parameterised text. A read uses `plan.fingerprint`.

`rowCount` for a write uses the same command-tag rule as `WriteEvent`. A read is
`returned` when the driver reported a count, and `unknown` with `rowCount: null`
otherwise. `queueMs` is null. `decodeMs` is null when a write's SQL has no
`RETURNING`. `limit` is set only when the caller passed a numeric `limit`. `one()`
does not report the internal `limit 2`.

`params` redacts sensitive columns, hidden columns, and tenant keys as
`"[redacted]"`. `params` and `stack` are omitted unless the observer opts in.
No event carries row values. Tenant ids are not a separate field on `QueryEvent`.

`unit` and `seq` are set inside a transaction, a batch, or an autocommit write.
An autocommit read omits both. Query `seq` does not change `WriteEvent.seq`.

A throwing or rejecting handler is caught and sent to `onObserverError`. It does
not change the statement result. `await observer.flush()` waits for tracked
promises and does not throw on handler errors. The pending ceiling defaults to
10,000 in-flight promises. Past that, the handler is not called and
`onObserverError` receives OKM2200, the same overflow warning as `onWrite`.

```ts
import { queryObserver, toOtel } from "okmodel/observe";

const onQuery = queryObserver({
  query: (event) => {
    const span = toOtel(event);
    /* span.name, span.attributes */
  },
  params: true,
  tag: "api.request",
});
const db = connect(url, { schema, onQuery });
await onQuery.flush();
```

`toOtel(event)` returns `{ name, attributes }` and imports nothing from
OpenTelemetry. `name` is `summary`. Attributes use the same names as
`okmodel/otel`:

| Attribute | Value |
| --- | --- |
| `db.system.name` | `postgresql` |
| `db.namespace` | `public` |
| `db.collection.name` | table name |
| `db.operation.name` | `op` |
| `db.query.summary` | fingerprint |
| `error.type` | `error.kind`, on failure |
| `db.response.status_code` | SQLSTATE, on failure when the server sent one |
| `db.query.text` | sanitised text, only when `toOtel(event, { statement: true })` |

Parameters, tenant ids, and stacks are never attributes.

## Capability keys

| Key | Postgres | Closed profile |
| --- | --- | --- |
| `writeObserver.unit` | `transaction` \| `batch` | most restrictive (refused) |
| `writeObserver.keys` | `returning` (`returning` \| `emulated` \| `none`) | `none` (refused) |
| `writeObserver.rowCount` | `mixed` (`changed` \| `matched` \| `mixed` \| `unknown`) | `unknown` (refused) |
| `queryObserver.timing` | `query` \| `decode` (`queue` \| `query` \| `decode`) | `none` (refused) |

<!-- support: queryObserver.timing -->
Postgres: native. Cost: query|decode. Proof passes (`proof:queryObserver.timing`).
<!-- /support -->

`queue` is part of the timing scale. Postgres does not measure pool-queue wait,
so the cost omits it and `queueMs` is null.
