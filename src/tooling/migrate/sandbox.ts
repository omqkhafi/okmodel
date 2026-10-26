/**
 * Replays `okm migrate check` inside one transaction and rolls it back.
 *
 * The scratch schema is created in that transaction. Nothing here updates a
 * system catalog or a real ACL. A step that cannot run in a transaction is
 * rewritten to the transactional form, or skipped and named.
 */

import postgres, { type Sql } from "postgres";

import { watchReserved } from "../../adapters/pg/postgres-extra.js";
import { catalog } from "../../contracts/catalog/build.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import { isConnectionLost } from "../../contracts/connection.js";
import type { DriverConnection, ExecuteResult, WireValue } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { introspectSchema } from "../../dialects/pg/introspect.js";
import { roleExists } from "../../dialects/pg/role/check.js";
import { changesRole, createdRoleName, createRoleOnce } from "../../dialects/pg/role/sql.js";
import { migrationJournalGrants } from "./managed.js";
import { sealViews } from "../../dialects/pg/view/scratch.js";
import { ensureMigrationTables } from "./apply.js";
import type { MigrateConfig } from "./config.js";
import { catalogQuery, managedRoleOptions, sealStoredChecks, sealTriggerWhens } from "./drift.js";
import { assertUuidV7Available } from "./engine.js";
import {
  ensureExtensionSchemaSql,
  extensionStatement,
  type ExtensionStatement,
} from "./extensions.js";
import { finishQuiet, sessionFailure } from "./lost.js";
import { lintReprints, type Finding } from "./lint.js";
import { planMigration, type MigrationPlan, type PlanStep } from "./plan.js";
import { driverUrl } from "./driver-url.js";
import { probeStableBackend } from "./pooler-probe.js";
import {
  assumeRole,
  assertSchemaUsageLanded,
  grantSchema,
  ownSchema,
  stepFailureFix,
} from "./runner.js";
import { snapshotDifference } from "./snapshot.js";
import { replaceSchemaName, sqlStatements } from "./sql-lex.js";

/** One migration the check replays. */
export type CheckMigration = {
  readonly id: string;
  readonly catalog: Catalog;
  readonly steps: readonly PlanStep[];
};

/** The first migration whose replay does not match its catalog. */
export type ReplayStop = {
  readonly index: number;
  readonly back: MigrationPlan;
};

/** Replay result. `skips` are statements check did not execute. */
export type ReplayOutcome = {
  readonly skips: readonly string[];
  readonly reprints: readonly Finding[];
  readonly stop?: ReplayStop;
};

/**
 * An extension installed outside the scratch schema.
 *
 * The replay never alters it. Create, drop, and alter statements for it are
 * tracked here, and the catalog read after each migration is corrected from
 * this record. A step that ends the transaction cannot make a change to the
 * real extension permanent, because none was made.
 */
type Hosted = {
  readonly home: string;
  present: boolean;
  schema: string;
  version: string;
};

type Session = {
  setRole?: string;
  readonly hosted: Map<string, Hosted | null>;
  /** Extensions this replay creates. Recorded after the statement runs. */
  readonly creating: { name: string; schema: string }[];
};

function newSession(): Session {
  return { hosted: new Map(), creating: [] };
}

/**
 * Replays `history` in one transaction and rolls it back.
 *
 * @param url - Target URL
 * @param scratch - Schema created inside the transaction
 * @param config - Roles and timeouts
 * @param allowPooler - Passed through to the pooler guard
 * @param history - Migrations in apply order
 * @returns Skipped statements, and the first catalog mismatch
 */
export async function replayCheckHistory(
  url: string,
  scratch: string,
  config: MigrateConfig,
  allowPooler: boolean,
  history: readonly CheckMigration[],
): Promise<ReplayOutcome> {
  const skips: string[] = [];
  const reprints: Finding[] = [];
  let stop: ReplayStop | undefined;
  const logical = config.namespace ?? "public";
  await inCheckTransaction(url, scratch, config, allowPooler, async (sql) => {
    const connection = driverOf(sql);
    await assertUuidV7Available(connection, history);
    const session = newSession();
    for (let index = 0; index < history.length; index += 1) {
      const migration = history[index];
      if (migration === undefined) continue;
      await replayMigration(sql, connection, scratch, config, migration, session, skips);
      await restoreSession(sql, session);
      const runner = catalogQuery(sql);
      const live = await introspectReplay(sql, scratch, logical, config, session);
      for (const item of lintReprints(migration.catalog, live, migration.steps)) {
        reprints.push({ ...item, place: `${migration.id} ${item.place}` });
      }
      // Seal views, checks, and btree index expressions the way this server
      // stores them so a non-canonical author spelling is not OKM1547 when
      // generate is empty (B-37, D128). The live catalog is sealed too: author
      // SQL stores the first printer pass, and that pass is not always stable.
      const sealed = await sealTriggerWhens(
        runner,
        await sealStoredChecks(runner, await sealViews(runner, migration.catalog)),
      );
      const back = planMigration({
        before: await sealStoredChecks(runner, live),
        after: sealed,
        name: migration.id,
      });
      if (back.steps.length === 0) continue;
      stop = { index, back };
      return;
    }
  });
  return stop === undefined ? { skips, reprints } : { skips, reprints, stop };
}

/**
 * Compares a head snapshot with a full replay. Both run in rolled-back transactions.
 *
 * @param url - Target URL
 * @param provided - Scratch schema for the snapshot
 * @param replayed - Scratch schema for the history
 * @param config - Roles and timeouts
 * @param allowPooler - Passed through to the pooler guard
 * @param history - Migrations in apply order
 * @returns The difference, or `undefined` when the catalogs match
 */
export async function proveCheckSnapshot(
  url: string,
  provided: string,
  replayed: string,
  config: MigrateConfig,
  allowPooler: boolean,
  history: readonly CheckMigration[],
): Promise<string | undefined> {
  const head = history.at(-1);
  if (head === undefined) return undefined;
  const logical = config.namespace ?? "public";
  const installed = await inCheckTransaction(url, provided, config, allowPooler, async (sql) => {
    const connection = driverOf(sql);
    const session = newSession();
    const planned = planMigration({
      before: catalog([]),
      after: head.catalog,
      schema: provided,
      name: "provision",
    });
    await assertUuidV7Available(connection, [{ id: head.id, steps: planned.steps }]);
    await runSteps(
      sql,
      connection,
      provided,
      config.roles?.migration,
      {
        id: "snapshot",
        catalog: head.catalog,
        steps: retargetSteps(planned.steps, provided, logical),
      },
      session,
      [],
    );
    await restoreSession(sql, session);
    return introspectReplay(sql, provided, logical, config, session);
  });
  const again = await inCheckTransaction(url, replayed, config, allowPooler, async (sql) => {
    const connection = driverOf(sql);
    await assertUuidV7Available(connection, history);
    const session = newSession();
    for (const migration of history) {
      await replayMigration(sql, connection, replayed, config, migration, session, []);
    }
    await restoreSession(sql, session);
    return introspectReplay(sql, replayed, logical, config, session);
  });
  return snapshotDifference(installed, again);
}

/**
 * Rewrites the catalog schema to the scratch schema.
 *
 * `source` defaults to `public`. A foreign key aimed at another schema is
 * left in place. `CREATE EXTENSION … SCHEMA` names the schema without a
 * trailing dot, so that clause is retargeted too. Only identifiers change:
 * the same text inside a string literal or a comment stays as written.
 *
 * @param steps - Plan steps
 * @param schema - Scratch schema
 * @param source - Schema the statements currently name
 * @returns The same steps, aimed at `schema`
 */
export function retargetSteps(
  steps: readonly PlanStep[],
  schema: string,
  source = "public",
): readonly PlanStep[] {
  return steps.map((step) => ({
    ...step,
    sql: replaceSchemaName(step.sql, source, schema),
    ...(step.backfill === undefined
      ? {}
      : {
          backfill: {
            ...step.backfill,
            table: replaceSchemaName(step.backfill.table, source, schema),
          },
        }),
  }));
}

async function inCheckTransaction<T>(
  url: string,
  scratch: string,
  config: MigrateConfig,
  allowPooler: boolean,
  run: (sql: Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(driverUrl(url), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
  const reserved = await sql.reserve();
  const lost = { on: false, stop: (): void => undefined };
  watchReserved(reserved, lost);
  refuseWhenLost(reserved, lost);
  let open = false;
  let failure: unknown;
  let value: T | undefined;
  let created = false;
  let sawCommit = false;
  // Set when ROLLBACK landed and the transaction id never changed. The schema
  // was created in that transaction, so nothing remains to drop.
  let rolledBack = false;
  let xid = "";
  try {
    await probeStableBackend(
      url,
      async () => {
        const rows = await reserved.unsafe("select pg_backend_pid()::text as pid");
        const pid = cell(rows[0], "pid");
        return pid ?? "";
      },
      allowPooler,
    );
    await reserved.unsafe("begin");
    open = true;
    xid = await readXid(reserved);
    await reserved.unsafe(`create schema ${quoteIdent(scratch)}`);
    created = true;
    await reserved.unsafe(`set local search_path to ${quoteIdent(scratch)}`);
    await setLocalTimeout(reserved, "lock_timeout", config.timeouts?.lock);
    await setLocalTimeout(reserved, "statement_timeout", config.timeouts?.statement);
    await ownScratch(reserved, scratch, config.roles?.migration);
    await ensureMigrationTables((text) => reserved.unsafe(text));
    value = await run(reserved);
    const after = await readXid(reserved).catch((error: unknown) => {
      if (isConnectionLost(error)) lost.on = true;
      return undefined;
    });
    if (!lost.on && after !== xid) {
      sawCommit = true;
      throw xidChanged();
    }
    if (!lost.on) {
      await reserved.unsafe("rollback");
      rolledBack = true;
    }
    open = false;
  } catch (error) {
    if (isConnectionLost(error)) lost.on = true;
    failure = error;
  } finally {
    if (open && !lost.on && !sawCommit) {
      const after = await readXid(reserved).catch((error: unknown) => {
        if (isConnectionLost(error)) lost.on = true;
        return undefined;
      });
      if (!lost.on && after !== xid) sawCommit = true;
    }
    if (open && !lost.on) {
      await reserved.unsafe("rollback").catch((error: unknown) => {
        if (isConnectionLost(error)) lost.on = true;
      });
      if (!lost.on && !sawCommit) rolledBack = true;
    }
    if (!lost.on) await reserved.unsafe("reset role").catch(() => undefined);
    if (!lost.on) {
      try {
        reserved.release();
      } catch {
        lost.on = true;
      }
    }
    await finishQuiet(() => sql.end({ timeout: 5 }));
  }
  if (!created || rolledBack) {
    if (failure !== undefined) throw sessionFailure(failure) ?? failure;
    return value as T;
  }
  const left = await dropScratch(url, scratch);
  if (left !== undefined) {
    const note = `Scratch schema ${left} is still present.`;
    failure =
      failure === undefined
        ? new OkmError("unavailable", note, { kind: "unavailable", fix: UNAVAILABLE_FIX })
        : noteOn(failure, note);
  }
  if (failure !== undefined) throw sessionFailure(failure) ?? failure;
  return value as T;
}

const UNAVAILABLE_FIX = {
  summary:
    "The connection to Postgres closed. Run the command again when the database is reachable.",
};

/**
 * Stops a later statement from writing after the reserved socket has closed.
 *
 * `watchReserved` records the close. This wrapper reads that flag before
 * `socket.write`, including the `setImmediate` write postgres.js queues.
 *
 * @param sql - Reserved connection
 * @param lost - Set when that socket closes
 */
function refuseWhenLost(sql: Sql, lost: { on: boolean }): void {
  const unsafe = sql.unsafe.bind(sql);
  sql.unsafe = ((text: string, params?: unknown, options?: object) => {
    if (lost.on) return Promise.reject(closedError());
    const pending =
      options !== undefined
        ? unsafe(text, params as never, options as never)
        : params !== undefined
          ? unsafe(text, params as never)
          : unsafe(text);
    return pending.catch((error: unknown) => {
      if (isConnectionLost(error)) lost.on = true;
      throw error;
    });
  }) as Sql["unsafe"];
}

function closedError(): Error {
  return Object.assign(new Error("CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" });
}

/**
 * Drops a scratch schema on a new connection.
 *
 * Called only when the replay did not roll back. A killed backend has already
 * aborted an uncommitted schema. A step that committed can leave it behind.
 *
 * @param url - Target URL
 * @param scratch - Schema name
 * @returns The name when it is still present, or when the drop could not be confirmed
 */
async function dropScratch(url: string, scratch: string): Promise<string | undefined> {
  const sql = postgres(driverUrl(url), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    await sql.unsafe(`drop schema if exists ${quoteIdent(scratch)} cascade`);
    const rows = await sql<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname = ${scratch}
    `;
    return rows.length > 0 ? scratch : undefined;
  } catch {
    return scratch;
  } finally {
    await finishQuiet(() => sql.end({ timeout: 5 }));
  }
}

function noteOn(error: unknown, note: string): unknown {
  if (error instanceof Error) {
    return new OkmError("unavailable", `${error.message} ${note}`, {
      kind: "unavailable",
      cause: error,
      fix: UNAVAILABLE_FIX,
    });
  }
  return new OkmError("unavailable", note, { kind: "unavailable", fix: UNAVAILABLE_FIX });
}

async function restoreSession(sql: Sql, session: Session): Promise<void> {
  if (session.setRole === undefined) return;
  await sql.unsafe("reset role");
  delete session.setRole;
}

async function replayMigration(
  sql: Sql,
  connection: DriverConnection,
  scratch: string,
  config: MigrateConfig,
  migration: CheckMigration,
  session: Session,
  skips: string[],
): Promise<void> {
  await runSteps(
    sql,
    connection,
    scratch,
    config.roles?.migration,
    { ...migration, steps: retargetSteps(migration.steps, scratch, config.namespace ?? "public") },
    session,
    skips,
  );
}

async function runSteps(
  sql: Sql,
  connection: DriverConnection,
  scratch: string,
  migrationRole: string | undefined,
  migration: CheckMigration,
  session: Session,
  skips: string[],
): Promise<void> {
  for (let index = 0; index < migration.steps.length; index += 1) {
    const step = migration.steps[index];
    if (step === undefined) continue;
    const prepared = prepareCheckSql(step.sql);
    if (prepared.skip !== undefined) {
      skips.push(`${migration.id} step ${String(index + 1)}: ${prepared.skip}`);
    }
    if (prepared.sql.length === 0) continue;
    try {
      if (
        migrationRole !== undefined &&
        !changesRole(step.sql) &&
        session.setRole !== migrationRole &&
        (await roleExists(connection, migrationRole))
      ) {
        await assumeRole(connection, migrationRole, session);
      }
      const notes: string[] = [];
      const replaySql = await replayExtensions(sql, prepared.sql, scratch, session, notes);
      for (const note of notes) skips.push(`${migration.id} step ${String(index + 1)}: ${note}`);
      const created = createdRoleName(step.sql);
      const existed = created !== undefined && (await roleExists(connection, created));
      if (step.backfill !== undefined) {
        await sql.unsafe(prepared.sql, [null, null]);
      } else if (created === undefined) {
        if (replaySql.length > 0) {
          await sql.unsafe(replaySql);
          await assertSchemaUsageLanded(connection, replaySql);
          await rememberCreated(sql, scratch, session);
        }
      } else if (!existed) {
        await sql.unsafe(createRoleOnce(prepared.sql.replace(/;\s*$/, "")));
      }
      if (created !== undefined && created === migrationRole && !existed) {
        await grantSchema(connection, scratch, created);
        await ownSchema(connection, scratch, created);
        for (const grant of migrationJournalGrants(created)) await connection.execute(grant);
      }
    } catch (error) {
      throw failStep(migration.id, index, error);
    }
  }
  if (
    migrationRole !== undefined &&
    session.setRole !== migrationRole &&
    (await roleExists(connection, migrationRole))
  ) {
    await assumeRole(connection, migrationRole, session);
  }
}

/**
 * Replays extension statements without touching an installed extension.
 *
 * Extensions are database-wide, so a replay after apply would fail with
 * "already exists". A statement about an extension that is installed outside
 * the scratch schema is not executed. It updates the {@link Hosted} record
 * instead, and the scratch schema reads that extension through `search_path`.
 * Any other extension statement runs in the scratch transaction.
 *
 * @param sql - Check connection
 * @param text - Statements for one step, after transactional rewrites
 * @param scratch - Scratch schema
 * @param session - Extensions tracked so far
 * @param notes - Receives a note for each statement that is not replayed
 * @returns The statements still to run
 */
async function replayExtensions(
  sql: Sql,
  text: string,
  scratch: string,
  session: Session,
  notes: string[],
): Promise<string> {
  const parts = sqlStatements(text);
  const source = parts.length === 0 ? [text] : parts;
  const kept: string[] = [];
  let moved = false;
  for (const statement of source) {
    const parsed = extensionStatement(statement);
    // A hosted DROP EXTENSION is checked before this step runs. Statements
    // earlier in the same step, such as the column drop that removed the
    // last dependent, have to land first.
    if (
      parsed?.kind === "drop" &&
      kept.length > 0 &&
      (await dropsHostedExtension(sql, parsed, scratch, session))
    ) {
      await sql.unsafe(`${kept.join(";\n")};`);
      kept.length = 0;
    }
    const remaining =
      parsed === undefined
        ? statement
        : await replayExtension(sql, parsed, statement, scratch, session, notes);
    if (remaining !== statement) moved = true;
    const trimmed = remaining.trim().replace(/;\s*$/, "");
    if (trimmed.length > 0) kept.push(trimmed);
  }
  if (moved) await placeHosted(sql, scratch, session);
  return kept.length === 0 ? "" : `${kept.join(";\n")};`;
}

async function dropsHostedExtension(
  sql: Sql,
  parsed: Extract<ExtensionStatement, { kind: "drop" }>,
  scratch: string,
  session: Session,
): Promise<boolean> {
  for (const name of parsed.names) {
    if ((await hostedExtension(sql, session, name, scratch)) !== undefined) return true;
  }
  return false;
}

async function replayExtension(
  sql: Sql,
  parsed: ExtensionStatement,
  statement: string,
  scratch: string,
  session: Session,
  notes: string[],
): Promise<string> {
  if (parsed.kind === "drop") {
    const rest: string[] = [];
    for (const name of parsed.names) {
      const host = await hostedExtension(sql, session, name, scratch);
      if (host === undefined) {
        rest.push(name);
        continue;
      }
      if (parsed.cascade) {
        notes.push(`DROP EXTENSION ${name} CASCADE is not replayed on an installed extension`);
      } else if (host.present) {
        await assertNoDependents(sql, name, scratch);
      }
      host.present = false;
    }
    if (rest.length === parsed.names.length) return statement;
    if (rest.length === 0) return "";
    const tail = parsed.cascade ? " cascade" : "";
    return `drop extension ${parsed.ifExists ? "if exists " : ""}${rest.map(quoteIdent).join(", ")}${tail}`;
  }
  const host = await hostedExtension(sql, session, parsed.name, scratch);
  if (host === undefined) {
    if (parsed.kind !== "create") return statement;
    const schema = parsed.schema ?? scratch;
    session.creating.push({ name: parsed.name, schema });
    const ensure = ensureExtensionSchemaSql(statement, scratch);
    return ensure === undefined ? statement : `${ensure};\n${statement}`;
  }
  if (parsed.kind === "create") {
    host.present = true;
    host.schema = parsed.schema ?? scratch;
  } else if (parsed.kind === "set-schema") {
    host.schema = parsed.schema;
  } else if (parsed.kind === "update") {
    host.version = parsed.version;
  } else {
    notes.push(`ALTER EXTENSION ${parsed.name} is not replayed on an installed extension`);
  }
  return "";
}

/**
 * Looks up an extension once. It is hosted when it is installed outside the scratch schema.
 */
async function hostedExtension(
  sql: Sql,
  session: Session,
  name: string,
  scratch: string,
): Promise<Hosted | undefined> {
  const known = session.hosted.get(name);
  if (known !== undefined) return known ?? undefined;
  const rows = await sql.unsafe(
    `select n.nspname as schema, e.extversion as version
     from pg_extension e
     join pg_namespace n on n.oid = e.extnamespace
     where e.extname = $1`,
    [name],
  );
  const home = cell(rows[0], "schema");
  const found: Hosted | null =
    home === undefined || home === scratch
      ? null
      : { home, present: true, schema: home, version: cell(rows[0], "version") ?? "" };
  session.hosted.set(name, found);
  return found ?? undefined;
}

/**
 * Refuses `DROP EXTENSION` while a scratch object still uses a member of it.
 *
 * This is the check Postgres would make if the extension were in the scratch
 * schema. A column, an index operator class, a default, a constraint, a
 * function, or a type in the scratch schema counts.
 */
async function assertNoDependents(sql: Sql, name: string, scratch: string): Promise<void> {
  const rows = await sql.unsafe(
    `select 1
     from pg_depend d
     join pg_depend m on m.classid = d.refclassid and m.objid = d.refobjid
       and m.refclassid = 'pg_extension'::regclass and m.deptype = 'e'
     join pg_extension e on e.oid = m.refobjid and e.extname = $1
     where d.deptype in ('n', 'a')
       and case d.classid
         when 'pg_class'::regclass
           then (select c.relnamespace from pg_class c where c.oid = d.objid)
         when 'pg_attrdef'::regclass
           then (select c.relnamespace from pg_attrdef a join pg_class c on c.oid = a.adrelid
                 where a.oid = d.objid)
         when 'pg_constraint'::regclass
           then (select c.relnamespace from pg_constraint k join pg_class c on c.oid = k.conrelid
                 where k.oid = d.objid)
         when 'pg_proc'::regclass
           then (select p.pronamespace from pg_proc p where p.oid = d.objid)
         when 'pg_type'::regclass
           then (select t.typnamespace from pg_type t where t.oid = d.objid)
       end = (select oid from pg_namespace where nspname = $2)
     limit 1`,
    [name, scratch],
  );
  if (rows.length > 0) {
    throw new Error(`cannot drop extension ${name} because other objects depend on it`);
  }
}

/**
 * Records an extension this replay just created so introspection sees it.
 *
 * The extension is database-wide. Its schema may be the scratch schema or a
 * declared schema such as `extensions`. The declared schema is what the
 * catalog comparison uses. The installed schema goes on `search_path`.
 */
async function rememberCreated(sql: Sql, scratch: string, session: Session): Promise<void> {
  if (session.creating.length === 0) return;
  for (const created of session.creating) {
    const rows = await sql.unsafe(
      `select n.nspname as schema, e.extversion as version
       from pg_extension e
       join pg_namespace n on n.oid = e.extnamespace
       where e.extname = $1`,
      [created.name],
    );
    const home = cell(rows[0], "schema") ?? created.schema;
    session.hosted.set(created.name, {
      home,
      present: true,
      schema: created.schema,
      version: cell(rows[0], "version") ?? "",
    });
  }
  session.creating.length = 0;
  await placeHosted(sql, scratch, session);
}

/** Puts the schemas of the extensions still present after the scratch schema on `search_path`. */
async function placeHosted(sql: Sql, scratch: string, session: Session): Promise<void> {
  const homes = new Set<string>();
  for (const host of session.hosted.values()) {
    if (host !== null && host.present) homes.add(host.home);
  }
  const path = [scratch, ...homes].map((name) => quoteIdent(name)).join(", ");
  await sql.unsafe(`set local search_path to ${path}`);
}

/**
 * Reads the scratch schema as the catalog a migration stores.
 *
 * Introspection reads `extnamespace`, which is the scratch name for this
 * replay. The stored catalog names `public` (or the configured namespace).
 * An extension that is installed outside the scratch schema is read with the
 * schema and version the replay gave it.
 *
 * @param sql - Check connection
 * @param concrete - Scratch schema name
 * @param logical - Namespace the migration catalog stores
 * @param config - Roles
 * @param session - Extensions the replay tracks
 * @returns The catalog of the scratch schema
 */
async function introspectReplay(
  sql: Sql,
  concrete: string,
  logical: string,
  config: MigrateConfig,
  session: Session,
): Promise<Catalog> {
  const hosted = new Map<string, Hosted>();
  for (const [name, host] of session.hosted) {
    if (host !== null && host.present) hosted.set(name, host);
  }
  const source = await introspectSchema(catalogQuery(sql), concrete, logical, {
    ...managedRoleOptions(config.roles),
    hostedExtensions: [...hosted.keys()],
  });
  let changed = false;
  const objects = source.objects.map((object) => {
    if (object.kind !== "extension") return object;
    const host = hosted.get(object.identity.name);
    const schema = host?.schema ?? object.definition.schema;
    const mapped = schema === concrete ? logical : schema;
    const version = host?.version ?? object.definition.version;
    if (mapped === object.definition.schema && version === object.definition.version) {
      return object;
    }
    changed = true;
    return {
      ...object,
      definition: {
        ...object.definition,
        schema: mapped,
        ...(version !== undefined && version.length > 0 ? { version } : {}),
      },
    };
  });
  return changed ? { version: source.version, objects } : source;
}

function prepareCheckSql(sql: string): { readonly sql: string; readonly skip?: string } {
  const parts = sqlStatements(sql);
  const source = parts.length === 0 ? [sql] : parts;
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const statement of source) {
    const kind = skipKind(statement);
    if (kind !== undefined) {
      skipped.push(kind);
      continue;
    }
    kept.push(rewriteConcurrent(statement));
  }
  return {
    sql: kept.length === 0 ? "" : `${kept.join(";\n")};`,
    ...(skipped.length > 0 ? { skip: skipped.join(", ") } : {}),
  };
}

function skipKind(sql: string): string | undefined {
  const text = sql.trim().replace(/\s+/g, " ").toLowerCase();
  if (text.startsWith("vacuum")) return "VACUUM is not run inside the check transaction";
  if (/^(?:create|drop)\s+database\b/.test(text)) {
    return "CREATE or DROP DATABASE is not run inside the check transaction";
  }
  if (text.startsWith("alter system"))
    return "ALTER SYSTEM is not run inside the check transaction";
  return undefined;
}

function rewriteConcurrent(sql: string): string {
  const text = sql.trim().replace(/\s+/g, " ").toLowerCase();
  if (
    /^(?:create\s+(?:unique\s+)?index|drop\s+index|reindex|refresh\s+materialized\s+view)\b/.test(
      text,
    )
  ) {
    return sql.replace(/\s+concurrently\b/gi, "");
  }
  return sql;
}

async function ownScratch(sql: Sql, scratch: string, role: string | undefined): Promise<void> {
  if (role === undefined) return;
  const exists = await sql.unsafe(
    "select exists (select 1 from pg_roles where rolname = $1) as ok",
    [role],
  );
  const present = cell(exists[0], "ok");
  if (present === "t" || present === "true") {
    await sql.unsafe(`alter schema ${quoteIdent(scratch)} owner to ${quoteIdent(role)}`);
  }
}

async function setLocalTimeout(sql: Sql, name: string, ms: number | undefined): Promise<void> {
  if (ms === undefined) return;
  await sql.unsafe("select set_config($1, $2, true)", [name, String(ms)]);
}

async function readXid(sql: Sql): Promise<string> {
  const rows = await sql.unsafe("select pg_current_xact_id()::text as xid");
  return cell(rows[0], "xid") ?? "";
}

function cell(row: unknown, key: string): string | undefined {
  if (typeof row !== "object" || row === null || !(key in row)) return undefined;
  const value: unknown = Reflect.get(row, key);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

function xidChanged(): OkmError {
  return new OkmError(
    "invalid",
    "okm migrate check left its transaction. A step committed, so the replay did not stay in one transaction.",
    {
      kind: "invalid",
      fix: {
        summary:
          "Remove COMMIT, ROLLBACK, and other transaction control from the step. The check always rolls the replay back.",
      },
    },
  );
}

function failStep(id: string, index: number, error: unknown): OkmError {
  const lost = sessionFailure(error);
  if (lost !== undefined) {
    return new OkmError(
      lost.code,
      `Migration ${id} failed at step ${String(index + 1)}: ${lost.message}`,
      { kind: lost.kind, cause: error, fix: lost.fix },
    );
  }
  if (error instanceof OkmError) return error;
  const message = error instanceof Error ? error.message : "The step failed.";
  const owner = /must be owner of (extension|type)\b/i.test(message);
  return new OkmError(
    owner ? "OKM1814" : "invalid",
    `Migration ${id} failed at step ${String(index + 1)}: ${message}`,
    {
      cause: error,
      fix: stepFailureFix(error, "check"),
    },
  );
}

function driverOf(sql: Sql): DriverConnection {
  return {
    async execute(text, params): Promise<ExecuteResult> {
      const query =
        params === undefined || params.length === 0
          ? sql.unsafe(text)
          : sql.unsafe(text, [...params] as string[]);
      const rows = await query;
      const wire = Array.from(rows, (row) => cells(row));
      return { rows: wire, count: rows.count ?? wire.length, notices: [] };
    },
    batch() {
      return Promise.reject(new Error("okm migrate check does not batch."));
    },
    release() {
      return Promise.resolve();
    },
  };
}

function cells(row: unknown): WireValue[] {
  const values = Array.isArray(row) ? row : Object.values(row as Record<string, unknown>);
  return values.map((value: unknown) => {
    if (value === null || value === undefined) return null;
    if (value === true) return "t";
    if (value === false) return "f";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    return null;
  });
}
