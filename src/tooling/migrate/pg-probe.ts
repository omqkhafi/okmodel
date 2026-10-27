/**
 * Postgres probes for a committed step.
 *
 * Only `create-index` (concurrent), `drop-index` (concurrent),
 * `add-constraint`, `validate-constraint`, and `add-enum-value` have a
 * built-in probe. A step may also declare `-- probe:`. A built-in probe
 * wins. A declared probe is one read-only `SELECT` run inside
 * `begin read only` and then rolled back. True is `applied`, false is
 * `absent`. NULL, more than one row, a non-boolean, or an error is
 * `unknown`, never `applied`. A declared probe has no cleanup: the
 * statement has to be atomic, or the author repairs a partial result
 * with `okm migrate resolve`.
 *
 * A valid object is `applied` only when the statement's definition can be
 * proved equal to the catalog. Anything the parser cannot prove is
 * `unknown`, never `applied`.
 */

import type { DriverConnection, ExecuteResult } from "../../contracts/driver.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { PartialCleanupError, type ProbeResult, type StepEngine } from "./step-engine.js";

/** Whether this kind and statement have a Postgres probe. */
export type DefinitionVerdict = "match" | "differ" | "unparsed";

/**
 * Reports whether Postgres can probe this committed step.
 *
 * @param kind - Planner kind, or `raw-sql`
 * @param sql - Statement text
 * @returns `true` when {@link postgresStepEngine} reads the catalog
 */
export function postgresHasProbe(kind: string, sql: string): boolean {
  const resolved = probeKind(kind, sql);
  if (resolved === "create-index" || resolved === "drop-index")
    return /\bconcurrently\b/i.test(sql);
  return (
    resolved === "add-constraint" ||
    resolved === "validate-constraint" ||
    resolved === "add-enum-value"
  );
}

/**
 * Reports whether the built-in probe can read this statement.
 *
 * A concurrent index whose name cannot be read, and a constraint, validate,
 * or enum step whose statement cannot be read, is false. That probe would
 * return `unknown` for every database.
 *
 * @param kind - Planner kind, or `raw-sql`
 * @param sql - Statement text
 * @returns `true` when {@link postgresStepEngine} has a built-in probe that parses `sql`
 */
export function postgresProbeParses(kind: string, sql: string): boolean {
  if (!postgresHasProbe(kind, sql)) return false;
  const resolved = probeKind(kind, sql);
  switch (resolved) {
    case "create-index":
      return parseCreateIndex(sql) !== undefined;
    case "drop-index":
      return parseDropIndex(sql) !== undefined;
    case "add-constraint":
      return parseAddConstraint(sql) !== undefined;
    case "validate-constraint":
      return parseValidate(sql) !== undefined;
    case "add-enum-value":
      return parseAddEnum(sql) !== undefined;
    default:
      return false;
  }
}

/**
 * Kind the probe uses.
 *
 * A hand-written step may omit `kind`. A concurrent index statement is still
 * `create-index` or `drop-index`, which is what the existing apply tests run.
 */
function probeKind(kind: string, sql: string): string {
  if (kind !== "raw-sql") return kind;
  if (/^\s*create\s+(?:unique\s+)?index\s+concurrently\b/i.test(sql)) return "create-index";
  if (/^\s*drop\s+index\s+concurrently\b/i.test(sql)) return "drop-index";
  return kind;
}

/**
 * Compares a `CREATE INDEX` statement with `pg_get_indexdef`.
 *
 * @param statement - The step text
 * @param catalogDef - `pg_get_indexdef` output
 * @param currentSchema - Schema used when the statement omits one
 * @returns `match`, `differ`, or `unparsed` when equality cannot be proved
 */
export function indexDefinitionVerdict(
  statement: string,
  catalogDef: string,
  currentSchema: string,
): DefinitionVerdict {
  const fromStep = parseCreateIndex(statement);
  const fromCatalog = parseCreateIndex(catalogDef);
  if (
    fromStep === undefined ||
    fromCatalog === undefined ||
    !fromStep.defined ||
    !fromCatalog.defined ||
    fromStep.columns === undefined ||
    fromCatalog.columns === undefined
  ) {
    return "unparsed";
  }
  const stepSchema = fromStep.schema ?? currentSchema;
  const catalogSchema = fromCatalog.schema ?? currentSchema;
  const same =
    fromStep.unique === fromCatalog.unique &&
    fromStep.name === fromCatalog.name &&
    stepSchema === catalogSchema &&
    fromStep.table === fromCatalog.table &&
    fromStep.method === fromCatalog.method &&
    fromStep.columns === fromCatalog.columns &&
    fromStep.predicate === fromCatalog.predicate;
  return same ? "match" : "differ";
}

/**
 * Compares an `ADD CONSTRAINT` body with `pg_get_constraintdef`.
 *
 * @param statement - The step text
 * @param catalogDef - `pg_get_constraintdef` output
 * @returns `match`, `differ`, or `unparsed` when equality cannot be proved
 */
export function constraintDefinitionVerdict(
  statement: string,
  catalogDef: string,
): DefinitionVerdict {
  const fromStep = constraintBody(statement);
  if (fromStep === undefined) return "unparsed";
  const left = canonicalConstraint(fromStep);
  const right = canonicalConstraint(catalogDef);
  if (left === undefined || right === undefined) return "unparsed";
  return left === right ? "match" : "differ";
}

/**
 * Probe, cleanup, and run for one Postgres step.
 *
 * @param connection - Reserved connection, search path already set
 * @param step - Kind, statement, and the lock timeout cleanup uses
 * @param run - Runs the statement after roles are in place
 * @returns The engine the resume state machine calls
 */
export function postgresStepEngine(
  connection: DriverConnection,
  step: {
    readonly kind: string;
    readonly sql: string;
    readonly lockTimeoutMs: number;
    /** Declared `-- probe:` text. A built-in probe for `kind` still wins. */
    readonly probe?: string;
  },
  run: () => Promise<void>,
): StepEngine {
  const builtin = postgresHasProbe(step.kind, step.sql);
  const declared = step.probe !== undefined && step.probe.trim().length > 0;
  const probed = builtin || declared;
  const kind = probeKind(step.kind, step.sql);
  const created = parseCreateIndex(step.sql);
  const indexLabel =
    created !== undefined && /\bconcurrently\b/i.test(step.sql)
      ? qualifiedName(created.schema, created.name)
      : undefined;
  return {
    ...(indexLabel !== undefined ? { indexLabel } : {}),
    probed,
    probe: () => {
      if (builtin) return probeStep(connection, kind, step.sql);
      if (declared && step.probe !== undefined) return probeDeclared(connection, step.probe);
      return Promise.resolve("unknown");
    },
    cleanup: () => (builtin ? cleanupStep(connection, { ...step, kind }) : Promise.resolve()),
    run,
  };
}

/**
 * Runs a declared probe in a read-only transaction.
 *
 * There is no cleanup. A raw step has to be atomic, or its author repairs
 * a partial result with `okm migrate resolve`.
 *
 * @param connection - Reserved connection
 * @param probe - The `-- probe:` statement
 * @returns `applied`, `absent`, or `unknown`
 */
async function probeDeclared(connection: DriverConnection, probe: string): Promise<ProbeResult> {
  let open = false;
  try {
    await connection.execute("begin read only");
    open = true;
    const result = await connection.execute(probe);
    return declaredVerdict(result);
  } catch {
    return "unknown";
  } finally {
    if (open) await connection.execute("rollback").catch(() => undefined);
  }
}

function declaredVerdict(result: ExecuteResult): ProbeResult {
  if (result.rows.length !== 1) return "unknown";
  const row = result.rows[0];
  if (row === undefined || row.length !== 1) return "unknown";
  const value = row[0];
  if (wireTrue(value)) return "applied";
  if (wireFalse(value)) return "absent";
  return "unknown";
}

async function probeStep(
  connection: DriverConnection,
  kind: string,
  sql: string,
): Promise<ProbeResult> {
  switch (kind) {
    case "create-index":
      return probeCreateIndex(connection, sql);
    case "drop-index":
      return probeDropIndex(connection, sql);
    case "add-constraint":
      return probeAddConstraint(connection, sql);
    case "validate-constraint":
      return probeValidate(connection, sql);
    case "add-enum-value":
      return probeEnum(connection, sql);
    default:
      return "unknown";
  }
}

async function probeCreateIndex(connection: DriverConnection, sql: string): Promise<ProbeResult> {
  const parsed = parseCreateIndex(sql);
  if (parsed === undefined) return "unknown";
  const found = await connection.execute(
    `select i.indisvalid, pg_get_indexdef(c.oid), current_schema()
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_index i on i.indexrelid = c.oid
     where c.relname = $1 and n.nspname = coalesce($2, current_schema())`,
    [parsed.name, parsed.schema ?? null],
  );
  const row = found.rows[0];
  if (row === undefined) return "absent";
  if (!wireTrue(row[0])) return "partial";
  const definition = row[1];
  const schema = row[2];
  if (definition === null || definition === undefined || schema === null || schema === undefined) {
    return "unknown";
  }
  const verdict = indexDefinitionVerdict(sql, definition, schema);
  return verdict === "match" ? "applied" : "unknown";
}

async function probeDropIndex(connection: DriverConnection, sql: string): Promise<ProbeResult> {
  const parsed = parseDropIndex(sql);
  if (parsed === undefined) return "unknown";
  const found = await connection.execute(
    `select 1
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'i' and c.relname = $1 and n.nspname = coalesce($2, current_schema())`,
    [parsed.name, parsed.schema ?? null],
  );
  return found.rows.length === 0 ? "applied" : "absent";
}

async function probeAddConstraint(connection: DriverConnection, sql: string): Promise<ProbeResult> {
  const parsed = parseAddConstraint(sql);
  if (parsed === undefined) return "unknown";
  const found = await connection.execute(
    `select pg_get_constraintdef(c.oid)
     from pg_constraint c
     join pg_class r on r.oid = c.conrelid
     join pg_namespace n on n.oid = r.relnamespace
     where c.conname = $1 and r.relname = $2 and n.nspname = coalesce($3, current_schema())`,
    [parsed.name, parsed.table, parsed.schema ?? null],
  );
  const definition = found.rows[0]?.[0];
  if (definition === null || definition === undefined) return "absent";
  const verdict = constraintDefinitionVerdict(sql, definition);
  if (verdict === "match") return "applied";
  return "unknown";
}

async function probeValidate(connection: DriverConnection, sql: string): Promise<ProbeResult> {
  const parsed = parseValidate(sql);
  if (parsed === undefined) return "unknown";
  const found = await connection.execute(
    `select c.convalidated
     from pg_constraint c
     join pg_class r on r.oid = c.conrelid
     join pg_namespace n on n.oid = r.relnamespace
     where c.conname = $1 and r.relname = $2 and n.nspname = coalesce($3, current_schema())`,
    [parsed.name, parsed.table, parsed.schema ?? null],
  );
  const flag = found.rows[0]?.[0];
  if (flag === null || flag === undefined) return "unknown";
  return wireTrue(flag) ? "applied" : "absent";
}

async function probeEnum(connection: DriverConnection, sql: string): Promise<ProbeResult> {
  const parsed = parseAddEnum(sql);
  if (parsed === undefined) return "unknown";
  const found = await connection.execute(
    `select 1
     from pg_enum e
     join pg_type t on t.oid = e.enumtypid
     join pg_namespace n on n.oid = t.typnamespace
     where t.typname = $1 and n.nspname = coalesce($2, current_schema()) and e.enumlabel = $3`,
    [parsed.name, parsed.schema ?? null, parsed.label],
  );
  return found.rows.length === 0 ? "absent" : "applied";
}

async function cleanupStep(
  connection: DriverConnection,
  step: { readonly kind: string; readonly sql: string; readonly lockTimeoutMs: number },
): Promise<void> {
  if (step.kind !== "create-index") return;
  const parsed = parseCreateIndex(step.sql);
  if (parsed === undefined) {
    throw new PartialCleanupError(
      " Index cleanup could not read the index name.",
      "Drop the INVALID index with DROP INDEX CONCURRENTLY. Then run apply again.",
    );
  }
  const quoted = quoteIdent(parsed.name);
  const repair = indexRepair(qualifiedName(parsed.schema, parsed.name));
  if (await indexBuildInProgress(connection, parsed)) throw waitForIndex(quoted);
  await connection.execute("select set_config('lock_timeout', $1, false)", [
    String(step.lockTimeoutMs),
  ]);
  try {
    if (await indexBuildInProgress(connection, parsed)) throw waitForIndex(quoted);
    await connection.execute(
      `drop index concurrently if exists ${qualifiedName(parsed.schema, parsed.name)}`,
    );
  } catch (error) {
    if (error instanceof PartialCleanupError) throw error;
    if (await indexBuildInProgress(connection, parsed)) throw waitForIndex(quoted);
    throw new PartialCleanupError(` Index ${quoted} is INVALID.`, repair, error);
  }
}

/**
 * Another session is creating this index.
 *
 * `pg_stat_activity` matches the build statement. `pg_stat_progress_create_index`
 * matches a build that has a progress row. Either one means the index is not
 * ours to drop.
 *
 * @param connection - Session that would drop the index
 * @param parsed - Index the failed step was creating
 * @returns `true` when another backend is building it
 */
async function indexBuildInProgress(
  connection: DriverConnection,
  parsed: IndexShape,
): Promise<boolean> {
  const activity = await connection.execute(
    `select a.pid::text
     from pg_stat_activity a
     where a.pid <> pg_backend_pid()
       and a.state = 'active'
       and (a.query ~* $1 or a.query ~ $2)`,
    [bareIndexBuild(parsed.name), quotedIndexBuild(parsed.name)],
  );
  if (activity.rows.length > 0) return true;
  const progress = await connection.execute(
    `select 1
     from pg_stat_progress_create_index p
     join pg_class c on c.oid = p.index_relid
     left join pg_namespace n on n.oid = c.relnamespace
     where p.pid <> pg_backend_pid()
       and c.relname = $1
       and ($2::text is null or n.nspname = $2)`,
    [parsed.name, parsed.schema ?? null],
  );
  return progress.rows.length > 0;
}

/**
 * Advice when another session is still building the index.
 *
 * @param quoted - Quoted index name
 * @returns A cleanup error that does not name DROP INDEX
 */
function waitForIndex(quoted: string): PartialCleanupError {
  return new PartialCleanupError(
    ` Index ${quoted} is being built by another session.`,
    "Wait and apply again.",
    undefined,
    "wait and apply again",
  );
}

type IndexShape = {
  readonly unique: boolean;
  readonly name: string;
  readonly schema: string | undefined;
  readonly table: string;
  readonly method: string;
  readonly columns: string | undefined;
  readonly predicate: string | undefined;
  /** False when the definition cannot be proved equal to `pg_get_indexdef`. */
  readonly defined: boolean;
};

function parseCreateIndex(sql: string): IndexShape | undefined {
  const text = sql.trim().replace(/;\s*$/, "");
  let cursor = keyword(text, 0, "create");
  if (cursor === undefined) return undefined;
  const uniqueAt = keyword(text, cursor, "unique");
  const unique = uniqueAt !== undefined;
  if (uniqueAt !== undefined) cursor = uniqueAt;
  const indexAt = keyword(text, cursor, "index");
  if (indexAt === undefined) return undefined;
  cursor = indexAt;
  const concurrentAt = keyword(text, cursor, "concurrently");
  if (concurrentAt !== undefined) cursor = concurrentAt;
  const ifAt = keyword(text, cursor, "if");
  if (ifAt !== undefined) {
    const notAt = keyword(text, ifAt, "not");
    const existsAt = notAt === undefined ? undefined : keyword(text, notAt, "exists");
    if (existsAt === undefined) return undefined;
    cursor = existsAt;
  }
  const indexName = readQualified(text, cursor);
  if (indexName === undefined) return undefined;
  cursor = keyword(text, indexName.next, "on");
  if (cursor === undefined) return undefined;
  const table = readQualified(text, cursor);
  if (table === undefined) return undefined;
  cursor = table.next;
  let method = "btree";
  const usingAt = keyword(text, cursor, "using");
  if (usingAt !== undefined) {
    const methodIdent = readIdent(text, usingAt);
    if (methodIdent === undefined) return undefined;
    method = methodIdent.value;
    cursor = methodIdent.next;
  }
  const columns = readParen(text, cursor);
  if (columns === undefined) return undefined;
  const rendered = simpleColumns(columns.inner);
  cursor = columns.next;
  let defined = rendered !== undefined;
  const includeAt = keyword(text, cursor, "include");
  if (includeAt !== undefined) {
    const included = readParen(text, includeAt);
    if (included === undefined) return undefined;
    defined = false;
    cursor = included.next;
  }
  let predicate: string | undefined;
  const whereAt = keyword(text, cursor, "where");
  if (whereAt !== undefined) {
    const rest = text.slice(whereAt).trim();
    if (rest.length === 0 || rest.includes('"') || rest.includes("::")) defined = false;
    else predicate = rest.replace(/\s+/g, " ").toLowerCase();
    cursor = text.length;
  }
  if (skipSpace(text, cursor) < text.length) defined = false;
  return {
    unique,
    name: indexName.name,
    // An unqualified index is created in the table's schema, not the current one.
    schema: indexName.schema ?? table.schema,
    table: table.name,
    method,
    columns: rendered,
    predicate,
    defined,
  };
}

type DropTarget = { readonly schema: string | undefined; readonly name: string };

function parseDropIndex(sql: string): DropTarget | undefined {
  const text = sql.trim().replace(/;\s*$/, "");
  let cursor = keyword(text, 0, "drop");
  if (cursor === undefined) return undefined;
  cursor = keyword(text, cursor, "index");
  if (cursor === undefined) return undefined;
  const concurrentAt = keyword(text, cursor, "concurrently");
  if (concurrentAt !== undefined) cursor = concurrentAt;
  const ifAt = keyword(text, cursor, "if");
  if (ifAt !== undefined) {
    const existsAt = keyword(text, ifAt, "exists");
    if (existsAt === undefined) return undefined;
    cursor = existsAt;
  }
  const target = readQualified(text, cursor);
  if (target === undefined) return undefined;
  if (skipSpace(text, target.next) < text.length) return undefined;
  return { schema: target.schema, name: target.name };
}

type ConstraintRef = {
  readonly schema: string | undefined;
  readonly table: string;
  readonly name: string;
};

function parseAddConstraint(sql: string): ConstraintRef | undefined {
  const header = alterTable(sql);
  if (header === undefined) return undefined;
  const addAt = keyword(header.rest, 0, "add");
  if (addAt === undefined) return undefined;
  const constraintAt = keyword(header.rest, addAt, "constraint");
  if (constraintAt === undefined) return undefined;
  const name = readIdent(header.rest, constraintAt);
  if (name === undefined) return undefined;
  return { schema: header.schema, table: header.table, name: name.value };
}

function parseValidate(sql: string): ConstraintRef | undefined {
  const header = alterTable(sql);
  if (header === undefined) return undefined;
  const validateAt = keyword(header.rest, 0, "validate");
  if (validateAt === undefined) return undefined;
  const constraintAt = keyword(header.rest, validateAt, "constraint");
  if (constraintAt === undefined) return undefined;
  const name = readIdent(header.rest, constraintAt);
  if (name === undefined) return undefined;
  if (skipSpace(header.rest, name.next) < header.rest.length) return undefined;
  return { schema: header.schema, table: header.table, name: name.value };
}

function parseAddEnum(sql: string): { schema?: string; name: string; label: string } | undefined {
  const text = sql.trim().replace(/;\s*$/, "");
  let cursor = keyword(text, 0, "alter");
  if (cursor === undefined) return undefined;
  cursor = keyword(text, cursor, "type");
  if (cursor === undefined) return undefined;
  const typeName = readQualified(text, cursor);
  if (typeName === undefined) return undefined;
  cursor = keyword(text, typeName.next, "add");
  if (cursor === undefined) return undefined;
  cursor = keyword(text, cursor, "value");
  if (cursor === undefined) return undefined;
  const label = readLiteral(text, cursor);
  if (label === undefined) return undefined;
  return {
    ...(typeName.schema !== undefined ? { schema: typeName.schema } : {}),
    name: typeName.name,
    label: label.value,
  };
}

function constraintBody(sql: string): string | undefined {
  const header = alterTable(sql);
  if (header === undefined) return undefined;
  const addAt = keyword(header.rest, 0, "add");
  if (addAt === undefined) return undefined;
  const constraintAt = keyword(header.rest, addAt, "constraint");
  if (constraintAt === undefined) return undefined;
  const name = readIdent(header.rest, constraintAt);
  if (name === undefined) return undefined;
  const body = header.rest.slice(name.next).trim();
  return body.length === 0 ? undefined : body;
}

function canonicalConstraint(body: string): string | undefined {
  const folded = foldSql(body);
  if (folded === undefined) return undefined;
  // Folding removes the space between `)` and `NOT VALID`.
  const notValid = / ?not valid$/.test(folded);
  const core = notValid ? folded.replace(/ ?not valid$/, "").trim() : folded;
  const suffix = notValid ? " not valid" : "";
  const check = /^check\((.*)\)$/.exec(core);
  if (check !== null) {
    return `check((${unwrap(check[1] ?? "")}))${suffix}`;
  }
  if (
    core.startsWith("primary key(") ||
    core.startsWith("unique(") ||
    core.startsWith("unique nulls not distinct(") ||
    core.startsWith("foreign key(")
  ) {
    return `${core}${suffix}`;
  }
  return undefined;
}

function foldSql(text: string): string | undefined {
  if (text.includes("::")) return undefined;
  const folded = text
    .replace(/"((?:[^"]|"")*)"/g, (_match, raw: string) => raw.replaceAll('""', '"'))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)\s*/g, ")")
    .replace(/,\s*/g, ",");
  return folded;
}

function unwrap(expr: string): string {
  let current = expr.trim();
  while (current.startsWith("(") && current.endsWith(")") && wrapped(current)) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

function wrapped(text: string): boolean {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index === text.length - 1;
    }
  }
  return false;
}

function simpleColumns(inner: string): string | undefined {
  const parts = splitCommas(inner);
  if (parts.length === 0) return undefined;
  const rendered: string[] = [];
  for (const part of parts) {
    const column = simpleColumn(part.trim());
    if (column === undefined) return undefined;
    rendered.push(column);
  }
  return rendered.join(", ");
}

function simpleColumn(part: string): string | undefined {
  const ident = readIdent(part, 0);
  if (ident === undefined) return undefined;
  let cursor = ident.next;
  let desc = false;
  const ascAt = keyword(part, cursor, "asc");
  const descAt = keyword(part, cursor, "desc");
  if (ascAt !== undefined) cursor = ascAt;
  if (descAt !== undefined) {
    desc = true;
    cursor = descAt;
  }
  let nullsFirst = false;
  const nullsAt = keyword(part, cursor, "nulls");
  if (nullsAt !== undefined) {
    const firstAt = keyword(part, nullsAt, "first");
    const lastAt = keyword(part, nullsAt, "last");
    if (firstAt !== undefined) {
      nullsFirst = true;
      cursor = firstAt;
    } else if (lastAt !== undefined) cursor = lastAt;
    else return undefined;
  }
  if (skipSpace(part, cursor) < part.length) return undefined;
  let text = ident.value;
  if (desc) text += " desc";
  if (nullsFirst) text += " nulls first";
  return text;
}

function splitCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function alterTable(sql: string): { schema?: string; table: string; rest: string } | undefined {
  const text = sql.trim().replace(/;\s*$/, "");
  let cursor = keyword(text, 0, "alter");
  if (cursor === undefined) return undefined;
  cursor = keyword(text, cursor, "table");
  if (cursor === undefined) return undefined;
  const onlyAt = keyword(text, cursor, "only");
  if (onlyAt !== undefined) cursor = onlyAt;
  const ifAt = keyword(text, cursor, "if");
  if (ifAt !== undefined) {
    const existsAt = keyword(text, ifAt, "exists");
    if (existsAt === undefined) return undefined;
    cursor = existsAt;
  }
  const table = readQualified(text, cursor);
  if (table === undefined) return undefined;
  return {
    ...(table.schema !== undefined ? { schema: table.schema } : {}),
    table: table.name,
    rest: text.slice(table.next),
  };
}

function qualifiedName(schema: string | undefined, name: string): string {
  const quoted = quoteIdent(name);
  return schema === undefined ? quoted : `${quoteIdent(schema)}.${quoted}`;
}

/**
 * Advice when this index is still building or the drop failed.
 *
 * The statement is its own sentence. A semicolon is not that period.
 *
 * @param label - Quoted index, schema-qualified when the table is
 * @returns The fix
 */
function indexRepair(label: string): string {
  return `DROP INDEX CONCURRENTLY ${label}. Then run apply again. Finished steps are not repeated.`;
}

/**
 * Case-insensitive match for an unquoted index name after `CONCURRENTLY`.
 *
 * The table name is not part of the pattern. Another session building a
 * different index on the same table does not match.
 *
 * @param name - Folded or preserved index name
 * @returns A POSIX regular expression
 */
function bareIndexBuild(name: string): string {
  return `${indexBuildLead()}${regexToken(name)}([^[:alnum:]_$]|$)`;
}

/**
 * Case-sensitive match for the quoted spelling of this index.
 *
 * @param name - Index name
 * @returns A POSIX regular expression
 */
function quotedIndexBuild(name: string): string {
  return `${indexBuildLead()}${regexToken(quoteIdent(name))}([^[:alnum:]_$]|$)`;
}

function indexBuildLead(): string {
  return "create[[:space:]]+(unique[[:space:]]+)?index[[:space:]]+concurrently[[:space:]]+(if[[:space:]]+not[[:space:]]+exists[[:space:]]+)?";
}

function regexToken(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keyword(text: string, index: number, word: string): number | undefined {
  const start = skipSpace(text, index);
  if (text.slice(start, start + word.length).toLowerCase() !== word) return undefined;
  const after = text[start + word.length];
  if (after !== undefined && /[A-Za-z0-9_$]/.test(after)) return undefined;
  return start + word.length;
}

function readQualified(
  text: string,
  index: number,
): { schema?: string; name: string; next: number } | undefined {
  const first = readIdent(text, index);
  if (first === undefined) return undefined;
  const dot = skipSpace(text, first.next);
  if (text[dot] !== ".") return { name: first.value, next: first.next };
  const second = readIdent(text, dot + 1);
  if (second === undefined) return undefined;
  return { schema: first.value, name: second.value, next: second.next };
}

function readIdent(text: string, index: number): { value: string; next: number } | undefined {
  const start = skipSpace(text, index);
  const char = text[start];
  if (char === undefined) return undefined;
  if (char === '"') {
    let value = "";
    for (let cursor = start + 1; cursor < text.length; cursor += 1) {
      const current = text[cursor];
      if (current === '"') {
        if (text[cursor + 1] === '"') {
          value += '"';
          cursor += 1;
          continue;
        }
        return { value, next: cursor + 1 };
      }
      value += current ?? "";
    }
    return undefined;
  }
  const match = /^[A-Za-z_][\w$]*/.exec(text.slice(start));
  if (match === null) return undefined;
  return { value: match[0].toLowerCase(), next: start + match[0].length };
}

function readParen(text: string, index: number): { inner: string; next: number } | undefined {
  const start = skipSpace(text, index);
  if (text[start] !== "(") return undefined;
  let depth = 0;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(start + 1, cursor), next: cursor + 1 };
    } else if (char === "'") {
      const literal = readLiteral(text, cursor);
      if (literal === undefined) return undefined;
      cursor = literal.next - 1;
    }
  }
  return undefined;
}

function readLiteral(text: string, index: number): { value: string; next: number } | undefined {
  const start = skipSpace(text, index);
  if (text[start] !== "'") return undefined;
  let value = "";
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    const current = text[cursor];
    if (current === "'") {
      if (text[cursor + 1] === "'") {
        value += "'";
        cursor += 1;
        continue;
      }
      return { value, next: cursor + 1 };
    }
    value += current ?? "";
  }
  return undefined;
}

function skipSpace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function wireTrue(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === "1";
}

function wireFalse(value: unknown): boolean {
  return value === false || value === "f" || value === "false" || value === "0";
}
