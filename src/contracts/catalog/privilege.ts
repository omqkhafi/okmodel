/**
 * Role, grant, and default-privilege records.
 *
 * The factories store the envelope. SQL, introspection, and the doctor
 * checks live in the dialect and in tooling.
 */

import { assertIdentifier } from "./identifier.js";
import { assertProvenance, normaliseEdges } from "./object.js";
import type {
  DefaultPrivilegeObject,
  GrantObject,
  GrantObjectRef,
  Namespace,
  ObjectIdentity,
  Owner,
  Provenance,
  RoleObject,
} from "./types.js";

/** Input for {@link roleObject}. */
export type RoleInput = {
  readonly name: string;
  readonly login?: boolean;
  readonly inherit?: boolean;
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
};

/** Input for {@link grantObject}. */
export type GrantInput = {
  readonly role: string;
  readonly object: GrantObjectRef;
  readonly privilege: string;
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
};

/** Input for {@link defaultPrivilegeObject}. */
export type DefaultPrivilegeInput = {
  readonly forRole: string;
  readonly namespace: Namespace;
  readonly objectKind: string;
  readonly grantee: string;
  readonly privilege: string;
  readonly owner?: Owner;
  readonly provenance: Provenance;
  readonly dependencies?: readonly ObjectIdentity[];
};

/**
 * Builds a role record.
 *
 * The name is an identifier. The grant key is not.
 *
 * @param input - Name, login, and inherit
 * @returns The catalog object
 */
export function roleObject(input: RoleInput): RoleObject {
  assertIdentifier(input.name, "role");
  assertProvenance(input.provenance);
  return {
    kind: "role",
    identity: { kind: "role", name: input.name },
    owner: input.owner ?? "managed",
    definition: {
      login: input.login === true,
      inherit: input.inherit !== false,
    },
    dependencies: normaliseEdges(input.dependencies ?? []),
    provenance: input.provenance,
  };
}

/**
 * Builds a grant record.
 *
 * Identity is `(role, object, privilege)`. It is not checked against the
 * 63-byte identifier limit (D119).
 *
 * @param input - Grantee, object, and one privilege
 * @returns The catalog object
 */
export function grantObject(input: GrantInput): GrantObject {
  assertIdentifier(input.role, "role");
  assertProvenance(input.provenance);
  return {
    kind: "grant",
    identity: {
      kind: "grant",
      role: input.role,
      object: input.object,
      privilege: input.privilege,
    },
    owner: input.owner ?? "managed",
    definition: {},
    dependencies: normaliseEdges(input.dependencies ?? []),
    provenance: input.provenance,
  };
}

/**
 * Builds a default-privilege record.
 *
 * Identity is `(forRole, namespace, objectKind, grantee, privilege)`.
 *
 * @param input - Creating role, schema, object kind, grantee, and privilege
 * @returns The catalog object
 */
export function defaultPrivilegeObject(input: DefaultPrivilegeInput): DefaultPrivilegeObject {
  assertIdentifier(input.forRole, "role");
  assertIdentifier(input.grantee, "role");
  assertProvenance(input.provenance);
  return {
    kind: "defaultPrivilege",
    identity: {
      kind: "defaultPrivilege",
      forRole: input.forRole,
      namespace: input.namespace,
      objectKind: input.objectKind,
      grantee: input.grantee,
      privilege: input.privilege,
    },
    owner: input.owner ?? "managed",
    definition: {},
    dependencies: normaliseEdges(input.dependencies ?? []),
    provenance: input.provenance,
  };
}
