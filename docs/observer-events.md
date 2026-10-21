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
| `source` | `client` or `raw`. |
| `tenant` | `null`, or the scope keys and values. |

No event carries row values or bound parameters.

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
  keys?: readonly Key[]; // G-5
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
  keys?: readonly string[], // accepted and ignored until G-5
  committed?: (u: { unit: string; writes: readonly WriteEvent[] }) => void | Promise<void>,
  rolledBack?: (u: { unit: string }) => void | Promise<void>,
  unknown?: (u: { unit: string; writes: readonly WriteEvent[] }) => void | Promise<void>,
  onObserverError?: (err: unknown, event: WriteEvent | OutcomeEvent) => void,
  onEvent?: (e: WriteEvent | SavepointEvent | OutcomeEvent) => void,
});
```

`connect({ onWrite: writeObserver({ ... }) })` also accepts the raw low-level
handler. The helper buffers per unit and calls exactly one of
`committed` | `rolledBack` | `unknown` once per unit. A unit with zero surviving
writes calls nothing. An observer cannot veto or alter a write. `keys` is
accepted and ignored until G-5.

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

## Capability keys

| Key | Postgres | Closed profile |
| --- | --- | --- |
| `writeObserver.unit` | `transaction` \| `batch` | most restrictive (refused) |
| `writeObserver.keys` | `none` until G-5 (`returning` \| `emulated` \| `none`) | refused |
| `writeObserver.rowCount` | `unknown` until G-5 (`changed` \| `matched` \| `mixed` \| `unknown`) | refused |
