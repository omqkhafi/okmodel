/**
 * `okm pull` reads a database and writes table files plus a schema file.
 *
 * The selected namespaces are only read. A scratch schema is created and
 * dropped to verify functions and views, then dropped before this returns.
 * A protected target is allowed. An existing file is refused before anything
 * is written.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import postgres, { type Sql } from "postgres";

import { OkmError } from "../../contracts/error.js";
import type { Casing } from "../../dialects/pg/casing.js";
import { cliNotice } from "../cli/notices.js";
import {
  introspectSchema,
  type CatalogQuery,
  type IntrospectSkip,
} from "../../dialects/pg/introspect.js";
import { catalog } from "../../contracts/catalog/build.js";
import { identityKey, staticNamespace } from "../../contracts/catalog/identity.js";
import type {
  Catalog,
  CatalogObject,
  Namespace,
  ObjectIdentity,
} from "../../contracts/catalog/types.js";
import { driverUrl } from "./driver-url.js";
import { finishQuiet, sessionFailure } from "./lost.js";
import { asProject, projectPath, type ProjectContext } from "./paths.js";
import { assertTargetPolicy, selectTarget } from "./policy.js";
import {
  emitPull,
  formatPullReport,
  tableExportNames,
  type PullCount,
  type PullFile,
  type PullImportExt,
  type PullLayout,
  type PullSkip,
} from "./pull-emit.js";
import { planRoutines } from "./pull-routines.js";
import { writeUnpulled } from "./unpulled.js";
import { verifyPulled } from "./pull-verify.js";
import { loadConfig } from "./project.js";

/** What `okm pull` prints, and the objects the files leave out. */
export type PullResult = {
  /** Report text, including the trailing newline. */
  readonly text: string;
  /** Objects that were not written. */
  readonly skipped: readonly PullSkip[];
};

/**
 * Introspects the selected namespaces and writes the schema source.
 *
 * The default namespace is `current_schema()`. `--schema` selects others and
 * may be repeated. `--out` is the directory that receives `schema.ts` and
 * `tables/`. Without it, the project's schema path and tables directory are
 * used. A tables directory that the config omits is `tables` beside the
 * schema file. `.okm/pull.json` is always written at the project root.
 *
 * @param cwd - Project directory
 * @param argv - Arguments after `pull`
 * @returns The report
 */
export async function pullProject(
  project: string | ProjectContext,
  argv: readonly string[],
): Promise<PullResult> {
  const { cwd } = asProject(project);
  const flags = parsePullArgs(argv);
  const config = await loadConfig(project);
  const target = selectTarget(config, flags.target);
  assertTargetPolicy(target, "pull", flags.allowProtected);
  const layout = layoutOf(cwd, config.schema, config.tables, flags.out);
  const sql = postgres(driverUrl(target.url), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    const read = await readCatalog(sql, flags.schemas);
    const query = queryOf(sql);
    const plan = planRoutines(read.catalog, tableExportNames(read.catalog, flags.casing));
    const verdicts = await verifyPulled(query, read.catalog, plan);
    const unexpressed = await countUnexpressed(query, read.schemas);
    const emitted = emitPull(
      read.catalog,
      layout,
      { plan, verdicts, unexpressed },
      {
        importExt: flags.importExt,
        ...(flags.casing === undefined ? {} : { casing: flags.casing }),
      },
    );
    const tables = emitted.files.filter((file) => file.path !== layout.schemaFile);
    if (tables.length === 0) {
      const name = read.schemas.join(", ");
      throw new OkmError("invalid", `Namespace ${name} has no tables.`, {
        fix: { summary: "Pass --schema <name> for a namespace that has tables." },
      });
    }
    commitPullFiles(emitted.files, "Pull");
    const skipped = [...emitted.skipped, ...read.outside];
    // The record stays at the project root. `--out` only moves the schema files.
    writeUnpulled(cwd, skipped);
    return {
      text: formatPullReport(
        emitted.counts,
        skipped,
        emitted.verdicts,
        unexpressed,
        "pulled",
        emitted.unvalidated,
        emitted.renames,
      ),
      skipped,
    };
  } catch (error) {
    if (error instanceof OkmError) throw error;
    throw sessionFailure(error) ?? unavailable(error);
  } finally {
    await finishQuiet(() => sql.end({ timeout: 5 }));
  }
}

/**
 * Reads `--out`, `--schema`, `--casing`, and `--target` from a pull invocation.
 *
 * @param argv - Arguments after `pull`
 * @returns The flags this command reads
 */
export function parsePullArgs(argv: readonly string[]): {
  readonly target: string | undefined;
  readonly allowProtected: boolean;
  readonly out: string | undefined;
  readonly schemas: readonly string[];
  readonly importExt: PullImportExt;
  /** Omitted keeps every database name as the TypeScript key. */
  readonly casing: Casing | undefined;
} {
  let target: string | undefined;
  let out: string | undefined;
  let allowProtected = false;
  let importExt: PullImportExt = "ts";
  let casing: Casing | undefined;
  const schemas: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--allow-protected") {
      allowProtected = true;
      continue;
    }
    if (
      arg === "--target" ||
      arg === "--schema" ||
      arg === "--out" ||
      arg === "--import-ext" ||
      arg === "--casing"
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new OkmError("invalid", `${arg} needs a value.`, {
          fix: { summary: `Pass ${arg} <value>.` },
        });
      }
      if (arg === "--target") target = value;
      else if (arg === "--out") out = value;
      else if (arg === "--import-ext") importExt = importExtValue(value);
      else if (arg === "--casing") casing = casingValue(value);
      else schemas.push(...splitSchemas(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
      continue;
    }
    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      continue;
    }
    if (arg.startsWith("--schema=")) {
      schemas.push(...splitSchemas(arg.slice("--schema=".length)));
      continue;
    }
    if (arg.startsWith("--import-ext=")) {
      importExt = importExtValue(arg.slice("--import-ext=".length));
      continue;
    }
    if (arg.startsWith("--casing=")) {
      casing = casingValue(arg.slice("--casing=".length));
      continue;
    }
    throw new OkmError("invalid", `Unknown flag ${arg}.`, {
      fix: { summary: "okm pull accepts --target, --schema, --out, --import-ext, and --casing." },
    });
  }
  return { target, allowProtected, out, schemas, importExt, casing };
}

function casingValue(value: string): Casing {
  if (value === "snake" || value === "camel") return value;
  throw new OkmError("invalid", "--casing accepts snake or camel.", {
    fix: { summary: "Pass --casing snake or --casing camel. Omit it to keep database names." },
  });
}

function importExtValue(value: string): PullImportExt {
  if (value === "ts" || value === "js" || value === "none") return value;
  throw new OkmError("invalid", "--import-ext accepts ts, js, or none.", {
    fix: { summary: "Pass --import-ext ts, --import-ext js, or --import-ext none." },
  });
}

async function readCatalog(
  sql: Sql,
  schemas: readonly string[],
): Promise<{
  readonly catalog: Catalog;
  readonly schemas: readonly string[];
  readonly outside: readonly PullSkip[];
}> {
  try {
    const requested = schemas.length > 0 ? schemas : [await currentSchema(sql)];
    const chosen = uniqueNames(requested);
    const parts: { schema: string; objects: readonly CatalogObject[] }[] = [];
    const reserved: IntrospectSkip[] = [];
    for (const name of chosen) {
      // Logical name is the concrete schema so a foreign key to another
      // schema is recorded, instead of looking like a missing public table.
      const live = await introspectSchema(queryOf(sql), name, name, { reserved });
      parts.push({ schema: name, objects: live.objects });
    }
    const merged = mergePulledSchemas(parts);
    return {
      catalog: merged.catalog,
      schemas: chosen,
      outside: [...merged.outside, ...reserved.map((item) => ({ ...item, sql: "" }))],
    };
  } catch (error) {
    if (error instanceof OkmError) throw error;
    throw sessionFailure(error) ?? unavailable(error);
  }
}

/**
 * Folds every selected schema into the one namespace `schema()` can hold.
 *
 * A foreign key whose target was not selected is omitted and reported.
 * Two selected schemas that share a table name are OKM1023: the files would
 * both become `public` and `catalog()` would only say "Duplicate identity".
 */
function mergePulledSchemas(
  parts: readonly { schema: string; objects: readonly CatalogObject[] }[],
): {
  readonly catalog: Catalog;
  readonly outside: readonly PullSkip[];
} {
  const selected = new Set(parts.map((part) => part.schema));
  const tables = new Map<string, string[]>();
  for (const part of parts) {
    for (const object of part.objects) {
      if (object.kind !== "table" || schemaOf(object.identity) !== part.schema) continue;
      const list = tables.get(object.identity.name) ?? [];
      list.push(part.schema);
      tables.set(object.identity.name, list);
    }
  }
  for (const [name, schemas] of tables) {
    if (schemas.length < 2) continue;
    const list = schemas.length === 2 ? `${schemas[0]} and ${schemas[1]}` : schemas.join(", ");
    throw new OkmError(
      "OKM1023",
      `Table ${name} is in ${list}. schema() has one namespace, so okm pull cannot keep both.`,
      {
        fix: {
          summary: "Pull one of those schemas, or rename one table. schema() has one namespace.",
        },
      },
    );
  }
  const selectedTables = new Set<string>();
  for (const [name, schemas] of tables) {
    const schema = schemas[0];
    if (schema !== undefined) selectedTables.add(`${schema}.${name}`);
  }
  const objects: CatalogObject[] = [];
  const outside: PullSkip[] = [];
  for (const part of parts) {
    for (const object of part.objects) {
      const home = schemaOf(object.identity);
      if (home !== undefined && home !== part.schema) continue;
      if (
        object.kind === "constraint" &&
        object.definition.references !== undefined &&
        !selectedTarget(object.definition.references.parent, selected, selectedTables)
      ) {
        outside.push({
          key: identityKey(object.identity),
          kind: "constraint",
          label: `${object.identity.parent.name}.${object.identity.name}`,
          reason: "references a table outside the selected schemas",
          sql: "",
        });
        continue;
      }
      objects.push(rewriteSchema(object, selected));
    }
  }
  return { catalog: adoptCatalog(objects), outside };
}

function selectedTarget(
  parent: { readonly namespace: Namespace; readonly name: string },
  selected: ReadonlySet<string>,
  tables: ReadonlySet<string>,
): boolean {
  if (parent.namespace.form !== "static") return false;
  return (
    tables.has(`${parent.namespace.name}.${parent.name}`) && selected.has(parent.namespace.name)
  );
}

function adoptCatalog(objects: readonly CatalogObject[]): Catalog {
  try {
    return catalog(objects);
  } catch (error) {
    if (error instanceof OkmError && error.code === "OKM1023") {
      throw new OkmError(
        "OKM1023",
        `${error.message} schema() has one namespace, so okm pull cannot keep both.`,
        {
          fix: {
            summary: "Pull one schema, or rename one of the objects. schema() has one namespace.",
          },
        },
      );
    }
    throw error;
  }
}

function rewriteSchema(object: CatalogObject, selected: ReadonlySet<string>): CatalogObject {
  const identity = rewriteIdentity(object.identity, selected);
  const dependencies = object.dependencies
    .filter((edge) => {
      const home = schemaOf(edge.target);
      return home === undefined || selected.has(home);
    })
    .map((edge) => ({ target: rewriteIdentity(edge.target, selected) }));
  if (object.kind === "constraint" && object.definition.references !== undefined) {
    const references = object.definition.references;
    return {
      ...object,
      identity,
      dependencies,
      definition: {
        ...object.definition,
        references: {
          ...references,
          parent: {
            name: references.parent.name,
            namespace: mapNamespace(references.parent.namespace, selected),
          },
        },
      },
    } as CatalogObject;
  }
  return { ...object, identity, dependencies } as CatalogObject;
}

function rewriteIdentity(identity: ObjectIdentity, selected: ReadonlySet<string>): ObjectIdentity {
  switch (identity.kind) {
    case "table":
    case "view":
    case "materializedView":
    case "sequence":
    case "type":
    case "function":
    case "defaultPrivilege":
      return { ...identity, namespace: mapNamespace(identity.namespace, selected) };
    case "column":
    case "index":
    case "constraint":
    case "trigger":
    case "policy":
      return {
        ...identity,
        parent: {
          name: identity.parent.name,
          namespace: mapNamespace(identity.parent.namespace, selected),
        },
      };
    case "grant":
      return {
        ...identity,
        object: {
          ...identity.object,
          namespace: mapNamespace(identity.object.namespace, selected),
        },
      };
    case "role":
    case "extension":
      return identity;
  }
}

function mapNamespace(namespace: Namespace, selected: ReadonlySet<string>): Namespace {
  if (namespace.form !== "static" || namespace.name === "public" || !selected.has(namespace.name)) {
    return namespace;
  }
  return staticNamespace("public");
}

function schemaOf(identity: ObjectIdentity): string | undefined {
  switch (identity.kind) {
    case "table":
    case "view":
    case "materializedView":
    case "sequence":
    case "type":
    case "function":
    case "defaultPrivilege":
      return identity.namespace.form === "static" ? identity.namespace.name : undefined;
    case "column":
    case "index":
    case "constraint":
    case "trigger":
    case "policy":
      return identity.parent.namespace.form === "static"
        ? identity.parent.namespace.name
        : undefined;
    case "grant":
      return identity.object.namespace.form === "static"
        ? identity.object.namespace.name
        : undefined;
    case "role":
    case "extension":
      return undefined;
  }
}

function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const chosen: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    chosen.push(name);
  }
  return chosen;
}

const UNEXPRESSED = `
  select
    (select count(*)::int from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $1 and p.prokind = 'a') as aggregates,
    (select count(*)::int from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $1 and p.prokind = 'p') as procedures,
    (select count(*)::int from pg_event_trigger) as event_triggers,
    (select count(*)::int from pg_rewrite r
      join pg_class c on c.oid = r.ev_class
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and r.rulename <> '_RETURN') as rules
`;

async function countUnexpressed(
  query: CatalogQuery,
  schemas: readonly string[],
): Promise<readonly PullCount[]> {
  let aggregates = 0;
  let procedures = 0;
  let eventTriggers = 0;
  let rules = 0;
  for (const name of schemas) {
    const rows = await query.query(UNEXPRESSED, [name]);
    const row = rows[0];
    aggregates += countCell(row?.aggregates);
    procedures += countCell(row?.procedures);
    eventTriggers = countCell(row?.event_triggers);
    rules += countCell(row?.rules);
  }
  return [
    { kind: "aggregate", count: aggregates, reason: "the catalog has no aggregate kind" },
    { kind: "procedure", count: procedures, reason: "the catalog has no procedure kind" },
    {
      kind: "eventTrigger",
      count: eventTriggers,
      reason: "the catalog has no event trigger kind",
    },
    { kind: "rule", count: rules, reason: "the catalog has no rule kind" },
  ];
}

function countCell(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > 0) return Number(value);
  return 0;
}

async function currentSchema(sql: Sql): Promise<string> {
  const rows = await sql<{ name: string | null }[]>`select current_schema() as name`;
  const name = rows[0]?.name;
  if (name === null || name === undefined || name.length === 0) {
    throw new OkmError("invalid", "The target has no current schema.", {
      fix: { summary: "Pass --schema <name>." },
    });
  }
  return name;
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

/**
 * Resolves the schema file and the tables directory for a pull or an import.
 *
 * `--out` writes `schema.ts` and `tables/` under that directory. Without it,
 * the project's schema path and tables directory are used.
 *
 * @param cwd - Project directory
 * @param schema - Config schema path
 * @param tables - Config tables directory, when set
 * @param out - `--out` directory, when set
 * @returns Absolute paths
 */
export function pullLayout(
  cwd: string,
  schema: string,
  tables: string | undefined,
  out: string | undefined,
): PullLayout {
  return layoutOf(cwd, schema, tables, out);
}

/**
 * Refuses an existing file, writes the rest, and formats them.
 *
 * When `oxfmt` is missing or fails, the files stay as written and a notice is
 * printed on stderr. The pull or import report still returns.
 *
 * @param files - Files from {@link emitPull}
 * @param verb - `Pull` or `Import`, named in OKM1855
 */
export function commitPullFiles(
  files: readonly PullFile[],
  verb: "Pull" | "Import" = "Pull",
): void {
  refuseExisting(files, verb);
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.text);
  }
  formatFiles(files.map((file) => file.path));
}

function layoutOf(
  cwd: string,
  schema: string,
  tables: string | undefined,
  out: string | undefined,
): { readonly schemaFile: string; readonly tablesDir: string } {
  if (out !== undefined) {
    const root = projectPath(cwd, out);
    return { schemaFile: join(root, "schema.ts"), tablesDir: join(root, "tables") };
  }
  const schemaFile = projectPath(cwd, schema);
  const tablesDir =
    tables !== undefined ? projectPath(cwd, tables) : join(dirname(schemaFile), "tables");
  return { schemaFile, tablesDir };
}

function refuseExisting(files: readonly PullFile[], verb: "Pull" | "Import"): void {
  for (const file of files) {
    if (!existsSync(file.path)) continue;
    throw new OkmError("OKM1855", `${verb} would overwrite ${file.path}.`, {
      fix: {
        summary: `Pass --out <directory> to write somewhere else, or move ${file.path}.`,
      },
    });
  }
}

function formatFiles(files: readonly string[]): void {
  if (files.length === 0) return;
  const root = formatterRoot(dirname(files[0] ?? "."));
  const pathEnv = [join(root, "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter);
  const result = spawnSync("oxfmt", ["--write", ...files], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: pathEnv },
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = (
      result.stderr ||
      result.stdout ||
      result.error?.message ||
      "oxfmt failed"
    ).trim();
    cliNotice(`notice: oxfmt missing or failed; wrote unformatted files. ${detail}`);
  }
}

function formatterRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".oxfmtrc.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function splitSchemas(value: string): readonly string[] {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new OkmError("invalid", "--schema needs a name.", {
      fix: { summary: "Pass --schema <name>. Repeat the flag to read more than one." },
    });
  }
  return names;
}

function unavailable(error: unknown): OkmError {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "The database is unavailable.";
  return new OkmError("unavailable", message, {
    kind: "unavailable",
    cause: error,
    fix: { summary: "Check the target URL. okm pull only reads." },
  });
}
