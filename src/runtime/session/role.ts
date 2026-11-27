/**
 * Role map for `sessionSettings(..., { roles })` (`okmodel/session/role`).
 *
 * Call {@link bindSessionRoles} before passing `roles`. A session that only
 * names a role string does not import this module.
 */

import { normalizeRoles, type RolesInput } from "../../dialects/pg/role/config.js";
import { installRoleResolver } from "./role-slot.js";

/**
 * Installs the roles resolver `sessionSettings` uses.
 *
 * @returns Nothing
 */
export function bindSessionRoles(): void {
  installRoleResolver((role, roles) => {
    const found = normalizeRoles(roles).find((entry) => entry.key === role);
    return found === undefined ? role : found.name;
  });
}

export type { RolesInput };
