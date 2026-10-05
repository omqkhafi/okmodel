/**
 * Dialect, catalog-hash, and Postgres major checks.
 *
 * Loaded on the first connection. The strings stay out of the startup graph.
 */

import type { DriverPool, ExecuteOptions } from "../contracts/driver.js";
import { OkmError, type ErrorStatuses } from "../contracts/error.js";
import type { QuerySchema } from "../dialects/pg/model.js";
import { attachHttp, withHttp } from "./client.js";
import type { CatalogArtifact } from "./types.js";

/**
 * Version, dialect, and the `okm_meta` hash in one round trip.
 *
 * The hash subquery is a string so a database with no `okm_meta` still plans.
 * A null hash skips the compatibility check.
 */
export const versionQuery =
  "select current_setting('server_version_num'), version(), (select (xpath('//catalog_hash/text()', query_to_xml('select catalog_hash from okm_meta where id = ''head''', true, false, '')))[1]::text where to_regclass('okm_meta') is not null)";

/**
 * Accepts the `server_version_num` row, or throws OKM1801, OKM1520, OKM1802, or OKM1803.
 *
 * A declared `requires` is the minimum, including a major below 15 when the
 * schema names it on purpose. With no `requires`, the floor is 15.
 *
 * @param pool - Connection that ran the version query
 * @param schema - Schema whose `requires` is the declared minimum
 * @param rows - `server_version_num`, `version()`, and the `okm_meta` hash
 * @param http - Status overrides from `connect`
 * @param requireMeta - When true, a missing hash is OKM1520
 * @param options - Signal and timeout for the compatibility read
 * @param source - Trusted catalog used when the hash does not match
 */
export async function acceptServer(
  pool: DriverPool,
  schema: QuerySchema,
  rows: readonly (readonly (string | null)[])[],
  http: ErrorStatuses | undefined,
  requireMeta: boolean,
  options: ExecuteOptions | undefined,
  source: { readonly catalog?: CatalogArtifact; readonly catalogDir?: string },
): Promise<void> {
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
      await assertCompatible(pool, schema, recorded, source, options);
    } catch (error) {
      if (error instanceof OkmError) throw attachHttp(http, error);
      throw error;
    }
  }
  const major = Math.floor(Number(rows[0]?.[0] ?? "0") / 10_000);
  const requires = schema.requires?.postgres;
  if (requires === undefined) {
    if (major < 15) {
      throw new OkmError(
        "OKM1803",
        `The server is PostgreSQL ${String(major)}. PostgreSQL 15 is the oldest supported.`,
        withHttp(http, {
          fix: { summary: "Upgrade to PostgreSQL 15, or set schema({ requires }) to this major." },
        }),
      );
    }
    return;
  }
  const match = /^>=(\d+)$/.exec(requires.trim());
  const need = match?.[1] === undefined ? undefined : Number(match[1]);
  if (need === undefined || major < need) {
    throw new OkmError(
      "OKM1802",
      `The server is PostgreSQL ${String(major)}. schema({ requires }) asks for ${requires}.`,
      withHttp(http, {
        fix: { summary: "Upgrade the server, or lower requires to a version the server meets." },
      }),
    );
  }
}
