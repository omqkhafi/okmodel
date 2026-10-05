/**
 * Live drift for `okm check`.
 *
 * A database that has never been pushed has no `okm_meta` and is left alone.
 * After push, the introspected catalog is planned back to the schema. Each
 * view is reprinted on this server first, so a `pg_get_viewdef` spelling is
 * not drift. Any remaining statement is OKM1520. `okm_meta` and `okm_history`
 * are omitted by the planner.
 */

import postgres, { type Sql } from "postgres";

import { OkmError } from "../../contracts/error.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { introspectSchema, type CatalogQuery } from "../../dialects/pg/introspect.js";
import { sealViews } from "../../dialects/pg/view/scratch.js";
import type { RolesInput } from "../../dialects/pg/role/index.js";
import { planMigration } from "./plan.js";

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
): Promise<void> {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    const present = await sql<{ reg: string | null }[]>`
      select to_regclass('public.okm_meta')::text as reg
    `;
    if (present[0]?.reg == null) return;
    const runner = queryOf(sql);
    const managed = managedRoleNames(roles);
    const authorOnServer = await sealViews(runner, author);
    const live = await introspectSchema(
      runner,
      "public",
      "public",
      managed === undefined ? undefined : { managedRoles: managed },
    );
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
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function managedRoleNames(roles: RolesInput | undefined): readonly string[] | undefined {
  if (roles === undefined) return undefined;
  const names = new Set<string>([roles.migration, roles.app]);
  for (const role of roles.managed ?? []) names.add(role.name);
  return [...names];
}

function queryOf(sql: Sql): CatalogQuery {
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
