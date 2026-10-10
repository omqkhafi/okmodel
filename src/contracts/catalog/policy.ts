/**
 * Row-level security policy catalog objects.
 *
 * The factory stores the record. It does not plan SQL. Postgres DDL stays in
 * the dialect. A schema that never imports `rlsTenancy` does not load this.
 */

import { catalogError } from "../error.js";
import { assertIdentifier, assertStoredText, fitIdentifier } from "./identifier.js";
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
  readonly owner?: Owner;
  readonly provenance: Provenance;
  /** Extra edges. The parent table is always included. */
  readonly dependencies?: readonly ObjectIdentity[];
};

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
  return `(${column} = (NULLIF(current_setting('app.tenant'::text, true), ''::text))::${dataType})`;
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
  if (input.command !== "all" && input.command !== "select") {
    catalogError("OKM1020", `Policy ${input.name} command is not supported.`);
  }
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
  };
  return {
    kind: "policy",
    identity: { kind: "policy", parent: input.parent, name: fitIdentifier(input.name) },
    owner: input.owner ?? "managed",
    definition,
    dependencies: normaliseEdges([parent, ...(input.dependencies ?? [])]),
    provenance: input.provenance,
  };
}
