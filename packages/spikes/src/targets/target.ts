/**
 * A Target is a logical destination.
 *
 * It carries a name, a class, a protection flag, and a namespace binding.
 * It does not carry a URL, a credential, a host, or a pool (invariant H).
 */

/** `shared` is one destination. `tenant` is one entry from the registry. */
export type TargetClass = "shared" | "tenant";

/** How tenant targets are placed. `shared` is the control or environment target. */
export type TargetStrategy = "shared" | "schemaPerTenant" | "databasePerTenant";

/**
 * One migration or tenancy destination.
 *
 * Connection configuration is not a field. The resolver produces it at
 * execution time.
 */
export type Target = {
  /** `tenant:<id>` for a tenant. Environment targets use their config name. */
  readonly name: string;
  /** Shared or tenant. */
  readonly class: TargetClass;
  /** Protected targets refuse non-additive work unless the caller opts in. */
  readonly protected: boolean;
  /**
   * Logical namespace.
   *
   * `tenant_{id}` is the schema-per-tenant template. Database-per-tenant uses
   * `public` inside that tenant's database. Shared targets use a static name.
   */
  readonly namespace: string;
  /** Placement strategy. Not a connection. */
  readonly strategy: TargetStrategy;
  /** Present when `class` is `tenant`. */
  readonly tenantId?: string;
};

/**
 * Names a tenant target.
 *
 * @param id - Sanitized tenant id
 * @returns `tenant:<id>`
 */
export function tenantTargetName(id: string): string {
  return `tenant:${id}`;
}

/**
 * The one shared target `defineConfig({ database })` stands for.
 *
 * @param name - Target name. The shorthand is `default`
 * @param protectedTarget - Protection flag
 * @param namespace - Static namespace. Default `app`
 * @returns A shared target with no connection fields
 */
export function sharedTarget(name: string, protectedTarget: boolean, namespace = "app"): Target {
  return {
    name,
    class: "shared",
    protected: protectedTarget,
    namespace,
    strategy: "shared",
  };
}
