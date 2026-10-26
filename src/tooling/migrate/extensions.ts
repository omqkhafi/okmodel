/**
 * Extension alters and the apply preflight.
 *
 * Create and drop SQL come from the dialect. An upgrade is `ALTER EXTENSION
 * … UPDATE`, marked `path-unverified` until apply checks
 * `pg_extension_update_paths`. A move is `SET SCHEMA` and only when the
 * declaration is relocatable.
 */

import { OkmError } from "../../contracts/error.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import {
  compareExtensionVersions,
  isExactVersion,
  sameExtensionDefinition,
} from "../../contracts/catalog/extension.js";
import { identityKey } from "../../contracts/catalog/identity.js";
import type { Catalog, CatalogObject, ExtensionObject } from "../../contracts/catalog/types.js";
import type { DriverConnection } from "../../contracts/driver.js";
import type { DdlDialect, DdlStep } from "../../dialects/ddl.js";

/** Migrations the preflight reads. Only the statement text is used. */
type MigrationSql = {
  readonly steps: readonly { readonly sql: string }[];
};

const CREATE_EXTENSION =
  /^\s*create\s+extension\s+(?:if\s+not\s+exists\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*))/i;

/**
 * Extension name a statement creates, when it is `CREATE EXTENSION`.
 *
 * `IF NOT EXISTS` is not the name. An unquoted name is folded, the same way
 * Postgres folds it. A quoted name keeps its case.
 *
 * @param sql - One plan step
 * @returns The extension name, or `undefined`
 */
export function createExtensionName(sql: string): string | undefined {
  const statement = extensionStatement(sql);
  return statement?.kind === "create" ? statement.name : undefined;
}

/**
 * Schema a `CREATE EXTENSION` installs into, when it is not the catalog namespace.
 *
 * The check and apply create that schema first. `public` and the scratch
 * schema already exist, so those names return nothing.
 *
 * @param sql - One statement
 * @param namespace - Catalog schema, or the scratch schema during check
 * @returns `create schema if not exists`, or `undefined`
 */
export function ensureExtensionSchemaSql(sql: string, namespace: string): string | undefined {
  const statement = extensionStatement(sql);
  if (statement?.kind !== "create" || statement.schema === undefined) return undefined;
  if (statement.schema === namespace) return undefined;
  return `create schema if not exists ${quoteIdent(statement.schema)}`;
}

/**
 * `search_path` that includes every extension schema outside `namespace`.
 *
 * A type such as `citext` installed in `extensions` is then visible to a
 * later statement in the session. Absent when every extension is already in
 * `namespace`.
 *
 * @param catalog - Schema being pushed or checked
 * @param namespace - Catalog schema
 * @returns A `search_path` list, or `undefined` when nothing is added
 */
export function extensionSchemaPath(catalog: Catalog, namespace: string): string | undefined {
  const extra: string[] = [];
  for (const object of catalog.objects) {
    if (object.kind !== "extension") continue;
    const home = object.definition.schema;
    if (home === namespace || extra.includes(home)) continue;
    extra.push(home);
  }
  if (extra.length === 0) return undefined;
  return [namespace, ...extra].map((name) => quoteIdent(name)).join(", ");
}

/**
 * Session `search_path` update after `CREATE EXTENSION … SCHEMA`.
 *
 * The type lives in that schema. A later statement in this session, including
 * one in a new transaction, still has to resolve it. The catalog namespace is
 * already on the path.
 *
 * @param sql - One plan step
 * @param namespace - Catalog schema, or the scratch schema during check
 * @returns `set_config` for the session, or `undefined`
 */
export function extensionSearchPathSql(sql: string, namespace: string): string | undefined {
  const statement = extensionStatement(sql);
  if (statement?.kind !== "create" || statement.schema === undefined) return undefined;
  if (statement.schema === namespace) return undefined;
  const literal = `'${quoteIdent(statement.schema).replaceAll("'", "''")}'`;
  return `select set_config('search_path', current_setting('search_path') || ', ' || ${literal}, false)`;
}

/**
 * Appends an extension schema to the session search path once.
 *
 * @param connection - Reserved connection
 * @param sql - The step that just ran
 * @param namespace - Catalog schema for this target
 * @param seen - Statements already appended on this connection
 */
export async function rememberExtensionSchema(
  connection: DriverConnection,
  sql: string,
  namespace: string,
  seen: Set<string>,
): Promise<void> {
  const text = extensionSearchPathSql(sql, namespace);
  if (text === undefined || seen.has(text)) return;
  seen.add(text);
  await connection.execute(text);
}

/** One statement that creates, drops, or alters an extension. */
export type ExtensionStatement =
  | { readonly kind: "create"; readonly name: string; readonly schema?: string }
  | {
      readonly kind: "drop";
      readonly names: readonly string[];
      readonly ifExists: boolean;
      readonly cascade: boolean;
    }
  | { readonly kind: "set-schema"; readonly name: string; readonly schema: string }
  | { readonly kind: "update"; readonly name: string; readonly version: string }
  | { readonly kind: "other"; readonly name: string };

const NAME = String.raw`(?:"((?:[^"]|"")+)"|([A-Za-z_][\w$]*))`;
const DROP_EXTENSION = new RegExp(
  String.raw`^drop\s+extension\s+(if\s+exists\s+)?(${NAME}(?:\s*,\s*${NAME})*)(?:\s+(cascade|restrict))?\s*$`,
  "i",
);
const NAME_ALL = new RegExp(NAME, "g");
const SCHEMA_CLAUSE = new RegExp(String.raw`\sschema\s+${NAME}`, "i");
const ALTER_EXTENSION = new RegExp(String.raw`^\s*alter\s+extension\s+${NAME}\s+(.*)$`, "is");
const SET_SCHEMA = new RegExp(String.raw`^set\s+schema\s+${NAME}\s*$`, "i");

function unquoted(quoted: string | undefined, bare: string | undefined): string {
  return quoted !== undefined ? quoted.replaceAll('""', '"') : (bare ?? "").toLowerCase();
}

/**
 * Reads one statement that creates, drops, or alters an extension.
 *
 * Only the forms the planner writes carry detail. Another `ALTER EXTENSION`
 * is `other`. Comments are already removed from `sql`.
 *
 * @param sql - One statement
 * @returns The statement, or `undefined` when it is not about an extension
 */
export function extensionStatement(sql: string): ExtensionStatement | undefined {
  const created = CREATE_EXTENSION.exec(sql);
  if (created !== null) {
    const clause = SCHEMA_CLAUSE.exec(sql);
    return {
      kind: "create",
      name: unquoted(created[1], created[2]),
      ...(clause === null ? {} : { schema: unquoted(clause[1], clause[2]) }),
    };
  }
  const dropped = DROP_EXTENSION.exec(sql.trim());
  if (dropped !== null) {
    const names = Array.from(dropped[2]?.matchAll(NAME_ALL) ?? [], (found) =>
      unquoted(found[1], found[2]),
    );
    return {
      kind: "drop",
      names,
      ifExists: dropped[1] !== undefined,
      cascade: dropped.at(-1)?.toLowerCase() === "cascade",
    };
  }
  const altered = ALTER_EXTENSION.exec(sql);
  if (altered === null) return undefined;
  const name = unquoted(altered[1], altered[2]);
  const rest = (altered[3] ?? "").trim();
  const moved = SET_SCHEMA.exec(rest);
  if (moved !== null) return { kind: "set-schema", name, schema: unquoted(moved[1], moved[2]) };
  const updated = /^update\s+to\s+'([^']*)'\s*$/i.exec(rest);
  if (updated !== null) return { kind: "update", name, version: updated[1] ?? "" };
  return { kind: "other", name };
}

/**
 * Upgrade and move steps for extensions whose definition changed.
 *
 * Exact downgrades and moves of a non-relocatable extension are OKM1814.
 * Dropping an extension that an object in the next catalog still uses is
 * OKM1814. `DROP` is never `CASCADE`.
 *
 * @param beforeBy - Previous objects, keyed by identity
 * @param afterBy - Next objects, keyed by identity
 * @param dropKeys - Identities the plan drops
 * @param dialect - Lowers a move or an upgrade the planner has accepted
 * @returns Alter steps. Creates and drops stay in the main planner
 */
export function extensionAlterSteps(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  dropKeys: ReadonlySet<string>,
  dialect: DdlDialect,
): readonly DdlStep[] {
  refuseDrops(beforeBy, afterBy, dropKeys);
  const steps: DdlStep[] = [];
  for (const after of afterBy.values()) {
    if (after.kind !== "extension") continue;
    const before = beforeBy.get(identityKey(after.identity));
    if (before === undefined || before.kind !== "extension") continue;
    if (sameExtensionDefinition(before, after)) continue;
    steps.push(...alterExtension(before, after, dialect));
  }
  return steps;
}

/**
 * Refuses a migration that names an extension the server cannot install,
 * or an upgrade with no path.
 *
 * The server is asked only when a step creates or upgrades an extension.
 * The check runs before any statement.
 *
 * @param connection - The reserved apply connection
 * @param migrations - Migrations in apply order
 * @throws OkmError OKM1811 when the extension is not available, OKM1814 when the update path is missing
 */
export async function assertExtensionsAvailable(
  connection: DriverConnection,
  migrations: readonly MigrationSql[],
): Promise<void> {
  const creates = new Set<string>();
  const updates: { readonly name: string; readonly version: string }[] = [];
  for (const migration of migrations) {
    for (const step of migration.steps) {
      const statement = extensionStatement(step.sql);
      if (statement?.kind === "create") creates.add(statement.name);
      if (statement?.kind === "update") {
        updates.push({ name: statement.name, version: statement.version });
      }
    }
  }
  if (creates.size === 0 && updates.length === 0) return;
  const names = [...creates, ...updates.map((item) => item.name)];
  const available = await availableExtensions(connection, names);
  for (const name of creates) {
    if (!available.has(name)) {
      throw new OkmError(
        "OKM1811",
        `Extension ${name} is not available on the server. Nothing was changed.`,
        { fix: { summary: "Install the extension, or remove the declaration." } },
      );
    }
  }
  await assertRoleCanCreateExtensions(connection, [...creates]);
  for (const update of updates) {
    if (!available.has(update.name)) {
      throw new OkmError(
        "OKM1811",
        `Extension ${update.name} is not available on the server. Nothing was changed.`,
        { fix: { summary: "Install the extension, or remove the declaration." } },
      );
    }
    const installed = await installedVersion(connection, update.name);
    if (installed === undefined) {
      throw new OkmError(
        "OKM1811",
        `Extension ${update.name} is not installed, so it cannot be updated. Nothing was changed.`,
        { fix: { summary: "Create the extension before updating it." } },
      );
    }
    const path = await updatePath(connection, update.name, installed, update.version);
    if (!path) {
      throw new OkmError(
        "OKM1814",
        `Extension ${update.name} has no update path from ${installed} to ${update.version}. Nothing was changed.`,
        {
          fix: {
            summary:
              "Drop or move the dependents first. Postgres cannot lower an extension version.",
          },
        },
      );
    }
  }
}

function refuseDrops(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  dropKeys: ReadonlySet<string>,
): void {
  for (const key of dropKeys) {
    const object = beforeBy.get(key);
    if (object?.kind !== "extension") continue;
    for (const after of afterBy.values()) {
      const used = after.dependencies.some(
        (edge) => edge.target.kind === "extension" && edge.target.name === object.identity.name,
      );
      if (!used) continue;
      throw new OkmError(
        "OKM1814",
        `Extension ${object.identity.name} still has dependents. Nothing was dropped.`,
        {
          fix: {
            summary:
              "Drop or move the dependents first. Postgres cannot lower an extension version.",
          },
        },
      );
    }
  }
}

function alterExtension(
  before: ExtensionObject,
  after: ExtensionObject,
  dialect: DdlDialect,
): readonly DdlStep[] {
  const steps: DdlStep[] = [];
  if (before.definition.schema !== after.definition.schema) {
    if (!after.definition.relocatable) {
      throw new OkmError(
        "OKM1814",
        `Extension ${after.identity.name} is not relocatable, so it cannot move to ${after.definition.schema}.`,
        {
          fix: {
            summary:
              "Drop or move the dependents first. Postgres cannot lower an extension version.",
          },
        },
      );
    }
    steps.push(
      ...dialect.lower({
        op: "move-extension",
        name: after.identity.name,
        schema: after.definition.schema,
      }),
    );
  }
  const previous = before.definition.version;
  const next = after.definition.version;
  if (!isExactVersion(previous) || !isExactVersion(next) || previous === next) return steps;
  if (compareExtensionVersions(next, previous) < 0) {
    throw new OkmError(
      "OKM1814",
      `Extension ${after.identity.name} cannot move from ${previous} to ${next}. Postgres cannot lower an extension version.`,
      {
        fix: {
          summary: "Drop or move the dependents first. Postgres cannot lower an extension version.",
        },
      },
    );
  }
  steps.push(
    ...dialect.lower({ op: "update-extension", name: after.identity.name, version: next }),
  );
  return steps;
}

/**
 * Refuses `CREATE EXTENSION` when the current role cannot run it.
 *
 * A superuser can create any available extension. Anyone else needs `CREATE`
 * on the database, and the default version must be trusted. An extension
 * that is already installed is skipped: the replay and a later apply do not
 * create it again. A name missing from `pg_available_extensions` is skipped
 * so the caller can report that the package is absent.
 *
 * @param runner - Pool or connection, after `SET ROLE` when a migration role is in force
 * @param names - Extensions a statement will create
 * @throws OkmError OKM1811 naming the role and the extension
 */
export async function assertRoleCanCreateExtensions(
  runner: SqlRunner,
  names: readonly string[],
): Promise<void> {
  const unique = [...new Set(names)];
  if (unique.length === 0) return;
  const who = await runner.execute(
    `select current_user::text, r.rolsuper::text,
            has_database_privilege(current_user, current_database(), 'CREATE')::text
       from pg_roles r
      where r.rolname = current_user`,
  );
  const row = who.rows[0];
  if (flag(row?.[1])) return;
  const role = text(row?.[0]);
  const create = flag(row?.[2]);
  const placeholders = unique.map((_, index) => `$${String(index + 1)}`).join(", ");
  const listed = await runner.execute(
    `select e.name, v.trusted::text, (x.oid is not null)::text
       from pg_available_extensions e
       left join pg_available_extension_versions v
         on v.name = e.name and v.version = e.default_version
       left join pg_extension x on x.extname = e.name
      where e.name in (${placeholders})`,
    unique,
  );
  const known = new Map<string, { readonly trusted: boolean; readonly installed: boolean }>();
  for (const item of listed.rows) {
    const name = text(item[0]);
    if (name.length === 0) continue;
    known.set(name, { trusted: flag(item[1]), installed: flag(item[2]) });
  }
  for (const name of unique) {
    const found = known.get(name);
    if (found === undefined || found.installed) continue;
    if (found.trusted && create) continue;
    const why = found.trusted
      ? `Grant CREATE on the database to ${role}. A non-superuser needs it to create ${name}.`
      : `Only a superuser can create ${name}. The default version is not trusted.`;
    throw new OkmError("OKM1811", `Role ${role} cannot create extension ${name}.`, {
      fix: { summary: why },
    });
  }
}

type SqlRunner = {
  execute(
    text: string,
    params?: readonly (string | null)[],
  ): Promise<{ readonly rows: readonly (readonly unknown[])[] }>;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

async function availableExtensions(
  connection: DriverConnection,
  names: readonly string[],
): Promise<Set<string>> {
  const listed = await connection.execute(
    `select name from pg_available_extensions where name in (${names.map((_, index) => `$${String(index + 1)}`).join(", ")})`,
    names,
  );
  const found = new Set<string>();
  for (const row of listed.rows) {
    const name = row[0];
    if (typeof name === "string") found.add(name);
  }
  return found;
}

async function installedVersion(
  connection: DriverConnection,
  name: string,
): Promise<string | undefined> {
  const result = await connection.execute(
    "select extversion from pg_extension where extname = $1",
    [name],
  );
  const version = result.rows[0]?.[0];
  return typeof version === "string" ? version : undefined;
}

async function updatePath(
  connection: DriverConnection,
  name: string,
  source: string,
  target: string,
): Promise<boolean> {
  const result = await connection.execute(
    "select path from pg_extension_update_paths($1) where source = $2 and target = $3",
    [name, source, target],
  );
  const path = result.rows[0]?.[0];
  return typeof path === "string" && path.length > 0;
}
