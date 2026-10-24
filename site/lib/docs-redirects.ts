/**
 * Permanent handbook redirects. One map for Next.js and for markdown twins.
 * Destinations may carry a `#anchor`. Unknown retired paths are omitted so
 * they 404 instead of pointing at the handbook index.
 */

/** Source path (no trailing slash) → destination path, optional `#anchor`. */
export const DOCS_REDIRECTS: Readonly<Record<string, string>> = {
  "/docs/start/install": "/docs/start",
  "/docs/start/query": "/docs/start",
  "/docs/start/from-drizzle": "/docs/migrate/from-drizzle",
  "/docs/start/from-existing": "/docs/migrate/from-existing",
  "/docs/start/queries": "/docs/define/table/queries",
  "/docs/define": "/docs/define/table",
  "/docs/ai/mcp": "/docs/ai/skills",
  "/docs/config": "/docs/define/config",
  "/docs/config/file": "/docs/define/config",
  "/docs/config/targets": "/docs/define/config/database",
  "/docs/config/paths": "/docs/define/config#schema",
  "/docs/config/pooler": "/docs/define/config#pooler",
  "/docs/config/timeouts": "/docs/define/config#timeouts",
  "/docs/config/lint": "/docs/define/config#lint-from",
  "/docs/config/backfill": "/docs/define/config#backfill",
  "/docs/config/roles": "/docs/define/config/roles",
  "/docs/define/config/schema": "/docs/define/config#schema",
  "/docs/define/config/tables": "/docs/define/config#tables",
  "/docs/define/config/migrations": "/docs/define/config#migrations",
  "/docs/define/config/out": "/docs/define/config#out",
  "/docs/define/config/timeouts": "/docs/define/config#timeouts",
  "/docs/define/config/pooler": "/docs/define/config#pooler",
  "/docs/define/config/lint-from": "/docs/define/config#lint-from",
  "/docs/define/config/backfill": "/docs/define/config#backfill",
  "/docs/define/config/namespace": "/docs/define/config#namespace",
  "/docs/define/config/external": "/docs/define/config#external",
  "/docs/schema": "/docs/define/schema",
  "/docs/schema/tables": "/docs/define/schema/tables",
  "/docs/schema/casing": "/docs/define/schema/casing",
  "/docs/schema/codecs": "/docs/define/schema/codecs",
  "/docs/schema/types": "/docs/define/schema/types",
  "/docs/schema/defaults": "/docs/define/schema/defaults",
  "/docs/schema/requires": "/docs/define/schema/min-postgres",
  "/docs/define/schema/requires": "/docs/define/schema/min-postgres",
  "/docs/schema/traits": "/docs/define/schema/traits",
  "/docs/schema/tenancy": "/docs/define/schema/tenancy",
  "/docs/schema/validation": "/docs/define/schema/validation",
  "/docs/schema/extensions": "/docs/define/schema/extensions",
  "/docs/schema/functions": "/docs/define/schema/functions",
  "/docs/schema/triggers": "/docs/define/schema/triggers",
  "/docs/schema/views": "/docs/define/schema/views",
  "/docs/table": "/docs/define/table",
  "/docs/table/columns": "/docs/define/table/columns",
  "/docs/table/keys": "/docs/define/table/keys",
  "/docs/table/indexes": "/docs/define/table/indexes",
  "/docs/table/checks": "/docs/define/table/checks",
  "/docs/table/defaults": "/docs/define/table/defaults",
  "/docs/table/references": "/docs/define/table/references",
  "/docs/table/relations": "/docs/define/table/relations",
  "/docs/table/visibility": "/docs/define/table/visibility",
  "/docs/table/names": "/docs/define/table/names",
  "/docs/table/traits": "/docs/define/table/traits",
  "/docs/table/tenancy": "/docs/define/table/tenancy",
  "/docs/table/presets": "/docs/define/table/presets",
  "/docs/table/reference": "/docs/define/table/reference-rows",
  "/docs/table/filters": "/docs/define/table/filters",
  "/docs/table/validation": "/docs/define/table/validation",
  "/docs/table/shape": "/docs/define/table/shape",
  "/docs/model/schema": "/docs/define/table",
  "/docs/model/queries": "/docs/define/table/queries",
  "/docs/model/safety": "/docs/define/table/visibility",
  "/docs/ship/migrations": "/docs/define/config#migrations",
  "/docs/ship/drivers": "/docs/define/connect/drivers",
  "/docs/define/connect/close": "/docs/define/connect#close",
  "/docs/define/connect/pool": "/docs/define/connect/session#max",
  "/docs/define/connect/prepared": "/docs/define/connect/session#prepared",
  "/docs/define/connect/tls": "/docs/define/connect/session#tls",
  "/docs/define/connect/search-path": "/docs/define/connect/session#search-path",
  "/docs/define/connect/timeouts": "/docs/define/connect/session#timeouts",
  "/docs/define/connect/require-meta": "/docs/define/connect/check#require-meta",
  "/docs/define/connect/catalog": "/docs/define/connect/check#catalog",
};

/**
 * Pathname part of a redirect destination (drops `#anchor`).
 *
 * @param destination - Map value
 */
export function redirectPathname(destination: string): string {
  const hash = destination.indexOf("#");
  return hash < 0 ? destination : destination.slice(0, hash);
}

/**
 * Next.js `redirects()` entries from {@link DOCS_REDIRECTS}.
 */
export function docsRedirectEntries(): readonly {
  readonly source: string;
  readonly destination: string;
  readonly permanent: true;
}[] {
  return Object.entries(DOCS_REDIRECTS).map(([source, destination]) => ({
    source,
    destination,
    permanent: true as const,
  }));
}
