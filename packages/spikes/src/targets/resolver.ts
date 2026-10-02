/**
 * Turns a Target into connection configuration at execution time.
 *
 * Tenant targets go through the registry. Named targets and the single
 * `database` shorthand come from `defineConfig`. The result is not stored on
 * the plan.
 */

import { TargetError } from "./error.js";
import type { RegistryRole, ResolvedConnection, TenantRegistry } from "./registry.js";
import type { Target } from "./target.js";

/** Where a resolver reads connection configuration from. */
export type TargetSource = {
  /** `defineConfig({ database })`. Also the control database. */
  readonly database: ResolvedConnection;
  /** Named environment targets. Absent when `database` is the only target. */
  readonly targets?: Readonly<Record<string, ResolvedConnection>>;
  /** Tenant registry. */
  readonly tenants: TenantRegistry;
};

/**
 * Resolves one target.
 *
 * @param source - Config and registry
 * @param target - Logical destination
 * @param role - `app` or `migration`
 * @returns Connection configuration. Not an open connection
 */
export function resolveTarget(
  source: TargetSource,
  target: Target,
  role: RegistryRole,
): ResolvedConnection {
  if (target.class === "tenant") {
    if (target.tenantId === undefined) {
      throw new TargetError("OKM1845", `Tenant target ${target.name} has no tenant id.`);
    }
    return source.tenants.resolve(target.tenantId, { role });
  }
  const named = source.targets?.[target.name];
  if (named !== undefined) return named;
  if (target.name === "default" || source.targets === undefined) return source.database;
  throw new TargetError("OKM1845", `Unknown target ${target.name}.`);
}

/**
 * The URL a resolved configuration connects to.
 *
 * A topology uses its primary. Migration targets are always a primary.
 *
 * @param config - Resolver output
 * @returns A `postgres://` URL
 */
export function connectionUrl(config: ResolvedConnection): string {
  if (typeof config === "string") return config;
  if ("url" in config) return config.url;
  return config.primary;
}

/**
 * How many named destinations a command can see.
 *
 * `database` counts as one. Each `targets` entry counts. Tenants count.
 *
 * @param source - Config and registry
 * @returns The count
 */
export function destinationCount(source: TargetSource): number {
  const named = source.targets === undefined ? 1 : Object.keys(source.targets).length;
  return named + source.tenants.list().length;
}
