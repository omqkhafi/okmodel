/**
 * Dialect, catalog-hash, and Postgres major checks.
 *
 * Loaded on the first connection. The strings stay out of the startup graph.
 */

import type { DriverPool, ExecuteOptions } from "../contracts/driver.js";
import { OkmError, type ErrorStatuses } from "../contracts/error.js";
import {
  isPostgresMajor,
  parsePostgresFloor,
  POSTGRES_FLOOR,
  serverNeedsPostgres,
} from "../dialects/pg/floor.js";
import type { QuerySchema } from "../dialects/pg/model.js";
import { artifactDir, readText } from "./artifact-file.js";
import { attachHttp, mapOptions, withHttp } from "./client.js";
import type { CatalogArtifact } from "./types.js";

/**
 * Version, dialect, and the `okm_meta` hash in one round trip.
 *
 * The hash subquery is a string so a database with no `okm_meta` still plans.
 * A null hash skips the compatibility check.
 */
export const versionQuery =
  "select current_setting('server_version_num'), version(), (select (xpath('//catalog_hash/text()', query_to_xml('select catalog_hash from okm_meta where id = ''head''', true, false, '')))[1]::text where to_regclass('okm_meta') is not null)";

const historyQuery =
  "select migration_id, class, catalog_hash from okm_history order by migration_id, step_index";

/**
 * Startup query for the namespace `okm build` recorded.
 *
 * `public` returns {@link versionQuery}, the same string as before.
 * Another namespace qualifies `okm_meta`. `to_regclass` still lets a
 * database with no such table plan.
 *
 * @param namespace - Catalog schema. `public` is unqualified
 * @returns The version, dialect, and hash query
 */
export async function versionSql(namespace: string): Promise<string> {
  if (namespace === "public") return versionQuery;
  const relation = await qualified("okm_meta", namespace);
  const literal = relation.replaceAll("'", "''");
  return `select current_setting('server_version_num'), version(), (select (xpath('//catalog_hash/text()', query_to_xml('select catalog_hash from ${literal} where id = ''head''', true, false, '')))[1]::text where to_regclass('${literal}') is not null)`;
}

/**
 * History query used when the catalog hashes differ.
 *
 * `public` stays unqualified, so a search path still finds that table.
 *
 * @param namespace - Catalog schema. `public` is unqualified
 * @returns The `okm_history` select
 */
export async function historySql(namespace: string): Promise<string> {
  if (namespace === "public") return historyQuery;
  return `select migration_id, class, catalog_hash from ${await qualified("okm_history", namespace)} order by migration_id, step_index`;
}

/**
 * Namespace stored beside the catalog hash.
 *
 * A missing file means `public`. `okm build` writes the file only when
 * `defineConfig({ namespace })` is not `public`.
 *
 * @param catalogDir - Directory `connect` was given, or the default `.okm`
 * @returns The schema name
 */
export async function recordedNamespace(catalogDir: string | undefined): Promise<string> {
  const text = await readText(`${artifactDir(catalogDir)}/namespace`);
  if (text === undefined) return "public";
  const line = text.trim();
  if (line === "" || line === "public") return "public";
  if (line.includes("\0") || line.includes("\n") || line.includes("\r")) {
    throw new OkmError("OKM1122", "The catalog namespace file is not one identifier.", {
      fix: { summary: "Run okm build so .okm/namespace is the schema from defineConfig." },
    });
  }
  return line;
}

/**
 * Accepts the server row, or throws OKM1801, OKM1520, OKM1802, or OKM1803.
 *
 * The first statement reads `okm_meta` in the catalog namespace. A declared
 * floor is the minimum. With no floor, the minimum is 15. A major below 15
 * is refused when the schema is built.
 *
 * @param pool - Connection that runs the version query
 * @param schema - Schema whose floor is the declared minimum
 * @param http - Status overrides from `connect`
 * @param requireMeta - When true, a missing hash is OKM1520
 * @param options - Signal and timeout for the compatibility read
 * @param source - Trusted catalog used when the hash does not match
 */
export async function acceptServer(
  pool: DriverPool,
  schema: QuerySchema,
  http: ErrorStatuses | undefined,
  requireMeta: boolean,
  options: ExecuteOptions | undefined,
  source: {
    readonly catalog?: CatalogArtifact | undefined;
    readonly catalogDir?: string | undefined;
  },
  onWrite?: object,
): Promise<void> {
  if (onWrite !== undefined) {
    const { assertObserveKeys, observeKeyList } = await import("./observe-keys.js");
    const observeKeys = observeKeyList(onWrite);
    if (observeKeys !== undefined) assertObserveKeys(schema, observeKeys);
  }
  const namespace = await recordedNamespace(source.catalogDir);
  let rows: readonly (readonly (string | null)[])[];
  try {
    const result = await pool.execute(await versionSql(namespace), undefined, options);
    rows = result.rows;
  } catch (error) {
    const { mapPostgresError } = await import("../dialects/pg/errors.js");
    throw mapPostgresError(error, mapOptions(http, false, schema));
  }
  // A preset named like a client method would hide that method. Fail before the first query.
  for (const name in schema.model) {
    if (schema.model[name]?.presets !== undefined) {
      (await import("./presets.js")).checkSchema(schema);
      break;
    }
  }
  const version = rows[0]?.[1];
  if (version === null || version === undefined || !version.startsWith("PostgreSQL")) {
    throw new OkmError(
      "OKM1801",
      "The server is not PostgreSQL. The schema dialect is postgres.",
      withHttp(http, {
        fix: { summary: "Open the schema with the Postgres driver that matches it." },
      }),
    );
  }
  const recorded = rows[0]?.[2];
  if (recorded === null || recorded === undefined || recorded.length === 0) {
    if (requireMeta) {
      throw new OkmError(
        "OKM1520",
        "okm_meta has no catalog hash.",
        withHttp(http, {
          fix: {
            summary:
              "Apply migrations so okm_meta records the catalog, or omit requireMeta to adopt this database.",
          },
        }),
      );
    }
  } else {
    const { assertCompatible } = await import("./drift.js");
    try {
      await assertCompatible(pool, schema, recorded, source, options, namespace);
    } catch (error) {
      if (error instanceof OkmError) throw attachHttp(http, error);
      throw error;
    }
  }
  const major = Math.floor(Number(rows[0]?.[0] ?? "0") / 10_000);
  const raw = schema.requires?.postgres;
  if (raw === undefined) {
    if (major < POSTGRES_FLOOR) {
      throw new OkmError(
        "OKM1803",
        serverNeedsPostgres(major, POSTGRES_FLOOR),
        withHttp(http, {
          fix: {
            summary: `Upgrade to PostgreSQL ${String(POSTGRES_FLOOR)} or higher.`,
          },
        }),
      );
    }
    return;
  }
  const need = parsePostgresFloor(raw);
  if (!isPostgresMajor(need) || major < need) {
    throw new OkmError(
      "OKM1802",
      serverNeedsPostgres(major, isPostgresMajor(need) ? need : POSTGRES_FLOOR),
      withHttp(http, {
        fix: { summary: "Upgrade the server, or lower minPostgres to a major the server meets." },
      }),
    );
  }
}

async function qualified(table: "okm_meta" | "okm_history", namespace: string): Promise<string> {
  const { quoteIdent } = await import("../dialects/pg/ddl.js");
  return `${quoteIdent(namespace)}.${table}`;
}
