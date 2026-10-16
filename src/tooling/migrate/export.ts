/**
 * `okm catalog export` and the check that a dependent catalog runs.
 *
 * The snapshot is derived from the schema source. It stores the catalog
 * hash and, separately, a logical identity. It has no function and no
 * connection URL. Column names and types are what a dependent verifies.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { startupHash } from "../../contracts/catalog/document.js";
import type { Catalog, CatalogObject, ColumnObject } from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import type { MigrateConfig } from "./config.js";
import type { Finding } from "./lint.js";
import { projectPath } from "./paths.js";

/** Snapshot file format. Not the logical schema format. */
export const EXPORT_FORMAT = 1;

/** Logical schema format. A hash change does not move this. */
export const LOGICAL_FORMAT = 1;

/** One column a dependent verifies. No default and no expression. */
export type ExportColumn = {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
};

/** One table in a snapshot. */
export type ExportTable = {
  readonly namespace: string;
  readonly name: string;
  readonly columns: readonly ExportColumn[];
};

/**
 * Logical schema identity.
 *
 * `namespace` and `name` name the schema. `format` is {@link LOGICAL_FORMAT}.
 * None of these is the catalog hash.
 */
export type LogicalIdentity = {
  readonly namespace: string;
  readonly name: string;
  readonly format: typeof LOGICAL_FORMAT;
};

/**
 * A catalog snapshot.
 *
 * `catalogHash` is the physical identity. `logical` is not that hash.
 * `database` is the database name only, never a URL.
 */
export type CatalogSnapshot = {
  readonly format: typeof EXPORT_FORMAT;
  readonly logical: LogicalIdentity;
  readonly catalogHash: string;
  readonly database?: string;
  readonly tables: readonly ExportTable[];
};

/**
 * Builds a snapshot from a placed catalog.
 *
 * @param source - Catalog tooling plans, after namespace placement
 * @param namespace - `defineConfig({ namespace })`, or `public`
 * @param database - Database name, when the config has a target URL
 * @returns A snapshot with no functions and no connection URL
 */
export function snapshotFromCatalog(
  source: Catalog,
  namespace: string,
  database?: string,
): CatalogSnapshot {
  return {
    format: EXPORT_FORMAT,
    logical: { namespace, name: namespace, format: LOGICAL_FORMAT },
    catalogHash: startupHash(source),
    ...(database !== undefined ? { database } : {}),
    tables: exportTables(source),
  };
}

/**
 * Serializes a snapshot.
 *
 * The same catalog returns the same bytes, including the trailing newline.
 *
 * @param snapshot - Snapshot to write
 * @returns UTF-8 JSON
 */
export function serializeSnapshot(snapshot: CatalogSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/**
 * Reads a snapshot file.
 *
 * A missing file and a file that is not this format are OKM1841.
 *
 * @param path - Absolute or project-relative path, as the message should name it
 * @param text - File contents
 * @returns The snapshot
 */
export function parseSnapshot(path: string, text: string): CatalogSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw snapshotError(path, "stale", `Catalog snapshot ${path} is not JSON.`);
  }
  if (!isSnapshot(parsed)) {
    throw snapshotError(
      path,
      "stale",
      `Catalog snapshot ${path} is stale: the file format is not ${String(EXPORT_FORMAT)}.`,
    );
  }
  return parsed;
}

/**
 * Database name from a Postgres URL.
 *
 * The user, password, host, and query are not returned.
 *
 * @param url - Target URL
 * @returns The path segment, or `undefined` when the URL has none
 */
export function databaseName(url: string): string | undefined {
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Namespace `defineConfig` asked for.
 *
 * Omitted means `public`.
 *
 * @param config - Project config
 * @returns The schema name
 */
export function catalogNamespace(config: MigrateConfig): string {
  return config.namespace ?? "public";
}

/**
 * Loads the snapshots named by `defineConfig({ external })`.
 *
 * A missing path is OKM1841.
 *
 * @param cwd - Project directory
 * @param config - Project config
 * @returns One snapshot per path, in config order
 */
export function loadSnapshots(cwd: string, config: MigrateConfig): readonly LoadedSnapshot[] {
  const paths = config.external ?? [];
  return paths.map((path) => {
    const file = resolveSnapshot(cwd, path);
    if (!existsSync(file)) {
      throw snapshotError(path, "missing", `Catalog snapshot ${path} is missing.`);
    }
    return { path, snapshot: parseSnapshot(path, readFileSync(file, "utf8")) };
  });
}

/** A snapshot and the config path that named it. */
export type LoadedSnapshot = {
  readonly path: string;
  readonly snapshot: CatalogSnapshot;
};

/**
 * SQL table name to the namespace recorded in a snapshot.
 *
 * @param snapshots - Loaded exports
 * @returns The map `placeCatalog` reads
 */
export function externalNamespaceMap(
  snapshots: readonly LoadedSnapshot[],
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const loaded of snapshots) {
    for (const table of loaded.snapshot.tables) names.set(table.name, table.namespace);
  }
  return names;
}

/**
 * Cross-catalog foreign keys, as `okm check` warnings.
 *
 * A key inside one namespace is not coupling. The warning does not fail the check.
 *
 * @param source - Placed catalog
 * @returns One warning per foreign key whose namespaces differ
 */
export function couplingFindings(source: Catalog): readonly Finding[] {
  const findings: Finding[] = [];
  for (const object of source.objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "foreignKey") continue;
    const references = object.definition.references;
    if (references === undefined) continue;
    const from = object.identity.parent.namespace;
    const to = references.parent.namespace;
    if (from.form !== "static" || to.form !== "static" || from.name === to.name) continue;
    findings.push({
      severity: "warning",
      code: "coupling",
      place: `${from.name}.${object.identity.parent.name}.${object.definition.columns.join(",")}`,
      reason: `references ${to.name}.${references.parent.name}.${references.columns.join(",")}`,
      fix: "Cross-catalog foreign keys are allowed inside one database.",
    });
  }
  return findings;
}

/**
 * Checks external tables against the snapshot files.
 *
 * This does not open a connection. A missing file, a table the snapshots
 * do not list, or columns that differ is OKM1841.
 *
 * @param cwd - Project directory
 * @param config - Project config
 * @param source - Placed catalog
 */
export function assertSnapshots(cwd: string, config: MigrateConfig, source: Catalog): void {
  const snapshots = loadSnapshots(cwd, config);
  for (const table of externalTables(source)) {
    const found = findTable(snapshots, table.namespace, table.name);
    if (found === undefined) {
      throw snapshotError(
        table.name,
        "missing",
        `External table ${table.namespace}.${table.name} is missing from the catalog snapshots.`,
      );
    }
    const differ = columnDifference(table.columns, found.table.columns);
    if (differ !== undefined) {
      throw snapshotError(
        found.path,
        "stale",
        `Catalog snapshot ${found.path} is stale: ${table.namespace}.${table.name}.${differ} does not match the export.`,
      );
    }
  }
}

/**
 * Checks external tables against the connected database.
 *
 * A different database name on a cross-catalog foreign key is OKM1842.
 * A hash or column mismatch is a stale snapshot. A missing relation is
 * a missing object. Both are OKM1841.
 *
 * @param url - Target URL
 * @param source - Placed catalog
 * @param snapshots - Files {@link assertSnapshots} already read
 */
export async function assertLiveExternal(
  url: string,
  source: Catalog,
  snapshots: readonly LoadedSnapshot[],
): Promise<void> {
  if (snapshots.length === 0 && externalTables(source).length === 0) return;
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });
  try {
    const current = await sql<{ name: string }[]>`select current_database() as name`;
    const database = current[0]?.name;
    if (database !== undefined) assertSameDatabase(source, snapshots, database);
    for (const table of externalTables(source)) {
      const found = findTable(snapshots, table.namespace, table.name);
      if (found === undefined) continue;
      await assertLiveTable(sql, found.path, found.snapshot, table);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Writes the snapshot for one project.
 *
 * `--json` prints the bytes. `--out` writes them. With neither, the bytes
 * are printed.
 *
 * @param cwd - Project directory
 * @param config - Project config
 * @param source - Placed catalog
 * @param args - Arguments after `export`
 * @returns Stdout, including a trailing newline
 */
export function renderExport(
  cwd: string,
  config: MigrateConfig,
  source: Catalog,
  args: readonly string[],
): string {
  const flags = exportFlags(args);
  const database = exportDatabase(config);
  const snapshot = snapshotFromCatalog(source, catalogNamespace(config), database);
  const text = serializeSnapshot(snapshot);
  if (flags.out !== undefined) {
    const path = isAbsolute(flags.out) ? flags.out : join(cwd, flags.out);
    writeFileSync(path, text);
  }
  if (flags.json || flags.out === undefined) return text;
  return `${flags.out}\n`;
}

function exportTables(source: Catalog): readonly ExportTable[] {
  const tables: ExportTable[] = [];
  for (const object of source.objects) {
    if (object.kind !== "table" || object.owner === "external" || object.owner === "ignored") {
      continue;
    }
    if (object.identity.namespace.form !== "static") continue;
    const columns: ExportColumn[] = [];
    for (const column of source.objects) {
      if (!isColumnOf(column, object.identity.namespace.name, object.identity.name)) continue;
      columns.push({
        name: column.identity.name,
        type: column.definition.dataType,
        nullable: column.definition.nullable,
      });
    }
    tables.push({
      namespace: object.identity.namespace.name,
      name: object.identity.name,
      columns,
    });
  }
  return tables;
}

function isColumnOf(
  object: CatalogObject,
  namespace: string,
  table: string,
): object is ColumnObject {
  return (
    object.kind === "column" &&
    object.identity.parent.name === table &&
    object.identity.parent.namespace.form === "static" &&
    object.identity.parent.namespace.name === namespace
  );
}

type LiveColumn = {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
};

type ExternalTable = ExportTable;

function externalTables(source: Catalog): readonly ExternalTable[] {
  const tables: ExternalTable[] = [];
  for (const object of source.objects) {
    if (object.kind !== "table" || object.owner !== "external") continue;
    if (object.identity.namespace.form !== "static") continue;
    const columns: ExportColumn[] = [];
    for (const column of source.objects) {
      if (!isColumnOf(column, object.identity.namespace.name, object.identity.name)) continue;
      columns.push({
        name: column.identity.name,
        type: column.definition.dataType,
        nullable: column.definition.nullable,
      });
    }
    tables.push({ namespace: object.identity.namespace.name, name: object.identity.name, columns });
  }
  return tables;
}

function findTable(
  snapshots: readonly LoadedSnapshot[],
  namespace: string,
  name: string,
):
  | { readonly path: string; readonly snapshot: CatalogSnapshot; readonly table: ExportTable }
  | undefined {
  for (const loaded of snapshots) {
    for (const table of loaded.snapshot.tables) {
      if (table.name === name && (table.namespace === namespace || namespace === "public")) {
        return { path: loaded.path, snapshot: loaded.snapshot, table };
      }
    }
  }
  for (const loaded of snapshots) {
    for (const table of loaded.snapshot.tables) {
      if (table.name === name) return { path: loaded.path, snapshot: loaded.snapshot, table };
    }
  }
  return undefined;
}

function columnDifference(
  left: readonly ExportColumn[],
  right: readonly ExportColumn[],
): string | undefined {
  const byName = new Map(right.map((column) => [column.name, column]));
  for (const column of left) {
    const other = byName.get(column.name);
    if (other === undefined) return column.name;
    if (other.type !== column.type || other.nullable !== column.nullable) return column.name;
  }
  for (const column of right) {
    if (!left.some((item) => item.name === column.name)) return column.name;
  }
  return undefined;
}

function assertSameDatabase(
  source: Catalog,
  snapshots: readonly LoadedSnapshot[],
  database: string,
): void {
  if (!hasCrossCatalogForeignKey(source)) return;
  for (const loaded of snapshots) {
    const name = loaded.snapshot.database;
    if (name !== undefined && name !== database) {
      throw new OkmError(
        "OKM1842",
        `A foreign key references ${loaded.snapshot.logical.namespace} in database ${name}. This database is ${database}.`,
        {
          kind: "invalid",
          fieldReason: "database",
          fix: {
            summary:
              "Keep the foreign key inside one database. Cross-catalog keys are allowed only there.",
          },
        },
      );
    }
  }
}

function hasCrossCatalogForeignKey(source: Catalog): boolean {
  for (const object of source.objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "foreignKey") continue;
    const references = object.definition.references;
    if (references === undefined) continue;
    const from = object.identity.parent.namespace;
    const to = references.parent.namespace;
    if (from.form === "static" && to.form === "static" && from.name !== to.name) return true;
  }
  return false;
}

async function assertLiveTable(
  sql: import("postgres").Sql,
  path: string,
  snapshot: CatalogSnapshot,
  table: ExternalTable,
): Promise<void> {
  const hash = await liveHash(sql, table.namespace);
  if (hash !== undefined && hash !== snapshot.catalogHash) {
    throw snapshotError(
      path,
      "stale",
      `Catalog snapshot ${path} is stale: the catalog hash changed.`,
    );
  }
  const live = await liveColumns(sql, table.namespace, table.name);
  if (live === undefined) {
    throw snapshotError(
      path,
      "missing",
      `External table ${table.namespace}.${table.name} is missing on the database.`,
    );
  }
  const differ = columnDifference(snapshotTableColumns(snapshot, table), live);
  if (differ !== undefined) {
    throw snapshotError(
      path,
      "stale",
      `Catalog snapshot ${path} is stale: ${table.namespace}.${table.name}.${differ} is missing on the database.`,
    );
  }
}

function snapshotTableColumns(
  snapshot: CatalogSnapshot,
  table: ExternalTable,
): readonly ExportColumn[] {
  for (const item of snapshot.tables) {
    if (item.name === table.name) return item.columns;
  }
  return table.columns;
}

async function liveHash(
  sql: import("postgres").Sql,
  namespace: string,
): Promise<string | undefined> {
  const reg = `${quoteIdent(namespace)}.${quoteIdent("okm_meta")}`;
  const present = await sql.unsafe<{ reg: string | null }[]>(
    `select to_regclass('${reg}')::text as reg`,
  );
  if (present[0]?.reg == null) return undefined;
  const rows = await sql.unsafe<{ catalog_hash: string }[]>(
    `select catalog_hash from ${reg} where id = 'head'`,
  );
  return rows[0]?.catalog_hash;
}

async function liveColumns(
  sql: import("postgres").Sql,
  namespace: string,
  table: string,
): Promise<readonly LiveColumn[] | undefined> {
  const rows = await sql<
    { name: string; type: string; not_null: boolean }[]
  >`select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${namespace} and c.relname = ${table}
      and a.attnum > 0 and not a.attisdropped
    order by a.attnum`;
  if (rows.length === 0) {
    const exists = await sql<{ reg: string | null }[]>`
      select to_regclass(${`${quoteIdent(namespace)}.${quoteIdent(table)}`})::text as reg
    `;
    if (exists[0]?.reg == null) return undefined;
  }
  return rows.map((row) => ({ name: row.name, type: row.type, nullable: !row.not_null }));
}

function resolveSnapshot(cwd: string, path: string): string {
  return isAbsolute(path) ? path : projectPath(cwd, path);
}

function exportDatabase(config: MigrateConfig): string | undefined {
  const target = config.database;
  if (typeof target === "string") return databaseName(target);
  if (target?.url !== undefined) return databaseName(target.url);
  return undefined;
}

function exportFlags(args: readonly string[]): { readonly json: boolean; readonly out?: string } {
  let json = false;
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--out") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new OkmError("invalid", "--out needs a file.", {
          fix: { summary: "Pass --out <file>." },
        });
      }
      out = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      continue;
    }
    throw new OkmError("invalid", `Unknown flag ${arg}.`, {
      fix: { summary: "okm catalog export accepts --json and --out <file>." },
    });
  }
  return out === undefined ? { json } : { json, out };
}

function snapshotError(path: string, reason: "stale" | "missing", message: string): OkmError {
  return new OkmError("OKM1841", message, {
    kind: reason === "missing" ? "not_found" : "schema_drift",
    fieldReason: reason,
    columns: [path],
    fix: {
      summary:
        reason === "missing"
          ? "Point external at the file okm catalog export wrote, and apply the owning catalog."
          : "Run okm catalog export in the owning catalog and update the dependent.",
    },
  });
}

function isSnapshot(value: unknown): value is CatalogSnapshot {
  if (!isRecord(value) || value.format !== EXPORT_FORMAT) return false;
  if (typeof value.catalogHash !== "string") return false;
  if (!isLogical(value.logical)) return false;
  if (value.database !== undefined && typeof value.database !== "string") return false;
  if (!Array.isArray(value.tables)) return false;
  return value.tables.every(isTable);
}

function isLogical(value: unknown): value is LogicalIdentity {
  if (!isRecord(value)) return false;
  return (
    typeof value.namespace === "string" &&
    typeof value.name === "string" &&
    value.format === LOGICAL_FORMAT
  );
}

function isTable(value: unknown): value is ExportTable {
  if (!isRecord(value) || typeof value.namespace !== "string" || typeof value.name !== "string") {
    return false;
  }
  if (!Array.isArray(value.columns)) return false;
  return value.columns.every(
    (column) =>
      isRecord(column) &&
      typeof column.name === "string" &&
      typeof column.type === "string" &&
      typeof column.nullable === "boolean",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
