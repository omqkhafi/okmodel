/**
 * Path tenancy (`via()`).
 *
 * A table passes `tenancy: via("project.organization")`. This file owns the
 * path compiler. A column-only app does not import it.
 */

import { OkmError } from "../../contracts/error.js";
import { definition } from "../../dialects/pg/misuse.js";
import type { AnyTable } from "../../dialects/pg/table.js";
import type { ColumnTenancy, TenancyRule, TenantCall } from "../../dialects/pg/tenancy.js";
import type { TableRewriteContext } from "./context.js";
import { compilePaths, type PathPlan } from "./path.js";

type Slot = {
  plan: PathPlan;
  keys: readonly string[];
  encodeKey: (key: string, value: string) => string;
};

const slots = new WeakMap<object, Slot>();
const compiled = new WeakMap<Map<string, readonly string[]>, PathPlan>();

/**
 * Isolates a table through relations instead of a tenant column.
 *
 * The path is at most three to-one steps and must end at a tenant table.
 * `schema()` resolves it while it rewrites. A bad path is OKM1705.
 *
 * @typeParam Path - Relation path, such as `"project.organization"`
 * @param path - Steps from this table to the tenant table, separated by `.`
 * @returns The marker `table({ tenancy })` stores
 */
export function via<const Path extends string>(
  path: Path,
): { readonly via: Path; rewrite(table: AnyTable, ctx: TableRewriteContext): AnyTable } {
  if (typeof path !== "string" || path.trim().length === 0) {
    definition("via() needs a relation path.");
  }
  const text = path.trim() as Path;
  return {
    via: text,
    rewrite(table, ctx) {
      return planFor(ctx).adjust(table);
    },
  };
}

function planFor(ctx: TableRewriteContext): PathPlan {
  const cached = compiled.get(ctx.extras);
  if (cached !== undefined) return cached;
  const plan = compilePaths(ctx.tables, classify(ctx.tables));
  for (const [name, declared] of plan.endpoints) {
    if (declared.length > 0) ctx.extras.set(name, declared);
  }
  const encodeKey = (name: string, value: string): string => {
    const at = ctx.keys.indexOf(name);
    const encode = at < 0 ? undefined : ctx.encodes[at];
    return encode === undefined ? value : encode(value);
  };
  let slot = slots.get(ctx.api);
  if (slot === undefined) {
    slot = { plan, keys: ctx.keys, encodeKey };
    slots.set(ctx.api, slot);
    install(ctx.api as ColumnTenancy, slot);
  } else {
    slot.plan = plan;
    slot.keys = ctx.keys;
    slot.encodeKey = encodeKey;
  }
  compiled.set(ctx.extras, plan);
  return plan;
}

function classify(tables: readonly AnyTable[]): Map<string, "tenant" | "global" | "path"> {
  const kind = new Map<string, "tenant" | "global" | "path">();
  for (const item of tables) {
    const mark = (item.options as { readonly tenancy?: unknown } | undefined)?.tenancy;
    if (isGlobal(mark)) {
      kind.set(item.name, "global");
      continue;
    }
    if (isRecord(mark) && typeof mark.via === "string" && typeof mark.rewrite === "function") {
      kind.set(item.name, "path");
      continue;
    }
    kind.set(item.name, "tenant");
  }
  return kind;
}

function install(api: ColumnTenancy, slot: Slot): void {
  const previousPredicate = api.predicate.bind(api);
  const previousStamp = api.stamp.bind(api);
  const previousClient = api.client.bind(api);
  const previousRules = api.rules.bind(api);
  const target = api as ColumnTenancy & {
    predicate: ColumnTenancy["predicate"];
    stamp: ColumnTenancy["stamp"];
    client: ColumnTenancy["client"];
    rules: ColumnTenancy["rules"];
    isPath: (table: string) => boolean;
    pathOf: ColumnTenancy["pathOf"];
    lockPredicate: NonNullable<ColumnTenancy["lockPredicate"]>;
    noteParent: NonNullable<ColumnTenancy["noteParent"]>;
  };
  target.predicate = (spec) => {
    if (!slot.plan.isPath(spec.table)) return previousPredicate(spec);
    return (
      slot.plan.writeExists({
        table: spec.table,
        alias: spec.alias,
        fieldSql: spec.fieldSql,
        scope: spec.scope,
        sink: spec.sink,
        appended: spec.appended,
        lock: false,
        keys: slot.keys,
        encodeKey: slot.encodeKey,
      }) === true
    );
  };
  target.isPath = (table) => slot.plan.isPath(table);
  target.pathOf = (table) =>
    slot.plan.hops(table)?.map((hop) => ({
      child: hop.child,
      parent: hop.parent,
      localField: hop.localField,
      remoteField: hop.remoteField,
    }));
  target.lockPredicate = (spec) => {
    if (!slot.plan.isPath(spec.table)) return false;
    return slot.plan.writeExists({
      table: spec.table,
      alias: spec.alias,
      fieldSql: spec.fieldSql,
      scope: spec.scope,
      sink: spec.sink,
      appended: false,
      lock: true,
      keys: slot.keys,
      encodeKey: slot.encodeKey,
    });
  };
  target.noteParent = (table, set, sink, scope, fieldSql) => {
    const hop = slot.plan.hops(table)?.[0];
    if (hop === undefined) return;
    if (scope === undefined || "unscoped" in scope) return;
    const assigned: Record<string, string> = {};
    const next = set[hop.localField];
    if (typeof next === "string") assigned[hop.localField] = hop.encode(next);
    slot.plan.writeExists({
      table,
      alias: "t",
      fieldSql,
      scope,
      sink,
      appended: true,
      lock: true,
      keys: slot.keys,
      encodeKey: slot.encodeKey,
      ...(Object.keys(assigned).length > 0 ? { assigned } : {}),
    });
  };
  target.stamp = (table, rows, scope) => {
    if (slot.plan.isPath(table)) {
      requireScope(slot.keys, table, scope);
      return;
    }
    previousStamp(table, rows, scope);
  };
  target.client = (spec) => {
    const view = previousClient(spec);
    if (spec.scoped) return view;
    return { ...view, names: view.names.filter((name) => !slot.plan.isPath(name)) };
  };
  target.rules = (table, source, scope) =>
    pathRules(previousRules(table, source, scope), slot, table, source, scope);
}

function pathRules(
  rules: readonly TenancyRule[],
  slot: Slot,
  table: string,
  source: string | undefined,
  scope: TenantCall | undefined,
): readonly TenancyRule[] {
  const hops = slot.plan.hops(table);
  if (hops === undefined) return rules;
  const next = [...rules];
  next.push({
    rule: "tenancy",
    contribution: `path ${hops.map((hop) => hop.parent).join(".")}`,
    provenance: "catalog",
    ...(source !== undefined ? { source } : {}),
  });
  if (
    scope !== undefined &&
    "value" in scope &&
    !next.some((rule) => rule.contribution === "scoped")
  ) {
    next.push({ rule: "tenancy", contribution: "scoped", provenance: "planner" });
  }
  return next;
}

function requireScope(keys: readonly string[], table: string, scope: TenantCall | undefined): void {
  if (scope === undefined || "unscoped" in scope) {
    throw new OkmError(
      "OKM1701",
      `insert on ${table} has no tenant. Call for({ ${keys.join(", ")} }) so the scope can set it.`,
    );
  }
}

function isGlobal(value: unknown): value is { readonly kind: "global"; readonly reason: string } {
  return isRecord(value) && value.kind === "global" && typeof value.reason === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
