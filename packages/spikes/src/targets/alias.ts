/**
 * Aliasing guard (section 19.8).
 *
 * An unprotected target that resolves to the same host, port, and database as
 * a protected target is refused (OKM1852). Two unprotected targets may share
 * a database. Schema-per-tenant tenants share one database, so a protected
 * tenant and an unprotected tenant on that strategy trip this guard.
 */

import { TargetError } from "./error.js";

/** A resolved target, without credentials. */
export type PhysicalTarget = {
  /** Logical name. */
  readonly name: string;
  /** Protected-target policy flag. */
  readonly protected: boolean;
  /** Server host. */
  readonly host: string;
  /** Server port. Empty when the URL omitted it. */
  readonly port: string;
  /** Database name. */
  readonly database: string;
};

/**
 * Refuses an unprotected target that shares a physical database with a protected one.
 *
 * @param targets - Resolved targets
 */
export function assertNoProtectedAlias(targets: readonly PhysicalTarget[]): void {
  const protectedKeys = new Map<string, string>();
  for (const target of targets) {
    if (!target.protected) continue;
    protectedKeys.set(physicalKey(target), target.name);
  }
  for (const target of targets) {
    if (target.protected) continue;
    const match = protectedKeys.get(physicalKey(target));
    if (match === undefined) continue;
    throw new TargetError(
      "OKM1852",
      `${target.name} resolves to the same database as protected target ${match}.`,
    );
  }
}

function physicalKey(target: PhysicalTarget): string {
  return `${target.host.toLowerCase()}:${target.port}/${target.database.toLowerCase()}`;
}
