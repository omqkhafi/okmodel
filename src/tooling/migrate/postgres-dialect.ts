/**
 * Postgres dialect object the planner calls.
 *
 * SQL lowering lives in `src/dialects/pg/lower.ts`. Feature questions
 * read the Postgres registry through this object, so the planner does
 * not import the registry.
 */

import type { DdlDialect, DdlSupport } from "../../dialects/ddl.js";
import { lowerPostgres } from "../../dialects/pg/lower.js";
import { assertSupported } from "../capabilities/check.js";
import { POSTGRES_FEATURES, type PostgresFeature } from "../capabilities/postgres.js";
import { featuresUsed } from "../capabilities/used.js";

/**
 * Support for one registry key.
 *
 * @param feature - Dotted name
 * @returns The Postgres support, or `undefined` when the table has no such key
 */
function postgresSupport(feature: string): DdlSupport | undefined {
  if (!isPostgresFeature(feature)) return undefined;
  return POSTGRES_FEATURES[feature].support;
}

function isPostgresFeature(feature: string): feature is PostgresFeature {
  return Object.hasOwn(POSTGRES_FEATURES, feature);
}

/**
 * Postgres lowering and its feature registry.
 *
 * `refuseUnsupported` throws OKM1860 when the registry marks a key refused.
 * The Postgres table has no refused entries.
 */
export const postgresDialect: DdlDialect = {
  name: "postgres",
  support: postgresSupport,
  featuresUsed,
  refuseUnsupported(features) {
    return assertSupported(features, POSTGRES_FEATURES, "postgres");
  },
  lower: lowerPostgres,
};
