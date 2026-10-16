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
import { dirname, join } from "node:path";

import postgres, { type Sql } from "postgres";

import { OkmError } from "../../contracts/error.js";
import { introspectSchema, type CatalogQuery } from "../../dialects/pg/introspect.js";
import { catalog } from "../../contracts/catalog/build.js";
import type { Catalog, CatalogObject } from "../../contracts/catalog/types.js";
import { finishQuiet, sessionFailure } from "./lost.js";
import { projectPath } from "./paths.js";
import { assertTargetPolicy, selectTarget } from "./policy.js";
import {
  emitPull,
  formatPullReport,
  tableExportNames,
  type PullCount,
  type PullFile,
  type PullLayout,
  type PullSkip,
} from "./pull-emit.js";
import { planRoutines } from "./pull-routines.js";
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
 * schema file.
 *
 * @param cwd - Project directory
 * @param argv - Arguments after `pull`
 * @returns The report
 */
export async function pullProject(cwd: string, argv: readonly string[]): Promise<PullResult> {
  const flags = parsePullArgs(argv);
  const config = await loadConfig(cwd);
  const target = selectTarget(config, flags.target);
  assertTargetPolicy(target, "pull", flags.allowProtected);
  const layout = layoutOf(cwd, config.schema, config.tables, flags.out);
  const sql = postgres(target.url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    const read = await readCatalog(sql, flags.schemas);
    const query = queryOf(sql);
    const plan = planRoutines(read.catalog, tableExportNames(read.catalog));
    const verdicts = await verifyPulled(query, read.catalog, plan);
    const unexpressed = await countUnexpressed(query, read.schemas);
    const emitted = emitPull(read.catalog, layout, { plan, verdicts, unexpressed });
    const tables = emitted.files.filter((file) => file.path !== layout.schemaFile);
    if (tables.length === 0) {
      const name = read.schemas.join(", ");
      throw new OkmError("invalid", `Namespace ${name} has no tables.`, {
        fix: { summary: "Pass --schema <name> for a namespace that has tables." },
      });
    }
    commitPullFiles(emitted.files, "Pull");
    return {
      text: formatPullReport(emitted.counts, emitted.skipped, emitted.verdicts, unexpressed),
      skipped: emitted.skipped,
    };
  } catch (error) {
    if (error instanceof OkmError) throw error;
    throw sessionFailure(error) ?? unavailable(error);
  } finally {
    await finishQuiet(() => sql.end({ timeout: 5 }));
  }
}

/**
 * Reads `--out`, `--schema`, and `--target` from a pull invocation.
 *
 * @param argv - Arguments after `pull`
 * @returns The flags this command reads
 */
export function parsePullArgs(argv: readonly string[]): {
  readonly target: string | undefined;
  readonly allowProtected: boolean;
  readonly out: string | undefined;
  readonly schemas: readonly string[];
} {
  let target: string | undefined;
  let out: string | undefined;
  let allowProtected = false;
  const schemas: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--allow-protected") {
      allowProtected = true;
      continue;
    }
    if (arg === "--target" || arg === "--schema" || arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new OkmError("invalid", `${arg} needs a value.`, {
          fix: { summary: `Pass ${arg} <value>.` },
        });
      }
      if (arg === "--target") target = value;
      else if (arg === "--out") out = value;
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
    throw new OkmError("invalid", `Unknown flag ${arg}.`, {
      fix: { summary: "okm pull accepts --target, --schema, --out, and --allow-protected." },
    });
  }
  return { target, allowProtected, out, schemas };
}

async function readCatalog(
  sql: Sql,
  schemas: readonly string[],
): Promise<{ readonly catalog: Catalog; readonly schemas: readonly string[] }> {
  try {
    const chosen = schemas.length > 0 ? schemas : [await currentSchema(sql)];
    const objects: CatalogObject[] = [];
    for (const name of chosen) {
      const live = await introspectSchema(queryOf(sql), name, "public");
      objects.push(...live.objects);
    }
    return { catalog: catalog(objects), schemas: chosen };
  } catch (error) {
    if (error instanceof OkmError) throw error;
    throw sessionFailure(error) ?? unavailable(error);
  }
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
  const binary = join(root, "node_modules", ".bin", "oxfmt");
  const result = spawnSync(binary, ["--write", ...files], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.stderr || result.stdout || "oxfmt failed";
    throw new OkmError("invalid", `The pulled files were not formatted. ${detail.trim()}`, {
      fix: { summary: "Run oxfmt on the pulled files, or fix the formatter settings." },
    });
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
