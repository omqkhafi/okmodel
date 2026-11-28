/**
 * Command tags for event triggers.
 *
 * A common tag is suggested. Any other string is still a tag: PostgreSQL
 * checks it when the trigger is created. A tag that cannot fire for the
 * event is a lint, not a refusal.
 */

import { OkmError } from "../../../contracts/error.js";

/** Tags editors should offer. A free string is still accepted. */
export const COMMAND_TAGS = [
  "ALTER FUNCTION",
  "ALTER INDEX",
  "ALTER SCHEMA",
  "ALTER SEQUENCE",
  "ALTER TABLE",
  "ALTER TYPE",
  "ALTER VIEW",
  "COMMENT",
  "CREATE FUNCTION",
  "CREATE INDEX",
  "CREATE SCHEMA",
  "CREATE SEQUENCE",
  "CREATE TABLE",
  "CREATE TABLE AS",
  "CREATE TRIGGER",
  "CREATE TYPE",
  "CREATE VIEW",
  "DROP FUNCTION",
  "DROP INDEX",
  "DROP SCHEMA",
  "DROP SEQUENCE",
  "DROP TABLE",
  "DROP TRIGGER",
  "DROP TYPE",
  "DROP VIEW",
  "GRANT",
  "REVOKE",
  "SELECT INTO",
] as const;

/** One suggested command tag, or any other tag string. */
export type EventCommandTag = (typeof COMMAND_TAGS)[number] | (string & {});

const SHARED =
  /^(?:ALTER|CREATE|DROP|COMMENT ON) (?:DATABASE|TABLESPACE|ROLE|USER|GROUP|EVENT TRIGGER)$/;

/**
 * Uppercases tags and refuses a command on a role, a database, or a tablespace.
 *
 * `DROP EVENT TRIGGER` is kept: a guard must not block the recovery path.
 *
 * @param name - Event trigger name, for the error
 * @param tags - Tags the author wrote
 * @returns Uppercase tags, or `undefined` when the author listed none
 */
export function normaliseTags(
  name: string,
  tags: readonly string[] | undefined,
): readonly string[] | undefined {
  if (tags === undefined) return undefined;
  if (tags.length === 0) return undefined;
  const next: string[] = [];
  for (const tag of tags) {
    const text = tag.trim().replace(/\s+/g, " ").toUpperCase();
    if (text.length === 0 || text.includes("'")) {
      throw new OkmError("OKM1931", `Event trigger ${name} has an empty command tag.`, {
        fix: { summary: "Pass a command tag such as CREATE TABLE." },
      });
    }
    if (SHARED.test(text) && text !== "DROP EVENT TRIGGER") {
      throw new OkmError(
        "OKM1931",
        `Event trigger ${name} tags ${text}. Event triggers cannot fire for roles, databases, or tablespaces (0A000).`,
        { fix: { summary: "Remove that tag. Shared objects are out of this version." } },
      );
    }
    next.push(text);
  }
  return next;
}

/**
 * Reports whether a tag can fire for an event.
 *
 * `sql_drop` does not see a create. `table_rewrite` sees `ALTER TABLE` only.
 *
 * @param event - Event trigger event
 * @param tag - Uppercase command tag
 * @returns `false` when the tag can never fire
 */
export function tagFiresFor(event: string, tag: string): boolean {
  if (event === "table_rewrite") return tag === "ALTER TABLE";
  if (event === "sql_drop") return tag.startsWith("DROP ") || tag === "ALTER TABLE";
  return true;
}

/**
 * Login is refused. The other four events are stored.
 *
 * @param name - Event trigger name
 * @param event - Author text
 * @returns The stored event
 */
export function readEvent(
  name: string,
  event: string,
): "ddl_command_start" | "ddl_command_end" | "sql_drop" | "table_rewrite" {
  if (event === "login") {
    throw new OkmError(
      "OKM1931",
      `Event trigger ${name} uses login. Login triggers are refused in this version: a mistake locks every session out, including the session that would drop the trigger, and PostgreSQL BUG #19488 skips them on a standby.`,
      {
        fix: {
          summary: "Keep the check outside the database. login is not available here.",
        },
      },
    );
  }
  if (
    event !== "ddl_command_start" &&
    event !== "ddl_command_end" &&
    event !== "sql_drop" &&
    event !== "table_rewrite"
  ) {
    throw new OkmError("OKM1931", `Event trigger ${name} event ${event} is not supported.`, {
      fix: {
        summary: "Use ddl_command_start, ddl_command_end, sql_drop, or table_rewrite.",
      },
    });
  }
  return event;
}

/**
 * Maps the author flag onto the catalog letter.
 *
 * @param enabled - `true`, `false`, `replica`, or `always`
 * @returns The stored mode. `true` and absent are `origin`
 */
export function readEnabled(
  enabled: true | false | "replica" | "always" | undefined,
): "origin" | "disabled" | "replica" | "always" {
  if (enabled === undefined || enabled === true) return "origin";
  if (enabled === false) return "disabled";
  return enabled;
}

/** Placeholder a project resolves to a `roles` SQL name. */
export function roleToken(key: string): string {
  return `{okm_role:${key}}`;
}

/**
 * Replaces `{okm_role:key}` with a SQL role name.
 *
 * @param text - Function body or owner field
 * @param names - Config key to SQL role name
 * @param where - Object name, for the error
 * @returns The text with every token replaced
 */
export function resolveRoleTokens(
  text: string,
  names: ReadonlyMap<string, string>,
  where: string,
): string {
  const bare = /^okm_role:([a-zA-Z0-9_]+)$/.exec(text);
  if (bare?.[1] !== undefined) return roleName(names, bare[1], where);
  return text.replace(/\{okm_role:([a-zA-Z0-9_]+)\}/g, (_match, key: string) =>
    roleName(names, key, where).replaceAll("'", "''"),
  );
}

function roleName(names: ReadonlyMap<string, string>, key: string, where: string): string {
  const name = names.get(key);
  if (name === undefined) {
    throw new OkmError("OKM1931", `${where} names roles.${key}, and that key is not configured.`, {
      fix: { summary: `Add roles.${key} to okmodel.config.ts before planning this event trigger.` },
    });
  }
  return name;
}
