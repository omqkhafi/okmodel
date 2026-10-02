/**
 * Tenant ids that may become identifiers.
 *
 * The spec allows uuid hex or `[a-z0-9_]`. A hyphenated uuid is accepted and
 * stored as lowercase hex before it is placed in a schema or database name.
 * `OKM1120` still applies to anything else.
 */

import { TargetError } from "./error.js";

const SLUG = /^[a-z0-9_]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts a tenant id or throws OKM1120.
 *
 * @param id - Caller-supplied tenant id
 * @returns The id, or its lowercase hex form when it was a uuid
 */
export function sanitizeTenantId(id: string): string {
  if (SLUG.test(id)) return id;
  if (UUID.test(id)) return id.replaceAll("-", "").toLowerCase();
  throw new TargetError("OKM1120", `Tenant id ${id} is not uuid hex or [a-z0-9_].`);
}

/**
 * Schema name for one tenant under schema-per-tenant.
 *
 * The logical template is `tenant_{id}`. The id is sanitized first.
 *
 * @param id - Tenant id
 * @returns A schema name that fits in 63 bytes
 */
export function schemaNameForTenant(id: string): string {
  return fitIdentifier("tenant_", sanitizeTenantId(id));
}

/**
 * Database name for one tenant under database-per-tenant.
 *
 * @param prefix - Run-specific prefix, already a slug
 * @param id - Tenant id
 * @returns A database name that fits in 63 bytes
 */
export function databaseNameForTenant(prefix: string, id: string): string {
  return fitIdentifier(`${prefix}_`, sanitizeTenantId(id));
}

function fitIdentifier(prefix: string, body: string): string {
  const name = `${prefix}${body}`;
  if (name.length > 63) {
    throw new TargetError("OKM1120", `Identifier ${name} exceeds 63 bytes.`);
  }
  return name;
}
