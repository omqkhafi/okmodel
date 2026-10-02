/**
 * Extension inventory on Postgres 15–18, and extension-owned objects.
 *
 * Objects with `pg_depend.deptype = 'e'` must not come back as user functions.
 * A target version that is not the installed one is planned as `ALTER EXTENSION
 * UPDATE` and then rejected by the server when no path exists.
 */

import { expect } from "bun:test";

import { isolatedSchemaName, openPostgres } from "@okmodel/harness";
import type { Sql } from "postgres";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { introspectObjects } from "../catalog/introspect.js";
import { quoteIdent } from "../catalog/sql.js";
import { planMigration, planSql } from "../migrations/plan.js";
import { type ExtensionObject } from "../catalog/object.js";
import { postgresRunner } from "../catalog/runners.js";
import { withPostgresImages } from "./containers.js";
import {
  extensionMembers,
  extensionUpdatePaths,
  introspectExtensions,
  timeExtensionIntrospection,
} from "./introspect.js";
import { errorMessage, sqlState, withThrowawayDatabase } from "./session.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

postgresTest(
  decision,
  "postgres 15 through 18 list extensions, versions, schema, and relocatability",
  async () => {
    const results = await withPostgresImages(async (version, url) => {
      const sql = openPostgres(url);
      try {
        const runner = postgresRunner(sql);
        const timed = await timeExtensionIntrospection(runner);
        const offers = await introspectExtensions(runner);
        const citext = offers.find((offer) => offer.name === "citext");
        const plpgsql = offers.find((offer) => offer.name === "plpgsql");
        const multi = offers.filter((offer) => offer.versions.length > 1);
        return {
          version,
          ms: timed.ms,
          extensions: timed.extensions,
          citext:
            citext === undefined
              ? null
              : {
                  defaultVersion: citext.defaultVersion,
                  installedVersion: citext.installedVersion,
                  versions: citext.versions,
                  relocatable: citext.relocatable,
                  schema: citext.schema,
                },
          plpgsqlRelocatable: plpgsql?.relocatable ?? null,
          multipleVersions: multi.map((offer) => ({
            name: offer.name,
            versions: offer.versions,
          })),
        };
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
    console.log(JSON.stringify({ event: "infra-extension-images", results }));
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.extensions).toBeGreaterThan(0);
      expect(result.citext).not.toBeNull();
    }
  },
  600_000,
);

postgresTest(decision, "extension members stay out of the user-object diff", async () => {
  await withThrowawayDatabase(async (sql) => {
    const schema = isolatedSchemaName();
    const runner = postgresRunner(sql);
    await runner.exec(`create schema ${quoteIdent(schema)}`);
    await runner.exec(`create extension citext schema ${quoteIdent(schema)}`);
    const members = await extensionMembers(runner, schema, "citext");
    const introspected = await introspectObjects(runner, [schema], ["citext"]);
    const leaked = introspected.filter(
      (object) => object.kind === "function" && members.functionNames.includes(object.name),
    );
    const userTable = introspected.filter((object) => object.kind === "table");
    console.log(
      JSON.stringify({
        event: "infra-extension-members",
        functions: members.functions,
        types: members.types,
        operators: members.operators,
        leakedFunctions: leaked.length,
        introspectedTables: userTable.length,
      }),
    );
    expect(members.functions).toBeGreaterThan(0);
    expect(members.types).toBeGreaterThan(0);
    expect(members.operators).toBeGreaterThan(0);
    expect(leaked).toEqual([]);
    const installed = await runner.query(`
      select e.extversion as version, n.nspname as schema, e.extrelocatable as relocatable
      from pg_extension e
      join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'citext'
    `);
    expect(text(installed[0] ?? {}, "schema")).toBe(schema);
    expect(text(installed[0] ?? {}, "relocatable")).toBe("true");
  });
});

postgresTest(
  decision,
  "a different extension version is refused when no update path exists",
  async () => {
    await withThrowawayDatabase(async (sql) => {
      const runner = postgresRunner(sql);
      const offers = await introspectExtensions(runner);
      const withPath: { name: string; source: string; target: string; path: string }[] = [];
      for (const offer of offers) {
        if (offer.versions.length < 2) continue;
        const paths = await extensionUpdatePaths(runner, offer.name);
        const usable = paths.find((path) => path.path !== "" && path.source !== path.target);
        if (usable !== undefined) {
          withPath.push({ name: offer.name, ...usable });
          break;
        }
      }
      await runner.exec(`create extension citext version '1.4'`);
      const upgrade = planSql(
        planMigration([citextExtension("1.4")], [citextExtension("1.6")], []),
      );
      expect(upgrade).toEqual([`alter extension "citext" update to '1.6'`]);
      const upgraded = await statementError(sql, upgrade[0] ?? "");
      const installed = await runner.query(
        `select extversion as version from pg_extension where extname = 'citext'`,
      );
      const version = text(installed[0] ?? {}, "version");
      const paths = await extensionUpdatePaths(runner, "citext");
      const refused = await statementError(sql, `alter extension citext update to '999'`);
      const moved = await moveCitext(sql);
      const plpgsql = await statementError(sql, `alter extension plpgsql set schema public`);
      console.log(
        JSON.stringify({
          event: "infra-extension-version",
          installed: version,
          upgrade,
          upgraded,
          citextPaths: paths,
          extensionsWithUpdatePath: withPath,
          updateRefused: refused,
          schemaMove: moved,
          plpgsqlSchemaMove: plpgsql,
        }),
      );
      expect(upgraded.code).toBe("");
      expect(version).toBe("1.6");
      expect(refused.code).not.toBe("");
      expect(moved.schema).toBe("ext_dest");
      expect(plpgsql.code).not.toBe("");
    });
  },
);

async function moveCitext(
  sql: Sql,
): Promise<{ readonly code: string; readonly message: string; readonly schema: string }> {
  const error = await statementError(sql, `create schema ext_dest`);
  if (error.code !== "") return { ...error, schema: "" };
  const moved = await statementError(sql, `alter extension citext set schema ext_dest`);
  if (moved.code !== "") return { ...moved, schema: "" };
  const runner = postgresRunner(sql);
  const rows = await runner.query(`
    select n.nspname as schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'citext'
  `);
  return { code: "", message: "", schema: text(rows[0] ?? {}, "schema") };
}

async function statementError(
  sql: Sql,
  statement: string,
): Promise<{ readonly code: string; readonly message: string }> {
  try {
    await sql.unsafe(statement);
    return { code: "", message: "" };
  } catch (error) {
    return { code: sqlState(error), message: errorMessage(error) };
  }
}

function citextExtension(version: string): ExtensionObject {
  return {
    kind: "extension",
    identity: { kind: "extension", name: "citext" },
    owner: "managed",
    definition: { name: "citext", version },
    dependencies: [],
    provenance: { source: "infra" },
  };
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}
