/**
 * Live drift for `okm check`.
 *
 * A database that has never been pushed has no `okm_meta` and is left alone.
 * After push, the introspected catalog is planned back to the schema. Each
 * view is reprinted on this server first, so a `pg_get_viewdef` spelling is
 * not drift. Any remaining statement is OKM1520. `okm_meta`, `okm_history`,
 * and `okm_backfill` are omitted by the planner.
 */

import postgres, { type Sql } from "postgres";

import { OkmError } from "../../contracts/error.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { isDomain } from "../../contracts/catalog/enum.js";
import type { CatalogObject } from "../../contracts/catalog/types.js";
import {
  introspectSchema,
  reprintDomainCheck,
  type CatalogQuery,
  type IntrospectOptions,
} from "../../dialects/pg/introspect.js";
import { sealViews } from "../../dialects/pg/view/scratch.js";
import type { RolesInput } from "../../dialects/pg/role/index.js";
import { planMigration } from "./plan.js";
import { finishQuiet, sessionFailure } from "./lost.js";
import { assertDirectConnection, assertStableBackend } from "./policy.js";

/**
 * Refuses when the connected database differs from the schema.
 *
 * @param url - Target URL
 * @param author - Schema catalog, including roles when the config names them
 * @param roles - `defineConfig({ roles })`, when set
 */
export async function assertAuthorDrift(
  url: string,
  author: Catalog,
  roles?: RolesInput,
  allowPooler = false,
): Promise<void> {
  assertDirectConnection(url, allowPooler);
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    await assertStableBackend(async () => {
      const rows = await sql<{ pid: string }[]>`select pg_backend_pid()::text as pid`;
      return rows[0]?.pid ?? "";
    }, allowPooler);
    const schema = authorSchema(author);
    const present = await sql<{ reg: string | null }[]>`
      select to_regclass(${metaReg(schema)})::text as reg
    `;
    if (present[0]?.reg == null) return;
    const runner = catalogQuery(sql);
    const authorOnServer = await sealDomainChecks(runner, await sealViews(runner, author));
    const live = await introspectSchema(runner, schema, schema, managedRoleOptions(roles));
    const plan = planMigration({ before: live, after: authorOnServer, name: "check" });
    if (plan.steps.length === 0) return;
    throw new OkmError(
      "OKM1520",
      `The database differs from the schema.\n${plan.steps.map((step) => step.sql).join("\n")}`,
      {
        fix: {
          summary: "Change the schema or the database so okm check reports no difference.",
        },
      },
    );
  } catch (error) {
    throw sessionFailure(error) ?? error;
  } finally {
    await finishQuiet(() => sql.end({ timeout: 5 }));
  }
}

/**
 * Reprints each domain check the way this server stores it.
 *
 * Author spellings such as `VALUE > 0` become `((VALUE > 0))`, so a plan
 * against a live catalog does not treat the reprint as a permanent change.
 * The catalog hash still uses the author text (B-37).
 *
 * @param runner - Database connection
 * @param source - Catalog whose domain checks may still be author SQL
 * @returns A catalog whose domain checks carry the server reprint
 */
export async function sealDomainChecks(runner: CatalogQuery, source: Catalog): Promise<Catalog> {
  const objects: CatalogObject[] = [];
  let changed = false;
  for (const object of source.objects) {
    if (object.kind !== "type" || !isDomain(object.definition)) {
      objects.push(object);
      continue;
    }
    const reprinted = await reprintDomainCheck(
      runner,
      object.definition.base,
      object.definition.check,
    );
    if (reprinted === object.definition.check) {
      objects.push(object);
      continue;
    }
    changed = true;
    objects.push({
      ...object,
      definition: { ...object.definition, check: reprinted },
    });
  }
  return changed ? { version: source.version, objects } : source;
}

/**
 * Turns a postgres.js handle into the query shape introspection uses.
 *
 * @param sql - One connection
 * @returns A {@link CatalogQuery}
 */
export function catalogQuery(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}

/**
 * Role names introspection should read, when the config names them.
 *
 * @param roles - `defineConfig({ roles })`, when set
 * @returns The introspect option, or `undefined` when roles are not configured
 */
export function managedRoleOptions(roles: RolesInput | undefined): IntrospectOptions | undefined {
  const names = managedRoleNames(roles);
  return names === undefined
    ? undefined
    : {
        managedRoles: names,
        ...(roles?.reporting !== undefined ? { reportingRole: roles.reporting } : {}),
      };
}

function authorSchema(author: Catalog): string {
  for (const object of author.objects) {
    if (
      object.kind === "table" &&
      object.owner !== "external" &&
      object.identity.namespace.form === "static"
    ) {
      return object.identity.namespace.name;
    }
  }
  return "public";
}

function metaReg(schema: string): string {
  if (schema === "public") return "public.okm_meta";
  return `${quoteIdent(schema)}.okm_meta`;
}

function managedRoleNames(roles: RolesInput | undefined): readonly string[] | undefined {
  if (roles === undefined) return undefined;
  const names = new Set<string>([roles.migration, roles.app]);
  if (roles.reporting !== undefined) names.add(roles.reporting);
  for (const role of roles.managed ?? []) names.add(role.name);
  return [...names];
}
