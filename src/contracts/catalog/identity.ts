/**
 * Namespaces, identity keys, and tenant resolution.
 *
 * The identity key is canonical JSON, so key order and runtime do not change it.
 * Resolving a template never rewrites the identity.
 */

import { catalogError } from "../error.js";
import { assertIdentifier } from "./identifier.js";
import { canonicalJson, type Json } from "./json.js";
import type {
  DefaultPrivilegeIdentity,
  FunctionIdentity,
  GrantIdentity,
  Namespace,
  NamespaceIdentity,
  ObjectIdentity,
  ObjectKind,
  ObjectRef,
} from "./types.js";

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
 * Stable identity key.
 *
 * @param identity - Object identity
 * @returns Canonical JSON of the identity
 */
export function identityKey(identity: ObjectIdentity): string {
  const plain = plainIdentityKey(identity);
  if (plain !== undefined) {
    return plain;
  }
  return canonicalJson(identityToJson(identity));
}

/**
 * Canonical JSON for identities whose text needs no escaping.
 *
 * The general encoder stays unused on this path, so a schema of plain names
 * does not compile it. Any quote, backslash, or non-ASCII character falls
 * through to {@link canonicalJson}.
 *
 * @param identity - Object identity
 * @returns Canonical text, or `undefined` when the general encoder is required
 */
function plainIdentityKey(identity: ObjectIdentity): string | undefined {
  switch (identity.kind) {
    case "table":
    case "view":
    case "materializedView":
    case "sequence":
    case "type":
      return namespaceIdentityKey(identity.kind, identity.name, identity.namespace);
    case "column":
    case "index":
    case "constraint":
    case "trigger":
    case "policy":
      return anchoredIdentityKey(identity.kind, identity.name, identity.parent);
    case "role":
    case "extension":
      if (!isPlainJsonText(identity.name)) {
        return undefined;
      }
      return `{"kind":"${identity.kind}","name":"${identity.name}"}`;
    default:
      return undefined;
  }
}

function namespaceIdentityKey(
  kind: string,
  name: string,
  namespace: Namespace,
): string | undefined {
  const encoded = staticNamespaceKey(namespace);
  if (encoded === undefined || !isPlainJsonText(name)) {
    return undefined;
  }
  return `{"kind":"${kind}","name":"${name}","namespace":${encoded}}`;
}

function anchoredIdentityKey(kind: string, name: string, parent: ObjectRef): string | undefined {
  const encoded = staticNamespaceKey(parent.namespace);
  if (encoded === undefined || !isPlainJsonText(name) || !isPlainJsonText(parent.name)) {
    return undefined;
  }
  return `{"kind":"${kind}","name":"${name}","parent":{"name":"${parent.name}","namespace":${encoded}}}`;
}

function staticNamespaceKey(namespace: Namespace): string | undefined {
  if (namespace.form !== "static" || !isPlainJsonText(namespace.name)) {
    return undefined;
  }
  return `{"form":"static","name":"${namespace.name}"}`;
}

function isPlainJsonText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
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
  if (left.form === "static" && right.form === "static") {
    return left.name === right.name;
  }
  if (left.form === "template" && right.form === "template") {
    return left.pattern === right.pattern;
  }
  return false;
}

/**
 * Canonical JSON for an identity.
 *
 * @param identity - Object identity
 * @returns JSON object
 */
export function identityToJson(identity: ObjectIdentity): Json {
  switch (identity.kind) {
    case "table":
    case "view":
    case "materializedView":
    case "sequence":
    case "type":
      return namespaceIdentityJson(identity);
    case "column":
    case "index":
    case "constraint":
    case "trigger":
    case "policy":
      return {
        kind: identity.kind,
        name: identity.name,
        parent: refToJson(identity.parent),
      };
    case "function":
      return functionIdentityJson(identity);
    case "grant":
      return grantIdentityJson(identity);
    case "defaultPrivilege":
      return defaultPrivilegeIdentityJson(identity);
    case "role":
    case "extension":
      return { kind: identity.kind, name: identity.name };
    default:
      return assertNever(identity);
  }
}

/**
 * Canonical JSON for a namespace.
 *
 * @param namespace - Static or template namespace
 * @returns JSON object
 */
export function namespaceToJson(namespace: Namespace): Json {
  if (namespace.form === "static") {
    return { form: "static", name: namespace.name };
  }
  return { form: "template", pattern: namespace.pattern };
}

function namespaceIdentityJson(identity: NamespaceIdentity): Json {
  return {
    kind: identity.kind,
    name: identity.name,
    namespace: namespaceToJson(identity.namespace),
  };
}

function functionIdentityJson(identity: FunctionIdentity): Json {
  return {
    argTypes: identity.argTypes,
    kind: identity.kind,
    name: identity.name,
    namespace: namespaceToJson(identity.namespace),
  };
}

function grantIdentityJson(identity: GrantIdentity): Json {
  return {
    kind: identity.kind,
    object: {
      kind: identity.object.kind,
      name: identity.object.name,
      namespace: namespaceToJson(identity.object.namespace),
    },
    privilege: identity.privilege,
    role: identity.role,
  };
}

function defaultPrivilegeIdentityJson(identity: DefaultPrivilegeIdentity): Json {
  return {
    forRole: identity.forRole,
    grantee: identity.grantee,
    kind: identity.kind,
    namespace: namespaceToJson(identity.namespace),
    objectKind: identity.objectKind,
    privilege: identity.privilege,
  };
}

function refToJson(ref: ObjectRef): Json {
  return { name: ref.name, namespace: namespaceToJson(ref.namespace) };
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

function assertNever(value: never): never {
  return catalogError("OKM1020", `Unexpected identity ${JSON.stringify(value)}.`);
}
