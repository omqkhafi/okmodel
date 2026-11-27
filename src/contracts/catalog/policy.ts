/**
 * Row-level security policy catalog objects.
 *
 * The factory stores the record. It does not plan SQL. Postgres DDL stays in
 * the dialect. A schema that never imports `rlsTenancy` does not load this.
 */

import { catalogError } from "../error.js";
import {
  assertIdentifier,
  assertStoredText,
  fitIdentifier,
  printedIdentifier,
} from "./identifier.js";
import { assertNamespace } from "./identity.js";
import { assertProvenance, normaliseEdges } from "./object.js";
import type {
  ObjectIdentity,
  ObjectRef,
  Owner,
  PolicyCommand,
  PolicyDefinition,
  PolicyObject,
  Provenance,
} from "./types.js";

/** Input for {@link policyObject}. */
export type PolicyInput = {
  readonly parent: ObjectRef;
  readonly name: string;
  readonly command: PolicyCommand;
  readonly expression: string;
  /** True when the table is `FORCE ROW LEVEL SECURITY`. */
  readonly force: boolean;
  /** Restrictive. Absent means permissive. */
  readonly restrictive?: true;
  /** `TO` role names. Absent means `PUBLIC` on an authored policy. */
  readonly roles?: readonly string[];
  /** `WITH CHECK` when it differs from `USING`. */
  readonly check?: string;
  /** `INSERT`: `expression` is `WITH CHECK` and there is no `USING`. */
  readonly checkOnly?: true;
  /** Row security is off on the table. The policy is still stored. */
  readonly disabled?: true;
  /** Stored on the envelope. Absent means the comment is not managed. */
  readonly comment?: string;
  readonly owner?: Owner;
  readonly provenance: Provenance;
  /** Extra edges. The parent table is always included. */
  readonly dependencies?: readonly ObjectIdentity[];
};

const POLICY_COMMANDS: readonly PolicyCommand[] = ["all", "select", "insert", "update", "delete"];

/**
 * Reports whether a policy is one `rlsTenancy` emits.
 *
 * Those policies omit every optional field. Their `CREATE POLICY` text stays
 * the text this version already shipped.
 *
 * @param definition - Policy definition
 * @returns `true` for the generated tenant and unscoped policies
 */
export function isLegacyPolicy(definition: PolicyDefinition): boolean {
  return (
    (definition.command === "all" || definition.command === "select") &&
    definition.restrictive !== true &&
    definition.roles === undefined &&
    definition.check === undefined &&
    definition.checkOnly !== true &&
    definition.disabled !== true
  );
}

/**
 * Reports whether a policy is one `rlsTenancy` emits.
 *
 * The name is `{table}_tenant` or `{table}_unscoped_select`. An authored
 * `PUBLIC` policy can have the same shape and is not this.
 *
 * @param object - Policy object
 * @returns `true` for the generated policies
 */
export function isGeneratedPolicy(object: {
  readonly identity: { readonly name: string; readonly parent: { readonly name: string } };
  readonly definition: PolicyDefinition;
}): boolean {
  if (!isLegacyPolicy(object.definition)) return false;
  const table = object.identity.parent.name;
  const name = object.identity.name;
  return name === `${table}_tenant` || name === `${table}_unscoped_select`;
}

/**
 * Predicate stored for `{table}_tenant`.
 *
 * The text is what `pg_get_expr` prints, so a replayed catalog matches.
 * An unset `app.tenant` becomes null and the comparison matches no row.
 *
 * @param column - SQL name of the tenant column
 * @param dataType - Postgres type of that column
 * @returns The `USING` and `WITH CHECK` expression
 */
export function tenantPolicyExpression(column: string, dataType: string): string {
  return `(${printedIdentifier(column)} = (NULLIF(current_setting('app.tenant'::text, true), ''::text))::${dataType})`;
}

/**
 * Predicate stored for `{table}_unscoped_select`.
 *
 * `SELECT` only. Writes stay on the tenant policy.
 *
 * @returns The `USING` expression
 */
export function unscopedPolicyExpression(): string {
  return `(current_setting('app.unscoped'::text, true) = 'on'::text)`;
}

/**
 * Builds a policy record.
 *
 * Identity is `(parent, name)`. A name past the dialect limit is fitted.
 *
 * @param input - Parent table, command, and expression
 * @returns The catalog object
 */
export function policyObject(input: PolicyInput): PolicyObject {
  assertNamespace(input.parent.namespace);
  assertIdentifier(input.parent.name, "policy parent");
  assertIdentifier(input.name, "policy");
  assertStoredText(input.expression, "policy expression");
  if (!POLICY_COMMANDS.includes(input.command)) {
    catalogError("OKM1020", `Policy ${input.name} command is not supported.`);
  }
  if (input.check !== undefined) assertStoredText(input.check, "policy check");
  if (input.comment !== undefined) assertStoredText(input.comment, "policy comment");
  assertProvenance(input.provenance);
  const parent: ObjectIdentity = {
    kind: "table",
    namespace: input.parent.namespace,
    name: input.parent.name,
  };
  const definition: PolicyDefinition = {
    command: input.command,
    expression: input.expression,
    force: input.force,
    ...(input.restrictive === true ? { restrictive: true as const } : {}),
    ...(input.roles !== undefined ? { roles: [...input.roles] } : {}),
    ...(input.check !== undefined ? { check: input.check } : {}),
    ...(input.checkOnly === true ? { checkOnly: true as const } : {}),
    ...(input.disabled === true ? { disabled: true as const } : {}),
  };
  return {
    kind: "policy",
    identity: { kind: "policy", parent: input.parent, name: fitIdentifier(input.name) },
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges([parent, ...(input.dependencies ?? [])]),
    provenance: input.provenance,
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
  };
}
