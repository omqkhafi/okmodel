/**
 * `okmodel/testing`: a real database, factories, query counts, and the
 * isolation check (spec §20, D199).
 *
 * The database is never mocked. Pass a driver pool from `open()`.
 */

import { OkmError } from "../../contracts/error.js";
import type { DriverPool } from "../../contracts/driver.js";
import { renderCatalog } from "../../dialects/pg/ddl.js";
import { createClient } from "../../runtime/client.js";
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
   * @returns Checked tenant tables and skipped global tables
   */
  isolation(): Promise<IsolationReport>;
  /** Closes the client and the pool. */
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
  if (options.migrate !== false) {
    for (const statement of renderCatalog(schema.catalog, "public")) {
      if (statement.trim().length === 0) continue;
      await pool.execute(statement);
    }
  }
  const recording = record(pool);
  const db = createClient(schema, recording.pool, { ownsPool: true });
  await db.connected;
  const facts = new Map(readFacts(schema).map((item) => [item.name, item]));
  const host: FactoryHost = {
    schema,
    db: db as Connected<TestingSchema>,
    facts,
    rng: rng(seed),
    cache: new Map(),
    creating: new Set(),
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
    close: () => db.close(),
  };
  attachHost(harness, host);
  return harness;
}
