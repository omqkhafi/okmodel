/**
 * PGlite adapter.
 *
 * `query` is the extended protocol with an unnamed statement. `exec` is the
 * simple protocol. Neither accepts `AbortSignal`, and `statement_timeout` is
 * stored but not enforced, so `cancel` is not declared.
 */

import { PGlite } from "@electric-sql/pglite";

import { runAtomicBatch } from "./batch.js";
import {
  DriverCallError,
  DriverError,
  errorField,
  isConnectionLoss,
  mapDriverError,
} from "./errors.js";
import { manifestFor } from "./registry.js";
import type { Session } from "./session.js";
import { inlineParams, preparedMode, wireCell, type CallWatch } from "./sql.js";
import type {
  DescribeResult,
  DriverConnection,
  DriverPool,
  DriverStats,
  ExecuteOptions,
  ExecuteResult,
  Notice,
  PreparedMode,
  Statement,
} from "./types.js";

const WIRE_OIDS = [
  16, 20, 21, 23, 25, 114, 700, 701, 1000, 1005, 1007, 1009, 1016, 1043, 1082, 1114, 1184, 1700,
  2950, 3802,
] as const;

const WIRE_PARSERS = Object.fromEntries(WIRE_OIDS.map((oid) => [oid, (value: string) => value]));

/**
 * Opens an in-memory PGlite pool of one.
 *
 * @returns A pool for that database
 */
export async function openPglite(): Promise<DriverPool> {
  const db = new PGlite("memory://");
  await db.waitReady;
  const manifest = manifestFor("pglite");
  const gate = new Gate();
  let statements = 0;
  const session = new PgliteSession(db, () => {
    statements += 1;
  });

  const pool: DriverPool = {
    capabilities: manifest.capabilities,
    preparedModes: manifest.preparedModes,
    execute: (text, params, options) => gate.run(() => session.query({ text, params }, options)),
    batch: (statementsToRun, options) =>
      gate.run(() => runAtomicBatch(session, statementsToRun, options)),
    reserve: async () => {
      const held = await gate.checkout();
      return connectionFor(session, () => {
        held.release();
      });
    },
    tx: (fn) =>
      gate.run(async () => {
        await session.begin();
        try {
          const value = await fn(connectionFor(session, () => undefined));
          await session.commit();
          return value;
        } catch (error) {
          await session.rollback().catch(() => undefined);
          throw error;
        }
      }),
    describe: (text) => gate.run(() => session.describe(text)),
    listen: async (channel, onNotify) => {
      const unlisten = await db.listen(channel, onNotify);
      return async () => {
        await unlisten();
      };
    },
    notify: async (channel, payload) => {
      await db.query("SELECT pg_notify($1, $2)", [channel, payload]);
    },
    stats: () => gate.stats(),
    takeStatements() {
      const count = statements;
      statements = 0;
      return count;
    },
    serverVersion: () =>
      pool
        .execute("SELECT current_setting('server_version')")
        .then((result) => result.rows[0]?.[0] ?? ""),
    close: () => db.close(),
  };
  return pool;
}

class PgliteSession implements Session {
  readonly canCancel = false;
  private depth = 0;

  private readonly db: PGlite;
  private readonly countStatement: () => void;

  /**
   * @param db - The database
   * @param countStatement - Records one sent statement
   */
  constructor(db: PGlite, countStatement: () => void) {
    this.db = db;
    this.countStatement = countStatement;
  }

  /**
   * Runs one statement.
   *
   * @param statement - SQL and wire parameters
   * @param options - Per-call options
   * @param watch - Shared deadline. An abort that arrives during the call cannot stop it
   * @returns Wire rows
   */
  async query(
    statement: Statement,
    options?: ExecuteOptions,
    watch?: CallWatch,
  ): Promise<ExecuteResult> {
    const mode = preparedMode("unnamed", options);
    if (mode === "named") throw new DriverError("prepared named is not declared", {});
    if (watch?.signal.aborted === true || options?.signal?.aborted === true) throw aborted(watch);
    this.countStatement();
    const notices: Notice[] = [];
    const onNotice = (notice: unknown): void => {
      notices.push(readNotice(notice));
    };
    try {
      if (mode === "none") {
        const results = await this.db.exec(inlineParams(statement.text, statement.params), {
          parsers: WIRE_PARSERS,
          onNotice,
        });
        return fromResults(results[results.length - 1], notices);
      }
      const result = await this.db.query(statement.text, [...(statement.params ?? [])], {
        parsers: WIRE_PARSERS,
        onNotice,
      });
      return fromResults(result, notices);
    } catch (error) {
      if (error instanceof DriverCallError || error instanceof DriverError) throw error;
      if (isConnectionLoss(error)) throw error;
      if (errorField(error, "code") === "57014") {
        throw new DriverCallError(watch?.cause() === "signal" ? "cancelled" : "timeout", error);
      }
      throw mapDriverError(error);
    }
  }

  /**
   * Describes a statement.
   *
   * @param text - SQL
   * @returns Column names and the parameter count
   */
  async describe(text: string): Promise<DescribeResult> {
    this.countStatement();
    const described = await this.db.describeQuery(text);
    return {
      columns: described.resultFields.map((field) => field.name),
      parameterCount: described.queryParams.length,
    };
  }

  /** @inheritdoc */
  begin(watch?: CallWatch): Promise<void> {
    return this.control("BEGIN", watch).then(() => {
      this.depth += 1;
    });
  }

  /** @inheritdoc */
  commit(watch?: CallWatch): Promise<void> {
    return this.control("COMMIT", watch).then(() => {
      this.depth = Math.max(0, this.depth - 1);
    });
  }

  /** @inheritdoc */
  rollback(): Promise<void> {
    return this.control("ROLLBACK").then(
      () => {
        this.depth = Math.max(0, this.depth - 1);
      },
      (error: unknown) => {
        this.depth = 0;
        throw error;
      },
    );
  }

  /** @inheritdoc */
  savepoint(name: string): Promise<void> {
    return this.control(`SAVEPOINT ${name}`).then(() => undefined);
  }

  /** @inheritdoc */
  release(name: string): Promise<void> {
    return this.control(`RELEASE SAVEPOINT ${name}`).then(() => undefined);
  }

  /** @inheritdoc */
  rollbackTo(name: string): Promise<void> {
    return this.control(`ROLLBACK TO SAVEPOINT ${name}`).then(() => undefined);
  }

  /** @inheritdoc */
  inTransaction(): boolean {
    return this.depth > 0;
  }

  /** @inheritdoc */
  cancel(): void {
    // PGlite runs the statement on this thread. There is no cancel to send.
  }

  private control(text: string, watch?: CallWatch): Promise<ExecuteResult> {
    const mode: PreparedMode = "unnamed";
    return this.query({ text }, { prepared: mode }, watch);
  }
}

function connectionFor(session: PgliteSession, release: () => void): DriverConnection {
  let released = false;
  return {
    execute: (text, params, options) => session.query({ text, params }, options),
    batch: (statements, options) => runAtomicBatch(session, statements, options),
    release() {
      if (released) return;
      released = true;
      release();
    },
  };
}

function fromResults(result: unknown, notices: readonly Notice[]): ExecuteResult {
  const parsed = asResult(result);
  if (parsed === undefined) return { rows: [], columns: [], count: 0, notices };
  const columns = parsed.fields.map((field) => field.name);
  const rows = parsed.rows.map((row) => columns.map((column) => wireCell(row[column])));
  return {
    rows,
    columns,
    count: parsed.rowCount ?? parsed.affectedRows ?? rows.length,
    notices,
  };
}

function readNotice(notice: unknown): Notice {
  const severity = errorField(notice, "severity") ?? "";
  const message = errorField(notice, "message") ?? "";
  const code = errorField(notice, "code");
  return code === undefined ? { severity, message } : { severity, message, code };
}

function asResult(result: unknown):
  | {
      readonly fields: readonly { readonly name: string }[];
      readonly rows: readonly { readonly [column: string]: unknown }[];
      readonly rowCount: number | null;
      readonly affectedRows: number | null;
    }
  | undefined {
  if (
    typeof result !== "object" ||
    result === null ||
    !("fields" in result) ||
    !("rows" in result)
  ) {
    return undefined;
  }
  const fields = Reflect.get(result, "fields");
  const rows = Reflect.get(result, "rows");
  if (!Array.isArray(fields) || !Array.isArray(rows)) return undefined;
  const rowCount = Reflect.get(result, "rowCount");
  const affectedRows = Reflect.get(result, "affectedRows");
  return {
    fields: fields.map((field) => {
      if (typeof field === "object" && field !== null && "name" in field) {
        const name = Reflect.get(field, "name");
        return { name: typeof name === "string" ? name : "" };
      }
      return { name: "" };
    }),
    rows: rows.filter(
      (row): row is { readonly [column: string]: unknown } =>
        typeof row === "object" && row !== null && !Array.isArray(row),
    ),
    rowCount: typeof rowCount === "number" ? rowCount : null,
    affectedRows: typeof affectedRows === "number" ? affectedRows : null,
  };
}

function aborted(watch: CallWatch | undefined): DriverCallError {
  return new DriverCallError(watch?.cause() === "timeout" ? "timeout" : "cancelled");
}

class Gate {
  private tail: Promise<void> = Promise.resolve();
  private reserved = 0;
  private inflight = 0;
  private waiting = 0;

  /**
   * Runs `fn` alone.
   *
   * @param fn - Work
   * @returns Whatever `fn` returns
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const held = this.hold();
    return held.ready.then(async () => {
      this.inflight += 1;
      try {
        return await fn();
      } finally {
        this.inflight = Math.max(0, this.inflight - 1);
        held.release();
      }
    });
  }

  /**
   * Holds the only connection until `release`.
   *
   * @returns A checkout token
   */
  checkout(): Promise<{ release: () => void }> {
    const held = this.hold();
    return held.ready.then(() => {
      this.reserved += 1;
      return {
        release: () => {
          this.reserved = Math.max(0, this.reserved - 1);
          held.release();
        },
      };
    });
  }

  /** Pool counters. A PGlite pool has one connection. */
  stats(): DriverStats {
    return {
      size: 1,
      idle: this.reserved === 0 && this.inflight === 0 ? 1 : 0,
      inflight: this.inflight,
      waiting: this.waiting,
    };
  }

  private hold(): { ready: Promise<void>; release: () => void } {
    this.waiting += 1;
    let release = (): void => undefined;
    const next = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    const ready = this.tail.then(() => {
      this.waiting = Math.max(0, this.waiting - 1);
    });
    this.tail = this.tail.then(() => next);
    return { ready, release };
  }
}
