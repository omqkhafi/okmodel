/**
 * Row-level security tenancy (`rlsTenancy()`).
 *
 * The column predicate stays on every statement. Policies are the backstop.
 * A column-only import does not load this file.
 */

import { OkmError } from "../../contracts/error.js";
import type {
  DriverConnection,
  DriverPool,
  ExecuteOptions,
  ExecuteResult,
  Statement,
  WireValue,
} from "../../contracts/driver.js";
import type { CatalogObject, ObjectRef, Provenance } from "../../contracts/catalog/types.js";
import {
  policyObject,
  tenantPolicyExpression,
  unscopedPolicyExpression,
} from "../../contracts/catalog/policy.js";
import type { AnyTable } from "../../dialects/pg/table.js";
import { snakeCase } from "../../dialects/pg/table.js";
import { quoteLiteral } from "../../dialects/pg/quote.js";
import type { ColumnTenancy } from "../../dialects/pg/tenancy.js";
import type { SchemaHookCtx } from "../../dialects/pg/model.js";
import { columnTenancy } from "./index.js";

/** Why {@link RlsRoleError} refused the role. */
export type RlsRoleReason = "owner" | "superuser" | "bypassrls";

const ROLE_MESSAGE: Readonly<Record<RlsRoleReason, string>> = {
  owner: "The connected role owns the tenant tables, so row-level security would not apply.",
  superuser: "The connected role is a superuser, so row-level security would not apply.",
  bypassrls: "The connected role has BYPASSRLS, so row-level security would not apply.",
};

/**
 * OKM1707. The role would not be subject to the policies.
 *
 * `reason` says which check failed. Superuser wins over `BYPASSRLS`, which
 * wins over table owner.
 */
export class RlsRoleError extends OkmError {
  readonly reason: RlsRoleReason;

  /**
   * @param reason - Which privilege bypassed row-level security
   * @param endpoint - Endpoint that answered the check. The message names it
   */
  constructor(reason: RlsRoleReason, endpoint?: string) {
    const named =
      endpoint === undefined
        ? ROLE_MESSAGE[reason]
        : `${ROLE_MESSAGE[reason]} Endpoint ${endpoint}.`;
    super("OKM1707", named, {
      fix: {
        summary:
          "Connect as a role that is not the table owner, a superuser, or BYPASSRLS. okm seed under rlsTenancy runs as the application role. The owner gets this error.",
      },
    });
    this.name = "OkmError";
    this.reason = reason;
  }
}

const TRAIT = "okm.rls";
const WRAPPED = Symbol("okmodel.rls.wrapped");
const INNER = Symbol("okmodel.rls.inner");

type Scope = { readonly value: string } | { readonly unscoped: string };

type Model = Readonly<
  Record<
    string,
    {
      readonly sql: string;
      readonly primary: readonly unknown[];
      readonly columns: readonly {
        readonly field: string;
        readonly sql: string;
        readonly dataType?: string;
      }[];
    }
  >
>;

/** One tenant table the policy check compares with the catalog. */
type TenantGuard = {
  readonly name: string;
  readonly column: string;
  readonly dataType: string;
};

/** One endpoint the router can hand a scoped statement. */
type GuardEndpoint = {
  readonly name: string;
  readonly generation: number;
  readonly pool: DriverPool;
};

type ScopeState = {
  last: string | undefined;
  pending: Promise<void> | undefined;
  epoch: number;
};

type HookSession = {
  pool: DriverPool;
  readonly scope?: Scope;
  readonly tx?: unknown;
  readonly schema: { readonly model: Model };
};

type ReadUnit = (
  text: string,
  params: readonly WireValue[] | undefined,
  prelude: Statement,
  options: ExecuteOptions | undefined,
) => Promise<ExecuteResult>;

type ReadStream = (
  text: string,
  params: readonly WireValue[] | undefined,
  prelude: Statement,
  options: ExecuteOptions | undefined,
) => AsyncIterable<readonly (readonly WireValue[])[]>;

type RoutedPool = DriverPool & {
  readonly okmReadOnlyUnit?: ReadUnit;
  readonly okmReadOnlyStream?: ReadStream;
  okmEndpoints?: () => readonly GuardEndpoint[];
  okmGuardInstalled?: boolean;
};

type ScopeHooks = {
  okmForgetScope?: () => void;
  okmScopePending?: () => Promise<void> | undefined;
};

const guardChecks = new WeakMap<object, Map<number, Promise<void>>>();
const scopeStates = new WeakMap<object, ScopeState>();

function openColumn(key: string): ColumnTenancy {
  return (
    columnTenancy as (input: { readonly key: string; readonly type: "uuid" }) => ColumnTenancy
  )({
    key,
    type: "uuid",
  });
}

function statementOf(text: string, params: readonly WireValue[] | undefined): Statement {
  return params === undefined ? { text } : { text, params };
}

/**
 * Row-level security for `schema({ tenancy })`.
 *
 * One uuid key. The column predicate matches `columnTenancy`. Policies,
 * `set_config`, and the role check load with this import. Combining it with
 * `via()` or `compositeTenancy()` is a definition error.
 *
 * @typeParam Key - Field name of the tenant key
 * @param input - Field name and `uuid`
 * @returns The object `schema()` applies
 */
export function rlsTenancy<const Key>(input: {
  readonly key: Key extends readonly unknown[]
    ? "rlsTenancy() takes one key. Combining it with compositeTenancy or via() is not supported yet."
    : Key extends string
      ? Key
      : "rlsTenancy() key must be a field name.";
  readonly type: "uuid";
}): ColumnTenancy & { readonly key: Key extends string ? Key : string } {
  if (input === undefined || typeof input !== "object") {
    throw new OkmError("OKM1060", "rlsTenancy() needs { key, type }.", {
      fix: { summary: 'Pass rlsTenancy({ key: "tenantId", type: "uuid" }).' },
    });
  }
  if (Array.isArray(input.key)) {
    throw new OkmError(
      "OKM1060",
      "rlsTenancy() takes one key. Combining it with compositeTenancy or via() is not supported yet.",
      {
        fix: {
          summary:
            "Use rlsTenancy() on its own, with one key. compositeTenancy() and via() are separate strategies.",
        },
      },
    );
  }
  const base = openColumn(input.key as string);
  const key = base.key;
  let checker: (() => Promise<void>) | undefined;
  let armedFor: object | undefined;

  const api: ColumnTenancy = {
    ...base,
    strategy: "rls",
    rewrite(tables) {
      refuseVia(tables);
      const next = base.rewrite(tables);
      for (const item of tables) {
        if (isTenantTable(item)) attachTrait(item, key);
      }
      return next;
    },
    hook(target, ctx) {
      if (ctx.table !== undefined) {
        arm(
          ctx,
          key,
          (check, session) => {
            checker = check;
            armedFor = session;
          },
          armedFor,
        );
        return;
      }
      base.hook(target, ctx);
      if (checker !== undefined) {
        target["~rls"] = checker;
        checker = undefined;
        armedFor = undefined;
      }
    },
  };
  return api as ColumnTenancy & { readonly key: Key extends string ? Key : string };
}

/**
 * Runs one statement inside `BEGIN READ ONLY` after the tenant setting.
 *
 * The caller releases the connection. A failure rolls the transaction back.
 *
 * @param conn - Reserved connection
 * @param text - User statement
 * @param params - Wire parameters
 * @param prelude - `set_config` statement
 * @param options - Deadline and cancellation, without a route hint
 * @returns The user statement's result
 */
export async function runReadOnly(
  conn: DriverConnection,
  text: string,
  params: readonly WireValue[] | undefined,
  prelude: Statement,
  options: ExecuteOptions | undefined,
): Promise<ExecuteResult> {
  await conn.execute("begin read only");
  try {
    await conn.execute(prelude.text, prelude.params);
    const result = await conn.execute(text, params, options);
    await conn.execute("commit");
    return result;
  } catch (error) {
    await conn.execute("rollback").catch(() => undefined);
    throw error;
  }
}

/**
 * Streams one query inside `BEGIN READ ONLY` after the tenant setting.
 *
 * Rows come back in chunks of 64. The caller releases the connection.
 *
 * @param conn - Reserved connection
 * @param text - User query
 * @param params - Wire parameters
 * @param prelude - `set_config` statement
 * @returns Row chunks
 */
export async function* streamHeld(
  conn: DriverConnection,
  text: string,
  params: readonly WireValue[] | undefined,
  prelude: Statement,
): AsyncGenerator<readonly (readonly WireValue[])[]> {
  await conn.execute("begin read only");
  try {
    await conn.execute(prelude.text, prelude.params);
    await conn.execute(`declare okm_rls no scroll cursor for ${text}`, params);
    for (;;) {
      const chunk = await conn.execute("fetch 64 from okm_rls");
      if (chunk.rows.length === 0) break;
      yield chunk.rows;
    }
    await conn.execute("close okm_rls");
    await conn.execute("commit");
  } catch (error) {
    await conn.execute("rollback").catch(() => undefined);
    throw error;
  }
}

function refuseVia(tables: readonly AnyTable[]): void {
  for (const item of tables) {
    const mark = (item.options as { readonly tenancy?: unknown } | undefined)?.tenancy;
    if (isRecord(mark) && typeof mark.rewrite === "function") {
      throw new OkmError(
        "OKM1060",
        `Table ${item.name} uses via() with rlsTenancy(). Combining them is not supported yet.`,
        {
          fix: {
            summary:
              "Use rlsTenancy() on its own, with one key. via() and compositeTenancy() are separate strategies.",
          },
        },
      );
    }
  }
}

function isTenantTable(item: AnyTable): boolean {
  const mark = (item.options as { readonly tenancy?: unknown } | undefined)?.tenancy;
  return mark === undefined;
}

function attachTrait(item: AnyTable, key: string): void {
  const trait = policyTrait(item.name, key);
  const record = item as { options?: { traits?: unknown[] } };
  if (record.options === undefined) {
    Object.assign(item, { options: { traits: [trait] } });
    return;
  }
  const traits = record.options.traits;
  if (!Array.isArray(traits)) {
    record.options.traits = [trait];
    return;
  }
  if (traits.some((entry) => isRecord(entry) && entry.name === TRAIT)) return;
  traits.push(trait);
}

function policyTrait(
  tsName: string,
  key: string,
): {
  readonly name: string;
  readonly fields: Readonly<Record<string, never>>;
  apply(): void;
  contribute(peers: unknown, built: unknown): readonly CatalogObject[];
} {
  return {
    name: TRAIT,
    fields: {},
    apply() {
      return undefined;
    },
    contribute(_peers, built) {
      if (!Array.isArray(built)) return [];
      const objects = built as readonly CatalogObject[];
      const parent = objects.find(
        (object): object is CatalogObject & { readonly kind: "table" } =>
          object.kind === "table" && object.provenance.name === tsName,
      );
      if (parent === undefined || parent.kind !== "table") return [];
      const ref: ObjectRef = { namespace: parent.identity.namespace, name: parent.identity.name };
      if (
        objects.some(
          (object) => object.kind === "policy" && object.identity.parent.name === ref.name,
        )
      ) {
        return [];
      }
      const column = objects.find(
        (object) =>
          object.kind === "column" &&
          object.identity.parent.name === ref.name &&
          (object.identity.name === key || object.identity.name === snakeCase(key)),
      );
      if (column === undefined || column.kind !== "column") {
        throw new OkmError(
          "OKM1020",
          `Table ${tsName} is missing the ${key} column row-level security needs.`,
        );
      }
      const provenance: Provenance = { origin: "trait", name: "rls" };
      const expression = tenantPolicyExpression(column.identity.name, column.definition.dataType);
      return [
        policyObject({
          parent: ref,
          name: `${ref.name}_tenant`,
          command: "all",
          expression,
          force: true,
          provenance,
        }),
        policyObject({
          parent: ref,
          name: `${ref.name}_unscoped_select`,
          command: "select",
          expression: unscopedPolicyExpression(),
          force: true,
          provenance,
        }),
      ];
    },
  };
}

function arm(
  ctx: SchemaHookCtx,
  key: string,
  remember: (check: () => Promise<void>, session: object) => void,
  armedFor: object | undefined,
): void {
  const session = ctx.session;
  if (!isSession(session) || session === armedFor) return;
  const raw = innerPool(session.pool);
  const tables = tenantTables(session.schema.model, key);
  remember(() => checkEndpoint(raw, "primary", 0, tables), session);
  if (session.scope === undefined || isWrapped(session.pool)) return;
  session.pool = wrapPool(session.pool, session.scope, session.tx !== undefined, tables);
}

function isSession(value: object | undefined): value is HookSession {
  if (value === undefined) return false;
  const pool = (value as { pool?: unknown }).pool;
  return typeof pool === "object" && pool !== null && "execute" in pool;
}

function tenantTables(model: Model, key: string): readonly TenantGuard[] {
  const snake = snakeCase(key);
  const tables: TenantGuard[] = [];
  for (const table of Object.values(model)) {
    if (table.primary.length === 0) continue;
    const column = table.columns.find((item) => item.field === key || item.sql === snake);
    if (column?.dataType === undefined) continue;
    tables.push({ name: table.sql, column: column.sql, dataType: column.dataType });
  }
  return tables;
}

function isWrapped(pool: object): boolean {
  return WRAPPED in pool;
}

function innerPool(pool: DriverPool): DriverPool {
  const inner = (pool as { [INNER]?: DriverPool })[INNER];
  return inner ?? pool;
}

function wrapPool(
  inner: DriverPool,
  scope: Scope,
  inside: boolean,
  tables: readonly TenantGuard[],
): DriverPool {
  const setting = settingOf(scope);
  const unscoped = "unscoped" in scope;
  installGuard(inner, tables);
  const ensure = (): Promise<void> =>
    (inner as RoutedPool).okmGuardInstalled === true
      ? Promise.resolve()
      : checkEndpoint(inner, "primary", 0, tables);
  const state = inside ? scopeState(inner) : undefined;
  if (state !== undefined) queueScope(inner, scope, state);
  const arm = (): Promise<void> =>
    state === undefined ? Promise.resolve() : ensureScope(inner, scope, state);
  const wrapped: DriverPool = {
    capabilities: inner.capabilities,
    execute: async (text, params, options) => {
      await ensure();
      if (unscoped && isWriteSql(text)) unscopedWrite();
      if (inside) {
        await arm();
        return inner.execute(text, params, options);
      }
      if (isReadSql(text)) return runScopedRead(inner, text, params, setting, options);
      const results = await inner.batch([setting, statementOf(text, params)], options);
      const result = results[1];
      if (result === undefined) {
        throw new OkmError("OKM1111", "The driver returned no result for the statement.", {
          fix: { summary: "Use a Postgres driver that returns one result per batched statement." },
        });
      }
      return result;
    },
    batch: async (statements, options) => {
      await ensure();
      if (unscoped && statements.some((statement) => isWriteSql(statement.text))) unscopedWrite();
      if (inside) {
        await arm();
        return inner.batch(statements, options);
      }
      if (statements.length > 0 && statements.every((statement) => isReadSql(statement.text))) {
        const results: ExecuteResult[] = [];
        for (const statement of statements) {
          results.push(
            await runScopedRead(inner, statement.text, statement.params, setting, options),
          );
        }
        return results;
      }
      const results = await inner.batch(
        [setting, ...statements.map((statement) => statementOf(statement.text, statement.params))],
        options,
      );
      return results.slice(1);
    },
    stats: () => inner.stats(),
    close: () => inner.close(),
  };
  if (state !== undefined) bindScopeHooks(inner, wrapped, state);
  if (inner.reserve !== undefined) wrapped.reserve = () => inner.reserve!();
  if (inner.describe !== undefined) {
    wrapped.describe = (text, params) => inner.describe!(text, params);
  }
  if (inner.listen !== undefined)
    wrapped.listen = (channel, onNotify) => inner.listen!(channel, onNotify);
  if (inner.cancel !== undefined) wrapped.cancel = () => inner.cancel!();
  if (inner.stream !== undefined || (inner as RoutedPool).okmReadOnlyStream !== undefined) {
    wrapped.stream = (text, params) =>
      streamScoped(inner, text, params, setting, inside, unscoped, ensure, arm);
  }
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  Object.defineProperty(wrapped, INNER, { value: inner });
  return wrapped;
}

function settingOf(scope: Scope): Statement {
  if ("unscoped" in scope) return { text: "select set_config('app.unscoped', 'on', true)" };
  return { text: "select set_config('app.tenant', $1, true)", params: [scope.value] };
}

async function runScopedRead(
  inner: DriverPool,
  text: string,
  params: readonly WireValue[] | undefined,
  setting: Statement,
  options: ExecuteOptions | undefined,
): Promise<ExecuteResult> {
  const unit = (inner as RoutedPool).okmReadOnlyUnit;
  if (unit !== undefined) return unit(text, params, setting, options);
  if (inner.reserve === undefined) {
    throw new OkmError(
      "OKM1111",
      "Row-level security needs a driver that can reserve a connection.",
      {
        fix: { summary: "Use a Postgres driver that supports interactive transactions." },
      },
    );
  }
  const conn = await inner.reserve();
  try {
    return await runReadOnly(conn, text, params, setting, options);
  } finally {
    await conn.release();
  }
}

function streamScoped(
  inner: DriverPool,
  text: string,
  params: readonly WireValue[] | undefined,
  setting: Statement,
  inside: boolean,
  unscoped: boolean,
  ensure: () => Promise<void>,
  arm: () => Promise<void>,
): AsyncIterable<readonly (readonly WireValue[])[]> {
  return (async function* () {
    await ensure();
    if (unscoped && isWriteSql(text)) unscopedWrite();
    const routed = (inner as RoutedPool).okmReadOnlyStream;
    if (!inside && isReadSql(text) && routed !== undefined) {
      yield* routed(text, params, setting, undefined);
      return;
    }
    if (inside) {
      await arm();
      if (inner.stream === undefined) {
        throw new OkmError("OKM1111", "stream() inside tx() needs a driver stream.", {
          fix: { summary: "Stream outside the transaction, or read with find()." },
        });
      }
      yield* inner.stream(text, params);
      return;
    }
    if (inner.reserve === undefined) {
      throw new OkmError(
        "OKM1111",
        "Row-level security needs a driver that can reserve a connection.",
        {
          fix: { summary: "Use a Postgres driver that supports interactive transactions." },
        },
      );
    }
    const conn = await inner.reserve();
    try {
      yield* streamHeld(conn, text, params, setting);
    } finally {
      await conn.release();
    }
  })();
}

function scopeState(pool: object): ScopeState {
  let state = scopeStates.get(pool);
  if (state === undefined) {
    state = { last: undefined, pending: undefined, epoch: 0 };
    scopeStates.set(pool, state);
  }
  return state;
}

function scopeKey(scope: Scope): string {
  return "unscoped" in scope ? `unscoped:${scope.unscoped}` : scope.value;
}

/**
 * Queues `set_config` as soon as the transaction client exists.
 *
 * That is after `BEGIN` and before the callback, so a later savepoint cannot
 * roll the setting back. A second scope waits until the first write finishes.
 */
function queueScope(inner: DriverPool, scope: Scope, state: ScopeState): void {
  const key = scopeKey(scope);
  if (state.last === key || state.pending !== undefined) return;
  const epoch = state.epoch;
  const setting = settingOf(scope);
  const run = inner.execute(setting.text, setting.params).then(() => {
    if (state.epoch !== epoch) return;
    state.last = key;
    state.pending = undefined;
  });
  state.pending = run;
  void run.catch(() => {
    if (state.pending === run) state.pending = undefined;
  });
}

/** Sets the tenant when this statement's scope is not the one last applied. */
async function ensureScope(inner: DriverPool, scope: Scope, state: ScopeState): Promise<void> {
  const key = scopeKey(scope);
  const pending = state.pending;
  if (pending !== undefined) await pending;
  if (state.last === key) return;
  const epoch = state.epoch;
  const setting = settingOf(scope);
  await inner.execute(setting.text, setting.params);
  if (state.epoch !== epoch) return;
  state.last = key;
}

function bindScopeHooks(inner: DriverPool, wrapped: DriverPool, state: ScopeState): void {
  const hooks: ScopeHooks = {
    okmForgetScope() {
      state.epoch += 1;
      state.last = undefined;
      state.pending = undefined;
    },
    okmScopePending() {
      return state.pending;
    },
  };
  Object.assign(inner, hooks);
  Object.assign(wrapped, hooks);
}

/**
 * Attaches the role and policy check to each endpoint the router can use.
 *
 * A pool without `okmEndpoints` is one connection. Its wrapper checks that
 * pool. The router calls the guard before the statement, on the endpoint it
 * chose, so a replica is not cleared by a check that ran on the primary.
 */
function installGuard(inner: DriverPool, tables: readonly TenantGuard[]): void {
  const routed = inner as RoutedPool;
  if (routed.okmEndpoints === undefined || routed.okmGuardInstalled === true) return;
  const guard = (endpoint: GuardEndpoint): Promise<void> =>
    checkEndpoint(endpoint.pool, endpoint.name, endpoint.generation, tables);
  for (const endpoint of routed.okmEndpoints()) {
    (endpoint.pool as { okmGuard?: (endpoint: GuardEndpoint) => Promise<void> }).okmGuard = guard;
  }
  routed.okmGuardInstalled = true;
}

/**
 * Role and policy check for one endpoint, cached until that generation changes.
 *
 * A failed check is not cached. A healthy call pays this once per endpoint.
 */
function checkEndpoint(
  pool: DriverPool,
  endpoint: string,
  generation: number,
  tables: readonly TenantGuard[],
): Promise<void> {
  let generations = guardChecks.get(pool);
  if (generations === undefined) {
    generations = new Map();
    guardChecks.set(pool, generations);
  }
  const existing = generations.get(generation);
  if (existing !== undefined) return existing;
  const pending = verifyEndpoint(pool, endpoint, tables);
  generations.set(generation, pending);
  void pending.catch(() => {
    if (generations.get(generation) === pending) generations.delete(generation);
  });
  return pending;
}

async function verifyEndpoint(
  pool: DriverPool,
  endpoint: string,
  tables: readonly TenantGuard[],
): Promise<void> {
  const listed =
    tables.length === 0 ? "" : tables.map((table) => quoteLiteral(table.name)).join(", ");
  const owns =
    tables.length === 0
      ? "false"
      : `exists (
          select 1 from pg_class owned
          join pg_namespace ns on ns.oid = owned.relnamespace
          where ns.nspname = current_schema()
            and owned.relkind = 'r'
            and owned.relname in (${listed})
            and owned.relowner = r.oid
        )`;
  const policies =
    tables.length === 0
      ? ""
      : `, c.relname, c.relrowsecurity::text, c.relforcerowsecurity::text, p.polname, coalesce(pg_get_expr(p.polqual, p.polrelid), ''), coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')`;
  const join =
    tables.length === 0
      ? ""
      : ` left join pg_namespace n on n.nspname = current_schema() left join pg_class c on c.relnamespace = n.oid and c.relkind = 'r' and c.relname in (${listed}) left join pg_policy p on p.polrelid = c.oid`;
  const result = await pool.execute(
    `select r.rolsuper::text, r.rolbypassrls::text, (${owns})::text${policies} from pg_roles r${join} where r.rolname = current_user`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new OkmError(
      "OKM1707",
      `The connected role is not visible in pg_roles. Endpoint ${endpoint}.`,
      {
        fix: {
          summary:
            "Connect as a role that is not the table owner, a superuser, or BYPASSRLS. okm seed under rlsTenancy runs as the application role. The owner gets this error.",
        },
      },
    );
  }
  if (row[0] === "true") throw new RlsRoleError("superuser", endpoint);
  if (row[1] === "true") throw new RlsRoleError("bypassrls", endpoint);
  if (row[2] === "true") throw new RlsRoleError("owner", endpoint);
  if (tables.length === 0) return;
  assertPolicyRows(result.rows, tables, endpoint);
}

type LivePolicy = {
  readonly using: string;
  readonly check: string;
};

function assertPolicyRows(
  rows: readonly (readonly (string | null)[])[],
  tables: readonly TenantGuard[],
  endpoint: string,
): void {
  const live = new Map<
    string,
    { rowsecurity: string; force: string; policies: Map<string, LivePolicy> }
  >();
  for (const row of rows) {
    const name = row[3];
    if (name === undefined || name === null || name.length === 0) continue;
    let table = live.get(name);
    if (table === undefined) {
      table = {
        rowsecurity: row[4] ?? "",
        force: row[5] ?? "",
        policies: new Map(),
      };
      live.set(name, table);
    }
    const policy = row[6];
    if (policy === undefined || policy === null || policy.length === 0) continue;
    table.policies.set(policy, { using: row[7] ?? "", check: row[8] ?? "" });
  }
  for (const table of tables) {
    const found = live.get(table.name);
    if (found === undefined || found.rowsecurity !== "true") {
      policyError(table.name, "is missing forced row-level security.", endpoint);
    }
    if (found.force !== "true") {
      policyError(table.name, "does not force row-level security.", endpoint);
    }
    const tenant = tenantPolicyExpression(table.column, table.dataType);
    const unscoped = unscopedPolicyExpression();
    const tenantPolicy = found.policies.get(`${table.name}_tenant`);
    const unscopedPolicy = found.policies.get(`${table.name}_unscoped_select`);
    if (
      tenantPolicy === undefined ||
      tenantPolicy.using !== tenant ||
      tenantPolicy.check !== tenant
    ) {
      policyError(
        table.name,
        `policy ${table.name}_tenant does not match the tenant predicate.`,
        endpoint,
      );
    }
    if (
      unscopedPolicy === undefined ||
      unscopedPolicy.using !== unscoped ||
      unscopedPolicy.check !== ""
    ) {
      policyError(
        table.name,
        `policy ${table.name}_unscoped_select does not match the unscoped predicate.`,
        endpoint,
      );
    }
    if (found.policies.size !== 2) {
      policyError(table.name, "has a row-level security policy okm did not emit.", endpoint);
    }
  }
}

function policyError(table: string, detail: string, endpoint: string): never {
  throw new OkmError("invalid", `Table ${table} ${detail} Endpoint ${endpoint}.`, {
    table,
    fix: { summary: "Restore the policies okm generate emits for this rls schema." },
  });
}

function unscopedWrite(): never {
  throw new OkmError("OKM1701", "unscoped() cannot write under row-level security.", {
    fix: {
      summary:
        "Cross-tenant writes belong to the migration role. Use for() to write as one tenant.",
    },
  });
}

function isWriteSql(text: string): boolean {
  const sql = text.trimStart().toLowerCase().replace(/\s+/g, " ");
  if (/^(insert|update|delete|refresh|truncate|create|alter|drop|grant|revoke|copy)\b/.test(sql)) {
    return true;
  }
  return sql.startsWith("with ") && /\b(insert|update|delete)\b/.test(sql);
}

function isReadSql(text: string): boolean {
  const sql = text.trimStart().toLowerCase().replace(/\s+/g, " ");
  if (/^(select|values|table|show|explain)\b/.test(sql)) {
    return !/\sfor (no key update|key share|update|share)\b/.test(sql);
  }
  return sql.startsWith("with ") && !/\b(insert|update|delete)\b/.test(sql);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
