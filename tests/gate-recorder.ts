/**
 * A pool that records every statement it is asked to run.
 *
 * The gate property tests wrap a real pool with it. The log is what reached the
 * driver, so a check on it is a check on the wire and not on `sql()`.
 * `countQueries` is the same idea as `expectQueries` in `okmodel/testing`.
 * The property tests keep this recorder so they can read the wire themselves.
 */

import type {
  DriverConnection,
  DriverPool,
  ExecuteOptions,
  ExecuteResult,
  Statement,
  WireValue,
} from "../src/contracts/driver.js";

/** One statement that reached the driver. */
export type Recorded = {
  readonly text: string;
  readonly params: readonly WireValue[];
};

/** A recording pool and its log. */
export type Recording = {
  readonly pool: DriverPool;
  /** Every statement since the pool was wrapped, in the order sent. */
  readonly log: Recorded[];
  /** Driver calls (`execute` or `batch`), each counted once. */
  readonly calls: { count: number };
};

/**
 * Wraps a pool so each statement is logged.
 *
 * @param pool - The real pool
 * @returns The wrapped pool and its log
 */
export function record(pool: DriverPool, mutate?: (statement: Statement) => Statement): Recording {
  const log: Recorded[] = [];
  const calls = { count: 0 };
  const note = (statement: Statement): void => {
    log.push({ text: statement.text, params: statement.params ?? [] });
  };
  // A mutation changes what reaches the driver and what the log shows, so the
  // checks judge the statement that ran. Only a test of the harness sets one.
  const change = (statement: Statement): Statement =>
    mutate === undefined ? statement : mutate(statement);
  const wrapConnection = (connection: DriverConnection): DriverConnection => ({
    ...connection,
    execute(text: string, params?: readonly WireValue[], options?: ExecuteOptions) {
      calls.count += 1;
      const next = change({ text, ...(params !== undefined ? { params } : {}) });
      note(next);
      return connection.execute(next.text, next.params, options);
    },
    batch(statements: readonly Statement[], options?: ExecuteOptions) {
      calls.count += 1;
      const next = statements.map(change);
      for (const statement of next) note(statement);
      return connection.batch(next, options);
    },
    release: () => connection.release(),
    ...(connection.cancel !== undefined ? { cancel: () => connection.cancel?.() } : {}),
  });
  const wrapped: DriverPool = {
    capabilities: pool.capabilities,
    execute(
      text: string,
      params?: readonly WireValue[],
      options?: ExecuteOptions,
    ): Promise<ExecuteResult> {
      calls.count += 1;
      const next = change({ text, ...(params !== undefined ? { params } : {}) });
      note(next);
      return pool.execute(next.text, next.params, options);
    },
    batch(statements: readonly Statement[], options?: ExecuteOptions) {
      calls.count += 1;
      const next = statements.map(change);
      for (const statement of next) note(statement);
      return pool.batch(next, options);
    },
    stats: () => pool.stats(),
    close: () => pool.close(),
    ...(pool.reserve !== undefined
      ? { reserve: async () => wrapConnection(await pool.reserve!()) }
      : {}),
    ...(pool.describe !== undefined
      ? { describe: (text: string, params?: readonly WireValue[]) => pool.describe!(text, params) }
      : {}),
    ...(pool.cancel !== undefined ? { cancel: () => pool.cancel?.() } : {}),
  };
  return { pool: wrapped, log, calls };
}

/**
 * Runs `fn` and returns the statements it sent.
 *
 * @param recording - A pool from {@link record}
 * @param fn - The work to count
 * @returns The statements, and `fn`'s result
 */
export async function countQueries<T>(
  recording: Recording,
  fn: () => Promise<T>,
): Promise<{ readonly statements: readonly Recorded[]; readonly value: T }> {
  const from = recording.log.length;
  const value = await fn();
  return { statements: recording.log.slice(from), value };
}

/** Statements that only frame a transaction. They carry no table. */
const FRAMING = /^\s*(begin|commit|rollback|savepoint|release|set |reset |select pg_advisory)/i;

/**
 * Checks that every statement carries the tenant predicate for `tenant`.
 *
 * Each reference to a tenant table (`from`, `join`, `update`) needs its alias
 * bound to the tenant: `alias."tenant_id" = $n` with the tenant as parameter,
 * or `alias."tenant_id" = other."tenant_id"` against an alias that is. An
 * `insert into` needs the tenant among its parameters and the key in its column
 * list. No other tenant's key may appear as a parameter or in the text.
 *
 * @param statements - What reached the driver
 * @param tenant - The tenant the client was scoped to
 * @param others - Every other tenant key
 * @param tables - SQL names of the tenant tables
 * @returns Problems, empty when the statements hold
 */
export function tenantProblems(
  statements: readonly Recorded[],
  tenant: string,
  others: readonly string[],
  tables: readonly string[],
): readonly string[] {
  const problems: string[] = [];
  const names = tables.join("|");
  const scan = new RegExp(
    `\\b(from|join|update|into)\\s+(?:"[^"]+"\\.)?"(${names})"(?:\\s+as)?(?:\\s+([a-z_][a-z0-9_]*))?`,
    "gi",
  );
  const stop = new Set([
    "where",
    "on",
    "left",
    "inner",
    "join",
    "set",
    "using",
    "values",
    "returning",
  ]);
  for (const { text, params } of statements) {
    if (FRAMING.test(text)) continue;
    for (const other of others) {
      if (params.includes(other) || text.includes(other)) {
        problems.push(`another tenant's key reached the wire: ${text}`);
      }
    }
    if (text.includes(tenant)) problems.push(`a tenant key is in the statement text: ${text}`);
    for (const found of text.matchAll(scan)) {
      const verb = (found[1] ?? "").toLowerCase();
      const table = found[2] ?? "";
      const alias = found[3]?.toLowerCase();
      if (verb === "into") {
        if (!params.includes(tenant) || !text.includes('"tenant_id"')) {
          problems.push(`an insert into ${table} without the tenant key: ${text}`);
        }
        continue;
      }
      if (alias === undefined || stop.has(alias)) {
        problems.push(`${verb} ${table} has no alias to check: ${text}`);
        continue;
      }
      const direct = new RegExp(`\\b${alias}\\."tenant_id"\\s*=\\s*\\$(\\d+)`, "g");
      let bound = false;
      for (const match of text.matchAll(direct)) {
        if (params[Number(match[1]) - 1] === tenant) bound = true;
      }
      if (!bound) {
        const joined = new RegExp(
          `\\b${alias}\\."tenant_id"\\s*=\\s*[a-z_][a-z0-9_]*\\."tenant_id"`,
          "i",
        );
        bound = joined.test(text);
      }
      if (!bound) problems.push(`${verb} ${table} ${alias} is not bound to the tenant: ${text}`);
    }
  }
  return problems;
}
