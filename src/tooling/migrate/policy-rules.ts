/**
 * Schema warnings for row-level security policies.
 *
 * `okm check` reads these. A cycle is refused earlier, when the schema builds.
 */

import { isGeneratedPolicy } from "../../contracts/catalog/policy.js";
import type { Catalog, PolicyObject } from "../../contracts/catalog/types.js";
import { normalizeRoles, type RolesInput } from "../../dialects/pg/role/config.js";
import { warningRule, type WarningRule } from "../../runtime/warnings/catalog.js";

/** One finding, before levels and ignores. */
export type PolicyFound = {
  readonly rule: WarningRule;
  readonly table: string;
  readonly target: string;
  readonly reason: string;
  readonly location?: { readonly file: string; readonly line: number };
};

/**
 * Policy findings for one catalog.
 *
 * @param catalog - Built catalog
 * @param roles - Roles config, when the project has one
 * @returns Findings in rule order
 */
export function policyFindings(
  catalog: Catalog,
  roles: RolesInput | undefined,
): readonly PolicyFound[] {
  const policies = catalog.objects.filter(
    (object): object is PolicyObject => object.kind === "policy",
  );
  const found: PolicyFound[] = [];
  const known = new Set<string>();
  const bypass = new Set<string>();
  if (roles !== undefined) {
    for (const entry of normalizeRoles(roles)) {
      known.add(entry.key);
      known.add(entry.name);
      if (entry.bypassRls !== undefined || entry.key === "migration") {
        bypass.add(entry.key);
        bypass.add(entry.name);
      }
    }
  }
  const indexes = new Map<string, string[][]>();
  const forced = new Set<string>();
  for (const object of catalog.objects) {
    if (object.kind === "index") {
      const table = object.identity.parent.name;
      const columns = [...object.definition.columns];
      const list = indexes.get(table) ?? [];
      list.push(columns);
      indexes.set(table, list);
    }
  }
  for (const policy of policies) {
    if (policy.definition.force) forced.add(policy.identity.parent.name);
  }
  for (const policy of policies) {
    if (isGeneratedPolicy(policy)) continue;
    const table = policy.identity.parent.name;
    const name = `${table}.${policy.identity.name}`;
    if (policy.definition.disabled === true) {
      push(
        found,
        "policy-while-disabled",
        table,
        name,
        "row security is off, so this policy does not run",
      );
    }
    if (policy.definition.restrictive === true && policy.definition.command === "select") {
      push(
        found,
        "policy-returning",
        table,
        name,
        "a restrictive SELECT policy changes INSERT and DELETE RETURNING",
      );
    }
    if (policy.definition.command === "update" && !hasSelect(policies, policy)) {
      push(
        found,
        "policy-update-without-select",
        table,
        name,
        "an UPDATE with no SELECT policy for this role matches zero rows",
      );
    }
    for (const role of policy.definition.roles ?? []) {
      if (roles !== undefined && !known.has(role)) {
        push(found, "policy-unknown-role", table, name, `role ${role} is not in the roles config`);
      }
      if (bypass.has(role)) {
        push(found, "policy-bypass-role", table, name, `role ${role} bypasses row security`);
      }
    }
    const text = `${policy.definition.expression}\n${policy.definition.check ?? ""}`;
    if (outsideSelect(text)) {
      push(
        found,
        "policy-setting-outside-select",
        table,
        name,
        "current_setting or a function call is outside (select ...)",
      );
    }
    for (const edge of policy.dependencies) {
      if (edge.target.kind !== "column" || edge.target.parent.name !== table) continue;
      const column = edge.target.name;
      const leading = (indexes.get(table) ?? []).some((columns) => columns[0] === column);
      if (!leading) {
        push(
          found,
          "policy-unindexed",
          table,
          `${name}.${column}`,
          `${column} is not a leading index column`,
        );
      }
    }
  }
  for (const object of catalog.objects) {
    if (object.kind !== "function" || object.definition.security !== "definer") continue;
    const reads = new Set<string>();
    for (const edge of object.dependencies) {
      if (edge.target.kind === "table") reads.add(edge.target.name);
    }
    for (const table of forced) {
      if (object.definition.body.includes(`"${table}"`) || reads.has(table)) {
        push(
          found,
          "policy-definer-forced",
          table,
          object.identity.name,
          `this security definer function reads forced table ${table}`,
        );
      }
    }
  }
  return found;
}

function hasSelect(policies: readonly PolicyObject[], update: PolicyObject): boolean {
  const roles = new Set(update.definition.roles ?? ["public"]);
  return policies.some((policy) => {
    if (policy.identity.parent.name !== update.identity.parent.name) return false;
    if (policy.definition.command !== "select" && policy.definition.command !== "all") return false;
    const theirs = policy.definition.roles ?? ["public"];
    return theirs.some((role) => roles.has(role));
  });
}

function outsideSelect(text: string): boolean {
  const lower = text.toLowerCase();
  let at = 0;
  while (at < lower.length) {
    const found = lower.indexOf("current_setting(", at);
    if (found < 0) break;
    const before = lower.slice(Math.max(0, found - 80), found);
    if (!before.includes("select")) return true;
    at = found + "current_setting(".length;
  }
  const trimmed = lower.trim();
  return /^[a-z_][a-z0-9_.]*\s*\(/.test(trimmed) && !trimmed.startsWith("(select");
}

function push(
  found: PolicyFound[],
  rule: string,
  table: string,
  target: string,
  reason: string,
): void {
  const registered = warningRule(rule);
  if (registered === undefined) return;
  found.push({ rule: registered, table, target, reason });
}
