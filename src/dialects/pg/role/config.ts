/**
 * `roles` entries. The config holds names and environment variable names, never a URL or a password.
 */

import { OkmError } from "../../../contracts/error.js";

/** One membership. A string is the role name. Options need PostgreSQL 16. */
export type RoleMembership =
  | string
  | {
      readonly role: string;
      /** `INHERIT` option. Needs PostgreSQL 16. */
      readonly inherit?: boolean;
      /** `SET` option. Needs PostgreSQL 16. */
      readonly set?: boolean;
      /** `ADMIN` option. Needs PostgreSQL 16. */
      readonly admin?: boolean;
    };

/**
 * One declared role.
 *
 * `env` is the name of the variable that holds the role's URL. With `env`,
 * `okm roles apply` creates a login role when `pg_roles` lacks the name.
 * Without `env`, it creates a `NOLOGIN` group. An existing role keeps the
 * database's login flag and its password.
 */
export type RoleEntry = {
  readonly name: string;
  readonly env?: string;
  readonly connectionLimit?: number;
  readonly validUntil?: string;
  readonly memberOf?: readonly RoleMembership[];
  /** Reason for `BYPASSRLS`. The attribute is protected. */
  readonly bypassRls?: string;
};

/**
 * Roles named by `defineConfig`.
 *
 * `migration`, `app`, and `reporting` keep their reserved meaning. Any other
 * key is a custom role. There is no `managed`, `columns`, `login`, or `external` field.
 */
export type RolesInput = {
  readonly migration: RoleEntry;
  readonly app: RoleEntry;
  readonly reporting?: RoleEntry;
} & Readonly<Record<string, RoleEntry | undefined>>;

/** One role after the config check, with its key. */
export type NormalizedRole = RoleEntry & { readonly key: string };

const RESERVED = new Set(["migration", "app", "reporting"]);
const BANNED = [
  "superuser",
  "createRole",
  "createDb",
  "replication",
  "password",
  "passwords",
  "external",
  "login",
] as const;

/**
 * Checks `roles` and returns one entry per key.
 *
 * A string value is the old shape and is refused. Passwords and privilege
 * flags are refused. `memberOf` options are recorded here and refused on
 * PostgreSQL 15 before any SQL.
 *
 * @param input - `defineConfig({ roles })`
 * @returns Entries in key order, with `migration` and `app` first
 */
export function normalizeRoles(input: RolesInput): readonly NormalizedRole[] {
  if (input === null || typeof input !== "object") {
    throw configError("roles needs migration and app entries.");
  }
  const record = input as Record<string, unknown>;
  for (const key of BANNED) {
    if (key in record) throw configError(`roles.${key} is not a config field.`);
  }
  const migration = readEntry(record.migration, "migration");
  const app = readEntry(record.app, "app");
  if (migration.name === app.name) {
    throw configError(`Role ${migration.name} cannot be both migration and app.`);
  }
  const entries: NormalizedRole[] = [
    { key: "migration", ...migration },
    { key: "app", ...app },
  ];
  const reporting = record.reporting;
  if (reporting !== undefined) {
    const entry = readEntry(reporting, "reporting");
    if (entry.name === migration.name || entry.name === app.name) {
      throw configError(
        `Role ${entry.name} cannot be the reporting role and also migration or app.`,
      );
    }
    entries.push({ key: "reporting", ...entry });
  }
  for (const key of Object.keys(record).sort()) {
    if (RESERVED.has(key)) continue;
    const value = record[key];
    if (value === undefined) continue;
    entries.push({ key, ...readEntry(value, key) });
  }
  const names = new Map<string, string>();
  for (const entry of entries) {
    const previous = names.get(entry.name);
    if (previous !== undefined) {
      throw configError(`Role ${entry.name} is declared as ${previous} and as ${entry.key}.`);
    }
    names.set(entry.name, entry.key);
  }
  const known = new Set<string>([...names.keys(), ...entries.map((entry) => entry.key), "public"]);
  for (const entry of entries) {
    for (const member of entry.memberOf ?? []) {
      const name = typeof member === "string" ? member : member.role;
      if (!known.has(name) && !name.startsWith("pg_")) {
        throw configError(
          `memberOf names ${name}, which is not a roles key or a pg_ role. Declare the role or remove the membership.`,
        );
      }
    }
  }
  return entries;
}

/**
 * Role name for a reserved or custom key.
 *
 * @param roles - Normalized entries
 * @param key - Config key
 * @returns The SQL name, or `undefined` when the key is absent
 */
export function roleByKey(
  roles: readonly NormalizedRole[],
  key: string,
): NormalizedRole | undefined {
  return roles.find((entry) => entry.key === key);
}

function readEntry(value: unknown, key: string): RoleEntry {
  if (typeof value === "string") {
    throw configError(
      `roles.${key} is a name string. Use { name, env? }.\n  roles: { migration: { name: "okm_migrate", env: "MIGRATE_DATABASE_URL" }, app: { name: "okm_app", env: "APP_DATABASE_URL" } }\nThen set those variables and run okm roles apply --admin-env <NAME>.`,
    );
  }
  if (value === null || typeof value !== "object") {
    throw configError(`roles.${key} needs { name, env? }.`);
  }
  const record = value as Record<string, unknown>;
  for (const banned of BANNED) {
    if (banned in record) throw configError(`roles.${key}.${banned} is not a config field.`);
  }
  const name = record.name;
  if (typeof name !== "string" || name.length === 0) {
    throw configError(`roles.${key} needs a name.`);
  }
  const env = record.env;
  if (env !== undefined && (typeof env !== "string" || env.length === 0 || env.includes("="))) {
    throw configError(`roles.${key}.env is the variable name, not a URL.`);
  }
  const connectionLimit = record.connectionLimit;
  if (
    connectionLimit !== undefined &&
    (typeof connectionLimit !== "number" ||
      !Number.isInteger(connectionLimit) ||
      connectionLimit < 1)
  ) {
    throw configError(`roles.${key}.connectionLimit needs a positive integer.`);
  }
  const validUntil = record.validUntil;
  if (validUntil !== undefined && (typeof validUntil !== "string" || validUntil.length === 0)) {
    throw configError(`roles.${key}.validUntil needs a timestamp.`);
  }
  const bypassRls = record.bypassRls;
  if (bypassRls !== undefined && (typeof bypassRls !== "string" || bypassRls.trim().length === 0)) {
    throw configError(`roles.${key}.bypassRls needs the reason.`);
  }
  const memberOf = readMembers(record.memberOf, key);
  return {
    name,
    ...(typeof env === "string" ? { env } : {}),
    ...(typeof connectionLimit === "number" ? { connectionLimit } : {}),
    ...(typeof validUntil === "string" ? { validUntil } : {}),
    ...(memberOf !== undefined ? { memberOf } : {}),
    ...(typeof bypassRls === "string" ? { bypassRls } : {}),
  };
}

function readMembers(value: unknown, key: string): readonly RoleMembership[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw configError(`roles.${key}.memberOf needs a list.`);
  return value.map((item) => {
    if (typeof item === "string" && item.length > 0) return item;
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const role = record.role;
      if (typeof role !== "string" || role.length === 0) {
        throw configError(`roles.${key}.memberOf needs a role name.`);
      }
      return {
        role,
        ...(typeof record.inherit === "boolean" ? { inherit: record.inherit } : {}),
        ...(typeof record.set === "boolean" ? { set: record.set } : {}),
        ...(typeof record.admin === "boolean" ? { admin: record.admin } : {}),
      };
    }
    throw configError(`roles.${key}.memberOf needs a name or { role, inherit, set, admin }.`);
  });
}

function configError(message: string): OkmError {
  return new OkmError("OKM1910", message, {
    fix: {
      summary:
        "roles: { migration: { name, env }, app: { name, env } }. No passwords in the config.",
    },
  });
}
