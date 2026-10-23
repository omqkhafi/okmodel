/**
 * Row-level security tenancy (`rlsTenancy()`).
 *
 * The column predicate stays on every statement. Policies are the backstop.
 * A column-only import does not load this file.
 */

import { OkmError } from "../../contracts/error.js";
import type { DriverPool } from "../../contracts/driver.js";
import type { CatalogObject, ObjectRef, Provenance } from "../../contracts/catalog/types.js";
import {
  policyObject,
  tenantPolicyExpression,
  unscopedPolicyExpression,
} from "../../contracts/catalog/policy.js";
import type { AnyTable } from "../../dialects/pg/table.js";
import type { Names } from "../../dialects/pg/casing.js";
import { quoteLiteral } from "../../dialects/pg/quote.js";
import type { ColumnTenancy } from "../../dialects/pg/tenancy.js";
import type { SchemaHookCtx } from "../../dialects/pg/model.js";
import { columnTenancy } from "./index.js";
import { readIndexPolicy } from "./index-shape.js";
import {
  innerPool,
  isWrapped,
  wrapPool,
  type RoutedPool,
  type Setting,
  type Tenant,
} from "./scope-pool.js";

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

type HookSession = {
  pool: DriverPool;
  readonly scope?: Tenant;
  readonly settings?: readonly Setting[];
  readonly tx?: unknown;
  readonly schema: { readonly model: Model };
};

const guardChecks = new WeakMap<object, Map<number, Promise<void>>>();

function openColumn(key: string, indexes: boolean | undefined): ColumnTenancy {
  return (
    columnTenancy as (input: {
      readonly key: string;
      readonly type: "uuid";
      readonly indexes?: boolean;
    }) => ColumnTenancy
  )({
    key,
    type: "uuid",
    ...(indexes !== undefined ? { indexes } : {}),
  });
}

/**
 * Row-level security for `schema({ tenancy })`.
 *
 * One uuid key. The column predicate matches `columnTenancy`. Policies,
 * `set_config`, and the role check load with this import. Combining it with
 * `via()` or `compositeTenancy()` is a definition error.
 *
 * @typeParam Key - Field name of the tenant key
 * `indexes` is the same flag as `columnTenancy`: omitted prefixes tenant
 * indexes with the key.
 *
 * @param input - Field name, `uuid`, and whether indexes are prefixed
 * @returns The object `schema()` applies
 */
export function rlsTenancy<const Key>(input: {
  readonly key: Key extends readonly unknown[]
    ? "rlsTenancy() takes one key. Combining it with compositeTenancy or via() is not supported yet."
    : Key extends string
      ? Key
      : "rlsTenancy() key must be a field name.";
  readonly type: "uuid";
  /** Prefix indexes with the tenant key. Omitted is true. */
  readonly indexes?: boolean;
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
  const prefixIndexes = readIndexPolicy(input.indexes, "rlsTenancy()");
  const base = openColumn(input.key as string, prefixIndexes);
  const key = base.key;
  let checker: (() => Promise<void>) | undefined;
  let armedFor: object | undefined;

  const api: ColumnTenancy = {
    ...base,
    strategy: "rls",
    rewrite(tables, names) {
      refuseVia(tables);
      const next = base.rewrite(tables, names);
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
  contribute(peers: unknown, built: unknown, names: Names): readonly CatalogObject[];
} {
  return {
    name: TRAIT,
    fields: {},
    apply() {
      return undefined;
    },
    contribute(_peers, built, names) {
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
          object.identity.name === names.name(key),
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
  const inner = session.pool;
  installGuard(inner, tables);
  const ensure = (): Promise<void> =>
    (inner as RoutedPool).okmGuardInstalled === true
      ? Promise.resolve()
      : checkEndpoint(inner, "primary", 0, tables);
  session.pool = wrapPool(inner, session.scope, session.settings, session.tx !== undefined, ensure);
}

function isSession(value: object | undefined): value is HookSession {
  if (value === undefined) return false;
  const pool = (value as { pool?: unknown }).pool;
  return typeof pool === "object" && pool !== null && "execute" in pool;
}

function tenantTables(model: Model, key: string): readonly TenantGuard[] {
  const tables: TenantGuard[] = [];
  for (const table of Object.values(model)) {
    if (table.primary.length === 0) continue;
    const column = table.columns.find((item) => item.field === key);
    if (column?.dataType === undefined) continue;
    tables.push({ name: table.sql, column: column.sql, dataType: column.dataType });
  }
  return tables;
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
  const idents =
    tables.length === 0
      ? ""
      : tables.map((table) => quoteLiteral(quotedIdent(table.name))).join(", ");
  const names = idents.length === 0 ? "" : `array[${idents}]::text[]`;
  const owns =
    names.length === 0
      ? "false"
      : `exists (
          select 1
          from unnest(${names}) as owned_name(relname)
          join pg_class owned on owned.oid = to_regclass(owned_name.relname)
          where owned.relkind = 'r'
            and owned.relowner = r.oid
        )`;
  const policies =
    names.length === 0
      ? ""
      : `, c.relname, c.relrowsecurity::text, c.relforcerowsecurity::text, p.polname, coalesce(pg_get_expr(p.polqual, p.polrelid), ''), coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')`;
  const join =
    names.length === 0
      ? ""
      : ` left join unnest(${names}) as listed(relname) on true left join pg_class c on c.oid = to_regclass(listed.relname) and c.relkind = 'r' left join pg_policy p on p.polrelid = c.oid`;
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
  throw new OkmError("OKM1708", `Table ${table} ${detail} Endpoint ${endpoint}.`, {
    table,
    fix: { summary: "Restore the policies okm generate emits for this rls schema." },
  });
}

/** Double-quoted identifier text for `to_regclass`. */
function quotedIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
