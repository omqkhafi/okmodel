/**
 * Canonical identity keys.
 *
 * Kept out of `identity.ts` so `staticNamespace` does not load the JSON encoder.
 * Plain names encode here. Anything that needs escaping uses `canonicalJson`.
 */

import { catalogError } from "../error.js";
import { canonicalJson, type Json } from "./json.js";
import type {
  DefaultPrivilegeIdentity,
  FunctionIdentity,
  GrantIdentity,
  Namespace,
  NamespaceIdentity,
  ObjectIdentity,
  ObjectRef,
} from "./types.js";

/**
 * Stable identity key.
 *
 * @param identity - Object identity
 * @returns Canonical JSON of the identity
 */
export function identityKey(identity: ObjectIdentity): string {
  const plain = plainIdentityKey(identity);
  if (plain !== undefined) return plain;
  return canonicalJson(identityToJson(identity));
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
    case "eventTrigger":
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
  if (namespace.form === "static") return { form: "static", name: namespace.name };
  return { form: "template", pattern: namespace.pattern };
}

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
    case "eventTrigger":
      if (!isPlainJsonText(identity.name)) return undefined;
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
  if (encoded === undefined || !isPlainJsonText(name)) return undefined;
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
  if (namespace.form !== "static" || !isPlainJsonText(namespace.name)) return undefined;
  return `{"form":"static","name":"${namespace.name}"}`;
}

function isPlainJsonText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code < 0x20 || code > 0x7e) return false;
  }
  return true;
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

function assertNever(value: never): never {
  return catalogError("OKM1020", `Unexpected identity ${JSON.stringify(value)}.`);
}
