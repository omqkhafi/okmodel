/**
 * Postgres feature registry.
 *
 * Hand-written. `tests/capability-registry.test.ts` checks each `proof`
 * against a literal test title. `type.uuidv7` is native since 18, not
 * emulated: a client-generated id is not the same default as `uuidv7()`,
 * and OKM1812 stays.
 *
 * Not in this table (no proof today): `query.fullJoin`, `query.cte`,
 * `query.setOps`.
 */

import {
  NOT_ENFORCED_POSTGRES,
  TEMPORAL_POSTGRES,
  UUIDV7_POSTGRES,
} from "../../dialects/pg/floor.js";
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
  "identity.options": native("proof:identity.options"),
  "sequence.native": native("proof:sequence.native"),
  "sequence.counter": native("proof:sequence.counter"),
  "sequence.reset": native("proof:sequence.reset"),
  "sequence.when": native("proof:sequence.when"),
  "sequence.numbered": native("proof:sequence.numbered"),
  "grants.sequence": native("proof:grants.sequence"),
  "type.uuid": native("proof:type.uuid"),
  "type.uuidv7": native("proof:type.uuidv7", { since: String(UUIDV7_POSTGRES) }),
  "check.notEnforced": native("proof:check.notEnforced", { since: String(NOT_ENFORCED_POSTGRES) }),
  "type.jsonb": native("proof:type.jsonb"),
  "type.array": native("proof:type.array"),
  "type.range": native("proof:type.range"),
  "comment.range": native("proof:comment.range"),
  "grants.range": native("proof:grants.range"),
  "constraint.exclusion": native("proof:constraint.exclusion"),
  "range.operators": native("proof:range.operators"),
  "temporal.keys": native("proof:temporal.keys", { since: String(TEMPORAL_POSTGRES) }),
  "type.enum": native("proof:type.enum"),
  "type.domain": native("proof:type.domain"),
  "type.composite": native("proof:type.composite"),
  "comment.composite": native("proof:comment.composite"),
  "grants.type": native("proof:grants.type"),
  "index.partial": native("proof:index.partial"),
  "index.expression": native("proof:index.expression"),
  "index.covering": native("proof:index.covering"),
  "index.ordering": native("proof:index.ordering"),
  "index.nullsNotDistinct": native("proof:index.nullsNotDistinct", { since: "15" }),
  "index.storage": native("proof:index.storage"),
  "ext.pgvector": native("proof:ext.pgvector"),
  "type.vector": native("proof:type.vector"),
  "type.halfvec": native("proof:type.halfvec"),
  "index.hnsw": native("proof:index.hnsw"),
  "index.ivfflat": native("proof:index.ivfflat"),
  "query.vectorDistance": native("proof:query.vectorDistance"),
  "query.vectorWithin": native("proof:query.vectorWithin"),
  "query.vectorNearest": native("proof:query.vectorNearest"),
  "comment.table": native("proof:comment.table"),
  "comment.column": native("proof:comment.column"),
  "comment.index": native("proof:comment.index"),
  "comment.view": native("proof:comment.view"),
  "comment.matview": native("proof:comment.matview"),
  "comment.function": native("proof:comment.function"),
  "fn.procedure": native("proof:fn.procedure"),
  "fn.procedure.commits": native("proof:fn.procedure.commits"),
  "fn.run": native("proof:fn.run"),
  "fn.definerRevoke": native("proof:fn.definerRevoke"),
  "fn.raises": native("proof:fn.raises"),
  "grants.procedure": native("proof:grants.procedure"),
  "comment.procedure": native("proof:comment.procedure"),
  "comment.trigger": native("proof:comment.trigger"),
  "comment.sequence": native("proof:comment.sequence"),
  "comment.type": native("proof:comment.type"),
  "comment.constraint": native("proof:comment.constraint"),
  "column.generated": native("proof:column.generated"),
  "column.generatedExpression": native("proof:column.generatedExpression"),
  "column.generatedVirtual": native("proof:column.generatedVirtual"),
  "foreignKey.composite": native("proof:foreignKey.composite"),
  "foreignKey.deferrable": native("proof:foreignKey.deferrable"),
  "foreignKey.setNullColumns": native("proof:foreignKey.setNullColumns"),
  "foreignKey.matchFull": native("proof:foreignKey.matchFull"),
  namespace: native("proof:namespace"),
  extension: native("proof:extension"),
  "query.relational": native("proof:query.relational"),
  "query.keyset": native("proof:query.keyset"),
  "query.window": native("proof:query.window"),
  "query.countDistinct": native("proof:query.countDistinct"),
  "query.distinct": native("proof:query.distinct"),
  "query.distinctOn": native("proof:query.distinctOn"),
  "query.namedAggregates": native("proof:query.namedAggregates"),
  "query.having": native("proof:query.having"),
  "query.orderNulls": native("proof:query.orderNulls"),
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
  "policies.permissive": native("proof:policies.permissive"),
  "policies.restrictive": native("proof:policies.restrictive"),
  "session.list": native("proof:session.list"),
  "session.role": native("proof:session.role"),
  "tenancy.keyTypes": native("proof:tenancy.keyTypes"),
  "comment.policy": native("proof:comment.policy"),
  "session.settings": native("proof:session.settings"),
  "session.local": native("proof:session.local"),
  "roles.grants": native("proof:roles.grants"),
  "roles.manage": native("proof:roles.manage"),
  "roles.membership": native("proof:roles.membership", { since: "16" }),
  "grants.object": native("proof:grants.object"),
  "grants.column": native("proof:grants.column"),
  "grants.verify": native("proof:grants.verify"),
  "pooler.detect": native("proof:pooler.detect"),
  "guard.fragment": native("proof:guard.fragment"),
  "guard.pooler": native("QA-M6: a backend pid that changes between the two statements is OKM1854"),
  "tooling.introspect": native("introspection's SQL name key does not rebuild a constraint"),
  "tooling.lint": native(
    "a later file is linted against the previous catalog, and an applied id is skipped",
  ),
  "tooling.pull": native("pull emitter uses export names in references and keeps sqlName"),
  "tooling.scratchReplay": native("proof:tooling.scratchReplay"),
  "tooling.scratchCheck": native("proof:tooling.scratchCheck"),
  "expr.core": native("proof:expr.core"),
  "expr.where": native("proof:expr.where"),
  "step.blocking": native("proof:step.blocking"),
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
  /** A view body is `find` or `aggregate`, printed without executing. */
  "view.typed": native("proof:view.typed"),
  /** A materialized view is the same body, created with no data, then populated. */
  "view.materialized": native("proof:view.materialized"),
  /** Invoker is the default. Definer sets security_barrier. */
  "view.security": native("proof:view.security"),
  /** `WITH LOCAL` or `WITH CASCADED CHECK OPTION` is DDL only. */
  "view.checkOption": native("proof:view.checkOption"),
  /** Concurrent refresh needs a plain unique index. */
  "matview.refresh": native("proof:matview.refresh"),
  /** Creation order follows the declared tables and views. A cycle is OKM1900. */
  "view.dependencyOrder": native("proof:view.dependencyOrder"),
  /** `expr.as(name)` is a select column. */
  "query.exprSelect": native("proof:query.exprSelect"),
  /** `"relation.column"` in select, where, groupBy, and orderBy is a join. */
  "query.toOnePath": native("proof:query.toOnePath"),
  /** `"home.city"` and `"project.name"` in `db.*` where, select, orderBy, and groupBy. */
  "query.paths": native("proof:query.paths"),
} as const satisfies Registry;

/** One Postgres feature key. */
export type PostgresFeature = keyof typeof POSTGRES_FEATURES;
