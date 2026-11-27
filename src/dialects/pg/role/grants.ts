/**
 * Keyed grants stored on a table, view, function, or schema.
 *
 * The keys are `roles` keys, or `public`. `"all"` is refused. The catalog
 * stores one grant object per privilege. SQL is planned later.
 */

import { OkmError } from "../../../contracts/error.js";
import type { NormalizedRole } from "./config.js";

/** Privileges a table grant may name. */
export type TablePrivilege =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "truncate"
  | "references"
  | "trigger"
  | "maintain";

/** Column lists. Each key is one privilege. */
export type ColumnGrantShape = {
  readonly select?: readonly string[];
  readonly insert?: readonly string[];
  readonly update?: readonly string[];
  readonly references?: readonly string[];
};

/** One role's grant on a table or view. */
export type RelationGrant = "read" | "write" | readonly TablePrivilege[] | ColumnGrantShape;

/** One role's grant on a materialized view. */
export type MatviewGrant = "read" | "maintain" | readonly ("select" | "maintain")[];

/** Grants on one object, keyed by role key. */
export type GrantsOption = Readonly<Record<string, unknown>>;

/** One privilege the plan should grant. */
export type ExpandedGrant = {
  readonly role: string;
  readonly privilege: string;
  /** True when the grantee is PUBLIC. */
  readonly public: boolean;
  /** Column names when the privilege is column-level. */
  readonly columns?: readonly string[];
};

/** A warning the plan prints. It does not stop the plan. */
export type GrantWarning = {
  readonly summary: string;
};

const TABLE_PRIVILEGES = new Set<string>([
  "select",
  "insert",
  "update",
  "delete",
  "truncate",
  "references",
  "trigger",
  "maintain",
]);
const APP_WARN = new Set(["truncate", "references", "trigger", "maintain"]);
const WRITE = new Set([
  "insert",
  "update",
  "delete",
  "truncate",
  "references",
  "trigger",
  "maintain",
]);

/**
 * Expands one object's `grants` option into privileges.
 *
 * An unknown role key is OKM1910 before any step. `"all"` is OKM1910.
 * `reporting` cannot receive a write. The role argument is the SQL name.
 *
 * @param grants - The option on the object
 * @param kind - Catalog kind
 * @param roles - Declared roles
 * @param where - Object name for the message
 * @returns Privileges and warnings
 */
export function expandGrants(
  grants: unknown,
  kind: string,
  roles: readonly NormalizedRole[],
  where: string,
): { readonly grants: readonly ExpandedGrant[]; readonly warnings: readonly GrantWarning[] } {
  if (grants === null || typeof grants !== "object" || Array.isArray(grants)) {
    throw new OkmError("OKM1910", `${where} grants need an object keyed by role.`, {
      fix: { summary: 'Use grants: { app: "write", reporting: "read" }.' },
    });
  }
  const keys = new Map(roles.map((entry) => [entry.key, entry]));
  const warnings: GrantWarning[] = [];
  const expanded: ExpandedGrant[] = [];
  for (const key of Object.keys(grants as object).sort()) {
    const raw = (grants as Record<string, unknown>)[key];
    if (raw === "all") {
      throw new OkmError(
        "OKM1910",
        `${where} grants ${key}: "all". ALL expands differently on each PostgreSQL major.`,
        { fix: { summary: "Name the privileges, or use read or write." } },
      );
    }
    const entry = key === "public" ? undefined : keys.get(key);
    if (key !== "public" && entry === undefined) {
      throw new OkmError(
        "OKM1910",
        `${where} grants ${key}, which is not a roles key.\n  roles: { migration: { name: "okm_migrate", env: "MIGRATE_DATABASE_URL" }, app: { name: "okm_app", env: "APP_DATABASE_URL" } }\nThen run okm roles apply --admin-env <NAME> and okm apply.`,
        { fix: { summary: "Add the role to roles, or remove the grant." } },
      );
    }
    const role = key === "public" ? "public" : entry!.name;
    const privileges = privilegesFor(raw, kind, where, key);
    if (entry?.key === "reporting") {
      for (const privilege of privileges) {
        const base = (privilege.split("(")[0] ?? privilege).toLowerCase();
        if (WRITE.has(base)) {
          throw new OkmError(
            "OKM1910",
            `Role ${role} is the reporting role and cannot be granted ${base}.`,
            { fix: { summary: "Grant select, or use the application role for writes." } },
          );
        }
      }
    }
    if (key === "app") {
      for (const privilege of privileges) {
        const base = (privilege.split("(")[0] ?? privilege).toLowerCase();
        if (APP_WARN.has(base)) {
          warnings.push({
            summary: `${where} grants ${base} to app. The application role rarely needs it.`,
          });
        }
      }
    }
    for (const privilege of privileges) {
      const open = privilege.indexOf("(");
      expanded.push({
        role,
        privilege: open < 0 ? privilege.toUpperCase() : privilege,
        public: key === "public",
        ...(open >= 0
          ? {
              columns: privilege
                .slice(open + 1, -1)
                .split(",")
                .filter((name) => name.length > 0),
            }
          : {}),
      });
    }
    if (privileges.some((privilege) => privilege.includes("(")) && key !== "public") {
      warnings.push({
        summary: `${where} grants ${key} column privileges. select * is not limited to those columns and fails when a column is missing.`,
      });
    }
  }
  return { grants: expanded, warnings };
}

/**
 * Three-line refusal when an object sets `grants` and the config has no `roles`.
 *
 * @param where - Object name
 * @returns The error
 */
export function grantsNeedRoles(where: string): OkmError {
  return new OkmError(
    "OKM1910",
    `${where} sets grants and roles is not configured.\n  roles: { migration: { name: "okm_migrate", env: "MIGRATE_DATABASE_URL" }, app: { name: "okm_app", env: "APP_DATABASE_URL" } }\nThen run okm roles apply --admin-env <NAME> and okm apply.`,
    { fix: { summary: "Add roles to okmodel.config.ts." } },
  );
}

function privilegesFor(
  value: unknown,
  kind: string,
  where: string,
  key: string,
): readonly string[] {
  if (value === "read") return readPreset(kind, where, key);
  if (value === "write") return writePreset(kind, where, key);
  if (value === "maintain") return maintainPreset(kind, where, key);
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== "string") throw bad(where, key);
      return onePrivilege(item, kind, where, key);
    });
  }
  if (value !== null && typeof value === "object") return columnPrivileges(value, kind, where, key);
  throw bad(where, key);
}

function readPreset(kind: string, where: string, key: string): readonly string[] {
  if (kind === "function" || kind === "procedure") throw bad(where, key);
  if (kind === "schema" || kind === "type" || kind === "sequence") {
    return kind === "sequence" ? ["SELECT"] : ["USAGE"];
  }
  return ["SELECT"];
}

function writePreset(kind: string, where: string, key: string): readonly string[] {
  if (kind === "materializedView") {
    throw new OkmError(
      "OKM1910",
      `${where} grants ${key}: "write". A materialized view is read or maintain.`,
      {
        fix: { summary: 'Use "read" or "maintain".' },
      },
    );
  }
  if (kind !== "table" && kind !== "view") throw bad(where, key);
  return ["SELECT", "INSERT", "UPDATE", "DELETE"];
}

function maintainPreset(kind: string, where: string, key: string): readonly string[] {
  if (kind !== "materializedView") throw bad(where, key);
  return ["MAINTAIN"];
}

function onePrivilege(name: string, kind: string, where: string, key: string): string {
  const privilege = name.toLowerCase();
  if (privilege === "all") {
    throw new OkmError("OKM1910", `${where} grants ${key}: "all".`, {
      fix: { summary: "Name the privileges." },
    });
  }
  const allowed = allowedFor(kind);
  if (!allowed.has(privilege)) throw bad(where, key);
  return privilege.toUpperCase();
}

function columnPrivileges(
  value: object,
  kind: string,
  where: string,
  key: string,
): readonly string[] {
  if (kind !== "table" && kind !== "view" && kind !== "materializedView") throw bad(where, key);
  const record = value as Record<string, unknown>;
  const out: string[] = [];
  for (const privilege of ["select", "insert", "update", "references"] as const) {
    const columns = record[privilege];
    if (columns === undefined) continue;
    if (!Array.isArray(columns) || columns.some((item) => typeof item !== "string")) {
      throw bad(where, key);
    }
    if (columns.length === 0) continue;
    out.push(
      `${privilege.toUpperCase()}(${[...columns].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)).join(",")})`,
    );
  }
  if (out.length === 0) throw bad(where, key);
  return out;
}

function allowedFor(kind: string): ReadonlySet<string> {
  if (kind === "sequence") return new Set(["usage", "select", "update"]);
  if (kind === "function" || kind === "procedure") return new Set(["execute"]);
  if (kind === "schema") return new Set(["usage", "create"]);
  if (kind === "type") return new Set(["usage"]);
  if (kind === "materializedView") return new Set(["select", "maintain"]);
  return TABLE_PRIVILEGES;
}

function bad(where: string, key: string): OkmError {
  return new OkmError("OKM1910", `${where} grants ${key} is not a privilege this object accepts.`, {
    fix: { summary: "Use a preset or a list of privileges for that object kind." },
  });
}
