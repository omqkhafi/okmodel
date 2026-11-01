/**
 * Warns when a domain check or a `LANGUAGE sql` body reprints (D276).
 *
 * The comparison runs after `okm migrate check` has created the objects.
 * The linter itself does not connect. A matching stored text is silent.
 */

import { isDomain } from "../../contracts/catalog/enum.js";
import type { Catalog, FunctionObject } from "../../contracts/catalog/types.js";
import { escapeRegExp } from "./escape-regexp.js";
import type { LintSeverity } from "./lint-rules.js";
import { normalizedSql, statementMayReprint } from "./lint-rules.js";
import type { PlanStep } from "./plan.js";
import { canonicalTypeName } from "./type-name.js";

/** Check-stage warning for a reprinted domain check or SQL function body. */
export const REPRINT_CODE = "OKM1552";

/** One reprint comparison, before the registry sentence is attached. */
export type ReprintHit = {
  readonly severity: LintSeverity;
  readonly code: string;
  readonly place: string;
  readonly reason: string;
};

type Difference = {
  readonly kind: "domain" | "function";
  readonly name: string;
  readonly reason: string;
};

/**
 * Compares declared text with the text Postgres stored.
 *
 * A step that does not create or replace the object is skipped, so a later
 * migration does not repeat the warning. `-- okm-allow OKM1552: reason` on
 * that step silences it. An empty reason, or an allow on a statement whose
 * text matches, is OKM1510.
 *
 * @param declared - Catalog stored with the migration
 * @param stored - Catalog introspection read back after the replay
 * @param steps - Statements of that migration, including allows
 * @returns Findings in catalog order
 */
export function reprintHits(
  declared: Catalog,
  stored: Catalog,
  steps: readonly PlanStep[],
): readonly ReprintHit[] {
  const hits: ReprintHit[] = [];
  const silenced = new Set<number>();
  for (const difference of differences(declared, stored)) {
    const index = stepIndex(steps, difference.kind, difference.name);
    if (index === undefined) continue;
    const step = steps[index];
    const allow = step?.allows?.find((item) => item.code === REPRINT_CODE);
    if (allow !== undefined && allow.reason.trim().length > 0) {
      silenced.add(index);
      continue;
    }
    hits.push({
      severity: "warning",
      code: REPRINT_CODE,
      place: `step ${String(index + 1)}`,
      reason: difference.reason,
    });
  }
  steps.forEach((step, index) => {
    for (const allow of step.allows ?? []) {
      if (allow.code !== REPRINT_CODE) continue;
      const place = `step ${String(index + 1)}`;
      if (allow.reason.trim().length === 0) {
        hits.push({
          severity: "error",
          code: "OKM1510",
          place,
          reason: "override needs a reason",
        });
        continue;
      }
      if (silenced.has(index)) continue;
      if (hits.some((item) => item.place === place && item.code === REPRINT_CODE)) continue;
      if (!statementMayReprint(step.sql)) continue;
      hits.push({
        severity: "error",
        code: "OKM1510",
        place,
        reason: `override ${REPRINT_CODE} does not match this statement`,
      });
    }
  });
  return hits;
}

function differences(declared: Catalog, stored: Catalog): readonly Difference[] {
  const found: Difference[] = [];
  const storedDomains = domainChecks(stored);
  for (const [name, check] of domainChecks(declared)) {
    const live = storedDomains.get(name);
    if (live === undefined || live === check) continue;
    found.push({
      kind: "domain",
      name,
      reason: `domain ${name} check reprints differently`,
    });
  }
  const storedFunctions = sqlBodies(stored);
  for (const [key, body] of sqlBodies(declared)) {
    const live = storedFunctions.get(key);
    if (live === undefined || live.body === body.body) continue;
    found.push({
      kind: "function",
      name: body.name,
      reason: `function ${body.name} body reprints differently`,
    });
  }
  return found;
}

function domainChecks(source: Catalog): ReadonlyMap<string, string> {
  const checks = new Map<string, string>();
  for (const object of source.objects) {
    if (object.kind !== "type" || !isDomain(object.definition)) continue;
    checks.set(object.identity.name, object.definition.check.trim());
  }
  return checks;
}

function sqlBodies(
  source: Catalog,
): ReadonlyMap<string, { readonly name: string; readonly body: string }> {
  const bodies = new Map<string, { readonly name: string; readonly body: string }>();
  for (const object of source.objects) {
    if (object.kind !== "function" || object.definition.language !== "sql") continue;
    bodies.set(functionKey(object), {
      name: object.identity.name,
      body: object.definition.body.trim(),
    });
  }
  return bodies;
}

function functionKey(object: FunctionObject): string {
  const args = object.identity.argTypes.map((typeName) => canonicalTypeName(typeName)).join(",");
  return `${object.identity.name}(${args})`;
}

function stepIndex(
  steps: readonly PlanStep[],
  kind: Difference["kind"],
  name: string,
): number | undefined {
  let found: number | undefined;
  steps.forEach((step, index) => {
    if (mentions(normalizedSql(step.sql), kind, name)) found = index;
  });
  return found;
}

function mentions(text: string, kind: Difference["kind"], name: string): boolean {
  if (kind === "domain" && !/^(?:create|alter) domain\b/.test(text)) return false;
  if (kind === "function") {
    if (!/^create(?: or replace)? function\b/.test(text) || !/\blanguage sql\b/.test(text)) {
      return false;
    }
  }
  const quoted = `"${name}"`;
  if (text.includes(quoted)) return true;
  return new RegExp(`\\b${escapeRegExp(name.toLowerCase())}\\b`).test(text);
}
