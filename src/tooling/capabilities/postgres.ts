/**
 * Postgres feature registry.
 *
 * Hand-written. `tests/capability-registry.test.ts` checks each `proof`
 * against a literal test title. `type.uuidv7` is native since 18, not
 * emulated: a client-generated id is not the same default as `uuidv7()`,
 * and OKM1812 stays.
 *
 * Not in this table (no proof today): `query.distinctOn`, `query.fullJoin`,
 * `query.cte`, `query.setOps`.
 */

import type { FeatureEntry, Registry } from "./types.js";

const native = (proof: string, extra?: Omit<FeatureEntry, "support" | "proof">): FeatureEntry => ({
  support: "native",
  proof,
  ...extra,
});

/**
 * Frozen Postgres feature table.
 *
 * `as const` is the freeze. There is no module-level `Object.freeze`.
 */
export const POSTGRES_FEATURES = {
  "schema.core": native("proof:schema.core"),
  "schema.identity": native("proof:schema.identity"),
  "type.uuid": native("proof:type.uuid"),
  "type.uuidv7": native("proof:type.uuidv7", { since: "18" }),
  "type.jsonb": native("proof:type.jsonb"),
  "type.array": native("proof:type.array"),
  "type.range": native("proof:type.range"),
  "type.enum": native("proof:type.enum"),
  "type.domain": native("proof:type.domain"),
  "index.partial": native("proof:index.partial"),
  "index.expression": native("proof:index.expression"),
  "column.generated": native("proof:column.generated"),
  namespace: native("proof:namespace"),
  extension: native("proof:extension"),
  "query.relational": native("proof:query.relational"),
  "query.keyset": native("proof:query.keyset"),
  "query.window": native("proof:query.window"),
  "query.rawTyped": native(
    "a raw read binds parameters, decodes the class, and keeps the tenant predicate",
  ),
  "query.upsert": native("proof:query.upsert"),
  "returning.write": native(
    "update returning: true with allow returns rows, and delete refuses true",
  ),
  "bulk.insert": native("proof:bulk.insert"),
  "atomic.json": native("proof:atomic.json"),
  "atomic.array": native("proof:atomic.array"),
  "query.stream": native("keyset stream on pglite", { gate: "stream" }),
  "tx.interactive": native(
    "tx on a driver without interactive transactions is OKM1111 and names the flag",
    {
      gate: "transactions",
    },
  ),
  "tx.savepoints": native("proof:tx.savepoints"),
  "tx.isolation": native("proof:tx.isolation"),
  "tx.retry": native("proof:tx.retry"),
  "lock.row": native("lock and limit are a pair, and wait stays on a read"),
  "lock.skip": native("a plain update does not claim, and lock: skip is one statement"),
  "lock.advisory": native("proof:lock.advisory"),
  "listen.notify": native("proof:listen.notify", { gate: "listen" }),
  "steps.resumable": native(
    "concurrent index create and drop run outside the transaction, and validate stays in it",
  ),
  "tenancy.column": native("a column schema keeps its catalog hash and emits no policies"),
  "tenancy.rls": native("rls emits enable, force, and two policies, and skips global tables"),
  "policies.table": native("rls emits enable, force, and two policies, and skips global tables"),
  "session.settings": native("proof:session.settings"),
  "session.local": native("proof:session.local"),
  "roles.grants": native("proof:roles.grants"),
  "guard.fragment": native("proof:guard.fragment"),
  "guard.pooler": native("QA-M6: a backend pid that changes between the two statements is OKM1854"),
  "tooling.introspect": native("introspection's SQL name key does not rebuild a constraint"),
  "tooling.lint": native(
    "a later file is linted against the previous catalog, and an applied id is skipped",
  ),
  "tooling.pull": native("pull emitter uses export names in references and keeps sqlName"),
  "tooling.scratchReplay": native("proof:tooling.scratchReplay"),
  "tooling.testing": native("factories create, reuse a ref, fill defaults, and replay a seed"),
  "tooling.describe": native("proof:tooling.describe"),
  /** Unit kinds the write observer covers: transaction and batch. */
  "writeObserver.unit": native("proof:writeObserver.unit", {
    cost: "transaction | batch",
  }),
  /** Key capture. Postgres appends primary-key `RETURNING`. */
  "writeObserver.keys": native("proof:writeObserver.keys", {
    cost: "returning",
  }),
  /**
   * Row-count mode. Postgres reports `changed`, `returned`, and `unknown`
   * (a driver with no command tag), so the cost is `mixed`.
   */
  "writeObserver.rowCount": native("proof:writeObserver.rowCount", {
    cost: "mixed",
  }),
  /**
   * Timings a query observer can fill. Postgres measures statement time and
   * decode time. Pool queue wait is not on the driver, so `queue` is absent
   * and `queueMs` stays null.
   */
  "queryObserver.timing": native("proof:queryObserver.timing", {
    cost: "query|decode",
  }),
} as const satisfies Registry;

/** One Postgres feature key. */
export type PostgresFeature = keyof typeof POSTGRES_FEATURES;
