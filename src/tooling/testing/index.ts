/**
 * `okmodel/testing`: a real database, factories, query counts, and the
 * isolation check (spec §20, D199).
 *
 * The database is never mocked. Pass a driver pool from `open()`.
 */

import type { Catalog } from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";
import type { DriverPool } from "../../contracts/driver.js";
import { renderCatalog } from "../../dialects/pg/ddl.js";
import { createClient } from "../../runtime/client.js";
import { dropAppliedCatalog } from "./cleanup.js";
import { testingObjectConflict } from "./conflict.js";
import type { Connected } from "../../runtime/types.js";
import { attachHost, bindFactories, type FactoryHost, type TableFactory } from "./factories.js";
import { readFacts, type TestingSchema } from "./facts.js";
import { isolation as runIsolation, type IsolationReport } from "./isolation.js";
import { rng } from "./random.js";
import { isTransactionControl, record } from "./record.js";

/** Options for {@link testing}. */
export type TestingOptions = {
  /**
   * A driver pool, or a promise of one.
   *
   * `open()` from `okmodel/pg/pglite` and `open({ url })` from
   * `okmodel/pg/postgresjs` both satisfy this.
   */
  readonly driver: DriverPool | Promise<DriverPool>;
  /**
   * Seed for factory generators.
   *
   * The default is `1`. The same seed replays the same values.
   */
  readonly seed?: number;
  /**
   * Apply the schema's catalog before connecting.
   *
   * The default is true, for an empty test database. `okm seed` passes false:
   * the target already has its schema.
   */
  readonly migrate?: boolean;
};

/**
 * What a factory definition may call.
 *
 * Re-exported so a seed file can name the argument.
 */
export type { FactoryContext, TableFactory } from "./factories.js";
export type { IsolationReport } from "./isolation.js";

/** Definitions passed to {@link Testing.factories}. */
export type FactoryDefinitions = {
  readonly [table: string]: (
    context: import("./factories.js").FactoryContext,
  ) => Readonly<Record<string, unknown>>;
};

/**
 * A connected test database.
 *
 * @typeParam S - Schema passed to {@link testing}
 */
export type Testing<S extends TestingSchema = TestingSchema> = {
  /** The client. `close` on the harness closes this pool. */
  readonly db: Connected<S>;
  /**
   * Builds factories for the named tables.
   *
   * @param definitions - One function per table
   * @returns `create`, `createMany`, and `with` for each table
   */
  factories<const D extends FactoryDefinitions>(
    definitions: D,
  ): { readonly [K in keyof D]: TableFactory };
  /**
   * Fails when `run` sends a different number of statements than `count`.
   *
   * Transaction control is not counted. The error lists the statements that were.
   *
   * @param count - Expected statements
   * @param run - The work to count
   */
  expectQueries(count: number, run: () => Promise<unknown>): Promise<void>;
  /**
   * Runs the cross-tenant check.
   *
   * @returns Checked tenant tables and views, and skipped global objects
   */
  isolation(): Promise<IsolationReport>;
  /**
   * Drops the objects this harness applied, then closes the client and the pool.
   *
   * `migrate: false` drops nothing. A drop the database rejects is reported
   * after the pool is closed, and a later failure does not replace it.
   */
  close(): Promise<void>;
};

/**
 * Opens `schema` on `driver` and returns the test harness.
 *
 * @typeParam S - Schema
 * @param schema - A `schema()` value
 * @param options - Driver, seed, and whether to apply the catalog
 * @returns The harness
 */
export async function testing<const S extends TestingSchema>(
  schema: S,
  options: TestingOptions,
): Promise<Testing<S>> {
  const seed = options.seed ?? 1;
  const pool = await options.driver;
  const applied = options.migrate !== false;
  if (applied) {
    await loadDeclaredExtensions(pool, schema.catalog);
    for (const statement of renderCatalog(schema.catalog, "public")) {
      if (statement.trim().length === 0) continue;
      try {
        await pool.execute(statement);
      } catch (error) {
        const conflict = harnessConflict(error, statement);
        if (conflict !== undefined) throw conflict;
        throw error;
      }
    }
    // Materialized views are created WITH NO DATA. A later refresh:
    // "concurrently" needs one plain populate first (B-34).
    await populateMaterializedViews(pool, schema.catalog);
  }
  const recording = record(pool);
  const db = createClient(schema, recording.pool, { ownsPool: true });
  await db.connected;
  const facts = new Map(readFacts(schema).map((item) => [item.name, item]));
  const host: FactoryHost = {
    schema,
    db: db as Connected<TestingSchema>,
    pool: recording.pool,
    facts,
    rng: rng(seed),
    cache: new Map(),
    created: new Map(),
    definitions: new Map(),
  };
  const harness: Testing<S> = {
    db,
    factories(definitions) {
      return bindFactories(host, definitions) as {
        readonly [K in keyof typeof definitions]: TableFactory;
      };
    },
    async expectQueries(count, run) {
      if (!Number.isInteger(count) || count < 0) {
        throw new OkmError(
          "invalid",
          `expectQueries needs a non-negative integer, got ${String(count)}.`,
          {
            fix: { summary: "Pass the number of statements the call should send." },
          },
        );
      }
      const from = recording.log.length;
      await run();
      const counted = recording.log.slice(from).filter((item) => !isTransactionControl(item.text));
      if (counted.length === count) return;
      const noun = count === 1 ? "query" : "queries";
      const text = counted.map((item) => item.text).join("\n");
      throw new OkmError(
        "invalid",
        `expected ${String(count)} ${noun}, ran ${String(counted.length)}\n${text}`,
        {
          fix: {
            summary: "The statements above were counted. Transaction control is not counted.",
          },
        },
      );
    },
    isolation: () => runIsolation(host),
    async close() {
      let dropError: OkmError | undefined;
      if (applied) {
        try {
          dropError = await dropAppliedCatalog(recording.pool, schema.catalog);
        } catch (error) {
          dropError = error instanceof OkmError ? error : OkmError.from(error);
        }
      }
      let closeError: unknown;
      try {
        await db.close();
      } catch (error) {
        closeError = error;
      }
      if (dropError !== undefined) throw dropError;
      if (closeError !== undefined) throw closeError;
    },
  };
  attachHost(harness, host);
  return harness;
}

/**
 * Turns a duplicate-table or duplicate-object failure into OKM1894.
 *
 * Other failures stay as the driver raised them. The name comes from the
 * statement the harness just sent.
 *
 * @param error - Rejection from `pool.execute`
 * @param statement - The catalog statement that failed
 * @returns The OKM error, or `undefined` when this is not that conflict
 */
function harnessConflict(error: unknown, statement: string): OkmError | undefined {
  const sqlstate = sqlstateOf(error);
  const object = createdObject(statement);
  if (sqlstate === "23505" && catalogRace(error)) {
    const name = object?.name ?? detailName(error);
    if (name === undefined) return undefined;
    const kind = object?.kind ?? (errorField(error, "table") === "pg_class" ? "table" : "type");
    return asConflict(kind, name);
  }
  if (sqlstate !== "42P07" && sqlstate !== "42710") return undefined;
  if (object === undefined) return undefined;
  return asConflict(object.kind, object.name);
}

function asConflict(kind: "table" | "extension" | "type", name: string): OkmError | undefined {
  try {
    testingObjectConflict(kind, name);
  } catch (conflict) {
    if (conflict instanceof OkmError) return conflict;
  }
  return undefined;
}

function catalogRace(error: unknown): boolean {
  const table = errorField(error, "table");
  const constraint = errorField(error, "constraint");
  return (
    table === "pg_type" ||
    table === "pg_class" ||
    constraint.startsWith("pg_type_") ||
    constraint.startsWith("pg_class_")
  );
}

function detailName(error: unknown): string | undefined {
  const match = /=\(([^,)]+)/.exec(errorField(error, "detail"));
  const name = match?.[1]?.trim();
  return name !== undefined && name.length > 0 ? name : undefined;
}

function errorField(error: unknown, key: string): string {
  if (typeof error !== "object" || error === null || !(key in error)) return "";
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function createdObject(
  statement: string,
): { readonly kind: "table" | "extension" | "type"; readonly name: string } | undefined {
  const text = statement.trimStart();
  const extension = /^create extension\s+/i.exec(text);
  if (extension !== null) {
    const name = readIdent(text.slice(extension[0].length));
    return name === undefined ? undefined : { kind: "extension", name: name.value };
  }
  const type = /^create type\s+/i.exec(text);
  if (type !== null) {
    const name = qualifiedIdent(text.slice(type[0].length));
    return name === undefined ? undefined : { kind: "type", name };
  }
  const table = /^create table\s+/i.exec(text);
  if (table === null) return undefined;
  const name = qualifiedIdent(text.slice(table[0].length));
  return name === undefined ? undefined : { kind: "table", name };
}

function qualifiedIdent(text: string): string | undefined {
  const first = readIdent(text);
  if (first === undefined) return undefined;
  const rest = text.slice(first.consumed);
  if (!rest.startsWith(".")) return first.value;
  const second = readIdent(rest.slice(1));
  return second?.value;
}

function readIdent(
  text: string,
): { readonly value: string; readonly consumed: number } | undefined {
  if (text.startsWith('"')) {
    let value = "";
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index];
      if (char !== '"') {
        value += char ?? "";
        continue;
      }
      if (text[index + 1] === '"') {
        value += '"';
        index += 1;
        continue;
      }
      return { value, consumed: index + 1 };
    }
    return undefined;
  }
  const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text);
  if (match === null) return undefined;
  return { value: match[0], consumed: match[0].length };
}

/**
 * Asks a PGlite pool to load the contrib bundles this catalog declares.
 *
 * Other drivers do not have the hook. A missing bundle is skipped here;
 * `CREATE EXTENSION` still fails when the server cannot install it.
 *
 * @param pool - Driver from `open()`
 * @param catalog - Schema catalog about to be applied
 */
async function loadDeclaredExtensions(pool: DriverPool, catalog: Catalog): Promise<void> {
  const prepare = (pool as { prepareExtensions?: (names: readonly string[]) => Promise<void> })
    .prepareExtensions;
  if (prepare === undefined) return;
  const names: string[] = [];
  for (const object of catalog.objects) {
    if (object.kind === "extension") names.push(object.identity.name);
  }
  if (names.length > 0) await prepare(names);
}

function sqlstateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("sqlstate" in error && typeof error.sqlstate === "string") return error.sqlstate;
  if ("code" in error && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)) {
    return error.code;
  }
  return undefined;
}

/**
 * Plain-populates every materialized view after catalog apply.
 *
 * Creation is `WITH NO DATA`. `refresh: "concurrently"` then fails with
 * "not populated" until one non-concurrent refresh has run (B-34).
 *
 * @param pool - Driver pool that just received the catalog DDL
 * @param catalog - Schema catalog
 */
async function populateMaterializedViews(pool: DriverPool, catalog: Catalog): Promise<void> {
  for (const object of catalog.objects) {
    if (object.kind !== "materializedView") continue;
    const name = object.identity.name.replaceAll('"', '""');
    await pool.execute(`refresh materialized view "${name}"`);
  }
}
