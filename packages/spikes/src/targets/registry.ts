/**
 * Tenant registry.
 *
 * Deployment data: which tenants exist, and how to reach them. `list()`
 * returns Targets. `resolve()` returns a connection configuration. The
 * registry is not a connection (invariant G).
 */

import type { Sql } from "postgres";

import { quoteIdent } from "../catalog/sql.js";
import { TargetError } from "./error.js";
import { databaseNameForTenant, sanitizeTenantId, schemaNameForTenant } from "./sanitize.js";
import { tenantTargetName, type Target, type TargetStrategy } from "./target.js";
import { formatPostgresUrl, parsePostgresUrl, type PostgresUrlParts } from "./url.js";

/** Which credential `resolve` should return. */
export type RegistryRole = "app" | "migration";

/**
 * What `resolve` may return.
 *
 * A string is a URL. An object is a URL plus protection, or a topology whose
 * primary is the migration target. None of these is an open connection.
 */
export type ResolvedConnection =
  | string
  | { readonly url: string; readonly protected?: boolean }
  | { readonly primary: string; readonly replicas?: readonly string[] };

/**
 * Resolves tenant ids to Targets and Targets to connection configuration.
 *
 * `list` is registry order. `create` exists for database-per-tenant and
 * creates an empty database. It does not install a schema.
 */
export type TenantRegistry = {
  /** Targets currently in the registry, in registry order. */
  list(): readonly Target[];
  /**
   * Connection configuration for one tenant.
   *
   * @param id - Tenant id
   * @param options - `app` or `migration` role
   * @returns A URL, `{ url, protected }`, or a topology. Not a connection
   */
  resolve(id: string, options: { readonly role: RegistryRole }): ResolvedConnection;
  /**
   * Creates the empty database for database-per-tenant.
   *
   * Infrastructure, outside the migration planner. Absent when the strategy
   * does not need it.
   *
   * @param id - Tenant id
   */
  create?(id: string): Promise<void>;
};

/** A registry the spike can mutate: signup, and credential rotation. */
export type MemoryRegistry = TenantRegistry & {
  /** Strategy this registry was built for. */
  readonly strategy: "schemaPerTenant" | "databasePerTenant";
  /**
   * Registers a tenant.
   *
   * @param id - Tenant id
   * @param options - Protection flag
   * @returns The Target, with no connection fields
   */
  addTenant(id: string, options?: { readonly protected?: boolean }): Target;
  /**
   * Replaces the password `resolve` will return.
   *
   * Plans are not an argument and are not updated.
   *
   * @param id - Tenant id
   * @param role - Which role's password changes
   * @param password - New password
   */
  rotate(id: string, role: RegistryRole, password: string): void;
  /**
   * Database name `create` uses.
   *
   * @param id - Tenant id
   * @returns The physical database name
   */
  databaseName(id: string): string;
  /**
   * Schema name for schema-per-tenant.
   *
   * @param id - Tenant id
   * @returns The physical schema name
   */
  schemaName(id: string): string;
};

type Entry = {
  readonly id: string;
  readonly protected: boolean;
  appPassword: string;
  migrationPassword: string;
};

/**
 * In-memory registry backed by one Postgres origin.
 *
 * Schema-per-tenant tenants share `database`. Database-per-tenant tenants each
 * get a database named from `prefix` and the sanitized id. `create` runs
 * `CREATE DATABASE` on `admin`.
 *
 * @param options - Origin, role passwords, and the admin connection
 * @returns A registry
 */
export function createMemoryRegistry(options: {
  readonly strategy: "schemaPerTenant" | "databasePerTenant";
  readonly origin: string;
  readonly appPassword: string;
  readonly migrationPassword: string;
  readonly database: string;
  readonly prefix: string;
  readonly admin?: Sql;
}): MemoryRegistry {
  const origin = parsePostgresUrl(options.origin);
  const entries = new Map<string, Entry>();

  function entryFor(id: string): Entry {
    const key = sanitizeTenantId(id);
    const found = entries.get(key);
    if (found === undefined) {
      throw new TargetError("OKM1845", `Unknown tenant ${id}.`);
    }
    return found;
  }

  function toTarget(entry: Entry): Target {
    const strategy: TargetStrategy = options.strategy;
    return {
      name: tenantTargetName(entry.id),
      class: "tenant",
      protected: entry.protected,
      namespace: options.strategy === "schemaPerTenant" ? "tenant_{id}" : "public",
      strategy,
      tenantId: entry.id,
    };
  }

  function urlFor(entry: Entry, role: RegistryRole): string {
    const password = role === "app" ? entry.appPassword : entry.migrationPassword;
    const database =
      options.strategy === "databasePerTenant"
        ? databaseNameForTenant(options.prefix, entry.id)
        : options.database;
    const parts: PostgresUrlParts = {
      user: origin.user,
      password,
      host: origin.host,
      port: origin.port,
      database,
    };
    return formatPostgresUrl(parts);
  }

  const registry: MemoryRegistry = {
    strategy: options.strategy,
    list() {
      return [...entries.values()].map(toTarget);
    },
    resolve(id, resolveOptions) {
      const entry = entryFor(id);
      return { url: urlFor(entry, resolveOptions.role), protected: entry.protected };
    },
    addTenant(id, tenantOptions) {
      const key = sanitizeTenantId(id);
      if (entries.has(key)) {
        throw new TargetError("OKM1845", `Tenant ${id} is already registered.`);
      }
      const entry: Entry = {
        id: key,
        protected: tenantOptions?.protected ?? false,
        appPassword: options.appPassword,
        migrationPassword: options.migrationPassword,
      };
      entries.set(key, entry);
      return toTarget(entry);
    },
    rotate(id, role, password) {
      const entry = entryFor(id);
      if (role === "app") entry.appPassword = password;
      else entry.migrationPassword = password;
    },
    databaseName(id) {
      return databaseNameForTenant(options.prefix, entryFor(id).id);
    },
    schemaName(id) {
      return schemaNameForTenant(entryFor(id).id);
    },
  };

  if (options.strategy === "databasePerTenant" && options.admin !== undefined) {
    const admin = options.admin;
    registry.create = async (id) => {
      const name = registry.databaseName(id);
      await admin.unsafe(`create database ${quoteIdent(name)}`);
    };
  }

  return registry;
}
