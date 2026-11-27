/**
 * Slot the session role resolver fills.
 *
 * `sessionSettings(..., { roles })` reads it. A session that only names a
 * role string does not load the roles config.
 */

import type { RolesInput } from "../../dialects/pg/role/config.js";

/** Maps a logical role key through a `roles` config to a SQL role name. */
export type RoleResolver = (role: string, roles: RolesInput) => string;

let slot: RoleResolver | undefined;

/**
 * Installs the resolver. A later call replaces it.
 *
 * @param resolver - Function `sessionSettings` runs when `roles` is set
 */
export function installRoleResolver(resolver: RoleResolver): void {
  slot = resolver;
}

/**
 * The installed resolver.
 *
 * @returns The resolver, or `undefined` when nothing installed it
 */
export function readRoleResolver(): RoleResolver | undefined {
  return slot;
}

/** Drops the resolver. Tests use it so a later example starts unbound. */
export function resetRoleResolver(): void {
  slot = undefined;
}
