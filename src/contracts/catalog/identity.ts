/**
 * Namespaces, identity keys, and tenant resolution.
 *
 * The identity key is canonical JSON, so key order and runtime do not change it.
 * Resolving a template never rewrites the identity.
 */

import { catalogError } from "../error.js";
import { assertIdentifier } from "./identifier.js";
import type { Namespace, ObjectIdentity, ObjectKind, ObjectRef } from "./types.js";

export { identityKey, identityToJson, namespaceToJson } from "./identity-key.js";

const UUID_HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A concrete schema name.
 *
 * @param name - Schema name stored in the catalog
 * @returns A namespace that is not a template
 */
export function staticNamespace(name: string): Namespace {
  assertIdentifier(name, "namespace");
  return { form: "static", name };
}

/**
 * A namespace template such as `tenant_{id}`.
 *
 * The pattern must contain `{id}`. Every other character is an identifier
 * character. The pattern is stored as written.
 *
 * @param pattern - Pattern containing the `{id}` placeholder
 * @returns A template namespace
 */
export function templateNamespace(pattern: string): Namespace {
  const placeholders = pattern.split("{id}").length - 1;
  if (placeholders < 1) {
    catalogError("OKM1122", `Namespace template ${pattern} must contain {id}.`);
  }
  const stripped = pattern.replaceAll("{id}", "");
  if (!/^[A-Za-z0-9_]*$/.test(stripped)) {
    catalogError(
      "OKM1122",
      `Namespace template ${pattern} may contain only letters, digits, underscores, and {id}.`,
    );
  }
  return { form: "template", pattern };
}

/**
 * Rejects a namespace that cannot be stored.
 *
 * Static names follow the identifier rules. Templates must contain `{id}`.
 *
 * @param namespace - Namespace to check
 */
export function assertNamespace(namespace: Namespace): void {
  if (namespace.form === "static") {
    assertIdentifier(namespace.name, "namespace");
    return;
  }
  templateNamespace(namespace.pattern);
}

/**
 * Resolves a namespace for one tenant id.
 *
 * Static namespaces return their name. Templates substitute `{id}`. A
 * hyphenated UUID is written as 32 lowercase hex digits so the result can
 * enter an identifier. The id must be that UUID or `[a-z0-9_]`.
 *
 * @param namespace - Logical namespace
 * @param tenantId - Tenant id. Ignored for a static namespace
 * @returns The schema name to use at execution time
 */
export function resolveNamespace(namespace: Namespace, tenantId = ""): string {
  if (namespace.form === "static") {
    assertIdentifier(namespace.name, "namespace");
    return namespace.name;
  }
  const resolved = namespace.pattern.replaceAll("{id}", canonicalTenantId(tenantId));
  assertIdentifier(resolved, "namespace");
  return resolved;
}

/**
 * Reports whether the dialect length limit applies to a kind.
 *
 * Grants and default privileges use a structured key and are exempt (D119).
 *
 * @param kind - Object kind
 * @returns `false` for grants and default privileges
 */
export function identifierLimitApplies(kind: ObjectKind): boolean {
  return kind !== "grant" && kind !== "defaultPrivilege";
}

/**
 * Short label for an identity, used in error messages.
 *
 * @param identity - Object identity
 * @returns Kind and name
 */
export function identityLabel(identity: ObjectIdentity): string {
  if (identity.kind === "grant") {
    return `grant ${identity.role} ${identity.privilege}`;
  }
  if (identity.kind === "defaultPrivilege") {
    return `default privilege ${identity.grantee} ${identity.privilege}`;
  }
  return `${identity.kind} ${identity.name}`;
}

/**
 * Reports whether two parent refs are the same logical object.
 *
 * @param left - First ref
 * @param right - Second ref
 * @returns `true` when namespace and name match
 */
export function sameRef(left: ObjectRef, right: ObjectRef): boolean {
  return left.name === right.name && sameNamespace(left.namespace, right.namespace);
}

/**
 * Reports whether two namespaces are the same logical namespace.
 *
 * @param left - First namespace
 * @param right - Second namespace
 * @returns `true` when form and text match
 */
export function sameNamespace(left: Namespace, right: Namespace): boolean {
  if (left.form !== right.form) {
    return false;
  }
  return left.form === "static"
    ? left.name === (right as typeof left).name
    : left.pattern === (right as typeof left).pattern;
}

function canonicalTenantId(tenantId: string): string {
  if (UUID_HEX.test(tenantId)) {
    return tenantId.replaceAll("-", "").toLowerCase();
  }
  if (/^[a-z0-9_]+$/.test(tenantId)) {
    return tenantId;
  }
  catalogError("OKM1122", `Tenant id ${tenantId} must be a UUID or lowercase [a-z0-9_].`);
}
