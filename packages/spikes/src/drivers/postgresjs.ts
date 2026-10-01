/**
 * postgres.js adapter.
 *
 * `unsafe` ignores the connection's `prepare: true` unless the call passes
 * `{ prepare: true, simple: false }`. Named, unnamed, and simple are selected
 * per call so the capability flag matches what the server sees.
 */

import postgres from "postgres";

import { runAtomicBatch } from "./batch.js";
import {
  DriverCallError,
  DriverError,
  errorField,
  isConnectionLoss,
  mapDriverError,
} from "./errors.js";
import { manifestFor, type DriverManifest } from "./registry.js";
import type { Session } from "./session.js";
import { inlineParams, preparedMode, watchCall, wireCell, type CallWatch } from "./sql.js";
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

type Pending = Promise<unknown> & {
  cancel: () => void;
  raw: () => Pending;
  describe: () => Promise<unknown>;
  cursor: (size: number) => AsyncIterable<unknown>;
};

type QueryClient = {
  unsafe: (
    text: string,
    params?: readonly (string | null)[],
    options?: { readonly prepare?: boolean; readonly simple?: boolean },
  ) => unknown;
  release?: () => void;
};

/**
 * Opens a postgres.js pool with the interactive capability set.
 *
 * @param url - Connection URL
 * @returns A pool for one endpoint
 */
export function openPostgresJs(url: string): DriverPool {
  return openPostgresPool(url, manifestFor("postgresjs"));
}

/**
 * Opens a pool whose public API is `execute` and atomic `batch` only.
 *
 * Statements use the simple query protocol (`prepared: "none"`). There is no
 * `reserve` and no `tx`. Cancellation still works, because the underlying
 * connection can cancel.
 *
 * @param url - Connection URL
 * @returns A batch-mode pool
 */
export function openBatchMode(url: string): DriverPool {
  return openPostgresPool(url, manifestFor("batch-mode"));
}

/**
 * Polls `pg_stat_activity` and terminates the backend running `marker`.
 *
 * @param url - Connection URL of an admin session
 * @param marker - Unique comment embedded in the target statement
 * @returns The terminated backend pid, or 0 when it never appeared
 */
export async function terminateBackend(url: string, marker: string): Promise<number> {
  const admin = postgres(url, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
    connect_timeout: 5,
  });
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      const rows = await admin.unsafe(
        "SELECT pid FROM pg_stat_activity WHERE query LIKE $1 AND pid <> pg_backend_pid()",
        [`%${marker}%`],
      );
      const pid = rows[0]?.pid;
      if (typeof pid === "number") {
        await admin.unsafe("SELECT pg_terminate_backend($1)", [pid]);
        return pid;
      }
      await delay(25);
    }
    return 0;
  } finally {
    await admin.end({ timeout: 2 });
  }
}

function openPostgresPool(url: string, manifest: DriverManifest): DriverPool {
  const notices: Notice[] = [];
  let statements = 0;
  const root = postgres(url, {
    max: 4,
    prepare: true,
    idle_timeout: 30,
    connect_timeout: 5,
    types: WIRE_TYPES,
    onnotice: (notice) => {
      notices.push({
        severity: notice.severity ?? "",
        code: notice.code,
        message: notice.message ?? "",
      });
    },
    debug: () => {
      statements += 1;
    },
    connection: { application_name: `okm-p06-${manifest.id}` },
  });
  const gate = new Gate();
  const main = new PostgresSession(asClient(root), manifest, notices);

  const pool: DriverPool = {
    capabilities: manifest.capabilities,
    preparedModes: manifest.preparedModes,
    execute(text, params, options) {
      return gate.run(() => main.query({ text, params }, options));
    },
    batch(statementsToRun, options) {
      return gate.run(async () => {
        const checked = await checkout();
        try {
          return await runAtomicBatch(checked.session, statementsToRun, options);
        } finally {
          checked.release();
        }
      });
    },
    stats: () => gate.stats(4),
    takeStatements() {
      const count = statements;
      statements = 0;
      return count;
    },
    serverVersion() {
      return pool.execute("SELECT current_setting('server_version')").then((result) => {
        return result.rows[0]?.[0] ?? "";
      });
    },
    close: () => root.end({ timeout: 5 }),
  };

  if (manifest.capabilities.transactions === "interactive") {
    pool.reserve = async () => {
      const held = await gate.checkout();
      try {
        const checked = await checkout();
        return connectionFor(checked.session, () => {
          checked.release();
          held.release();
        });
      } catch (error) {
        held.release();
        throw error;
      }
    };
    pool.tx = (fn) =>
      gate.run(async () => {
        const checked = await checkout();
        try {
          await checked.session.begin();
          try {
            const value = await fn(connectionFor(checked.session, () => undefined));
            await checked.session.commit();
            return value;
          } catch (error) {
            await checked.session.rollback().catch(() => undefined);
            throw error;
          }
        } finally {
          checked.release();
        }
      });
  }

  if (manifest.capabilities.describe) {
    pool.describe = (text, params) => gate.run(() => main.describe(text, params));
  }
  if (manifest.capabilities.stream) {
    pool.stream = (text, params) => main.stream(text, params);
  }
  if (manifest.capabilities.listen) {
    pool.listen = async (channel, onNotify) => {
      const listening = await root.listen(channel, onNotify);
      return () => listening.unlisten();
    };
    pool.notify = async (channel, payload) => {
      await root.notify(channel, payload);
    };
  }

  return pool;

  async function checkout(): Promise<{ session: PostgresSession; release: () => void }> {
    const reserved = await root.reserve();
    const session = new PostgresSession(asClient(reserved), manifest, notices);
    return {
      session,
      release() {
        if (session.lost) return;
        try {
          reserved.release();
        } catch {
          // The backend was terminated. Releasing a dead socket must not hide outcome_unknown.
        }
      },
    };
  }
}

class PostgresSession implements Session {
  readonly canCancel: boolean;
  /** The backend went away. The pool must not check this connection back in. */
  lost = false;
  private depth = 0;
  private readonly inflight = new Set<Pending>();

  private readonly client: QueryClient;
  private readonly manifest: DriverManifest;
  private readonly notices: Notice[];

  /**
   * @param client - Root client or a reserved connection
   * @param manifest - Declared capabilities
   * @param notices - Notice buffer shared with the pool
   */
  constructor(client: QueryClient, manifest: DriverManifest, notices: Notice[]) {
    this.client = client;
    this.manifest = manifest;
    this.notices = notices;
    this.canCancel = manifest.capabilities.cancel;
  }

  /**
   * Runs one statement.
   *
   * @param statement - SQL and wire parameters
   * @param options - Per-call options
   * @param watch - Shared deadline
   * @returns Wire rows
   */
  query(statement: Statement, options?: ExecuteOptions, watch?: CallWatch): Promise<ExecuteResult> {
    const owned = watch === undefined ? watchCall(options) : undefined;
    const active = watch ?? owned;
    const task = this.send(statement, options, active);
    if (owned === undefined) return task;
    return task.finally(() => {
      owned.finish();
    });
  }

  private send(
    statement: Statement,
    options: ExecuteOptions | undefined,
    watch: CallWatch | undefined,
  ): Promise<ExecuteResult> {
    const mode = preparedMode(this.manifest.capabilities.prepared, options);
    if (!this.manifest.preparedModes.includes(mode)) {
      return Promise.reject(new DriverError(`prepared ${mode} is not declared`, {}));
    }
    if (watch?.signal.aborted === true) return Promise.reject(aborted(watch));
    const text = mode === "none" ? inlineParams(statement.text, statement.params) : statement.text;
    const params = mode === "none" ? [] : [...(statement.params ?? [])];
    const pending = asPending(
      this.client.unsafe(text, params, {
        prepare: mode === "named",
        simple: mode === "none",
      }),
    ).raw();
    return this.finish(pending, this.notices.length, watch);
  }

  /**
   * Describes a statement without running it.
   *
   * @param text - SQL
   * @param params - Wire parameters
   * @returns Column names and the parameter count
   */
  async describe(text: string, params?: readonly (string | null)[]): Promise<DescribeResult> {
    const pending = asPending(
      this.client.unsafe(text, [...(params ?? [])], { prepare: true, simple: false }),
    );
    const described = await pending.describe();
    return readDescribe(described);
  }

  /**
   * Yields cursor chunks.
   *
   * @param text - SQL
   * @param params - Wire parameters
   * @returns Chunks of rows
   */
  async *stream(
    text: string,
    params?: readonly (string | null)[],
  ): AsyncIterable<readonly (readonly (string | null)[])[]> {
    const pending = asPending(
      this.client.unsafe(text, [...(params ?? [])], { prepare: false, simple: false }),
    );
    for await (const chunk of pending.cursor(2)) {
      yield readChunk(chunk);
    }
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
    for (const pending of this.inflight) pending.cancel();
  }

  private control(text: string, watch?: CallWatch): Promise<ExecuteResult> {
    const mode: PreparedMode = this.manifest.preparedModes.includes("unnamed") ? "unnamed" : "none";
    return this.query({ text }, { prepared: mode }, watch);
  }

  private async finish(
    pending: Pending,
    noticeStart: number,
    watch: CallWatch | undefined,
  ): Promise<ExecuteResult> {
    this.inflight.add(pending);
    const onAbort = (): void => {
      if (this.canCancel) this.cancel();
    };
    watch?.signal.addEventListener("abort", onAbort);
    if (watch?.signal.aborted === true) onAbort();
    try {
      const result = await pending;
      if (this.canCancel && watch?.cause() === "timeout") throw new DriverCallError("timeout");
      if (this.canCancel && watch?.cause() === "signal") throw new DriverCallError("cancelled");
      return readResult(result, this.notices.slice(noticeStart));
    } catch (error) {
      if (isConnectionLoss(error)) {
        this.lost = true;
        throw error;
      }
      if (error instanceof DriverCallError || error instanceof DriverError) throw error;
      if (watch?.cause() === "timeout") throw new DriverCallError("timeout", error);
      if (watch?.cause() === "signal" || errorField(error, "code") === "57014") {
        throw new DriverCallError("cancelled", error);
      }
      throw mapDriverError(error);
    } finally {
      this.inflight.delete(pending);
      watch?.signal.removeEventListener("abort", onAbort);
    }
  }
}

function connectionFor(session: PostgresSession, release: () => void): DriverConnection {
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

class Gate {
  private tail: Promise<void> = Promise.resolve();
  private reserved = 0;
  private inflight = 0;
  private waiting = 0;

  /**
   * Runs `fn` alone on the pool.
   *
   * @param fn - Work
   * @returns Whatever `fn` returns
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const held = this.holdGate();
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
   * Holds the pool until `release` is called.
   *
   * @returns A checkout token
   */
  checkout(): Promise<{ release: () => void }> {
    const held = this.holdGate();
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

  /**
   * Pool counters.
   *
   * postgres.js does not expose its own counters. These are the adapter's.
   *
   * @param size - Configured pool size
   * @returns The counters
   */
  stats(size: number): DriverStats {
    return {
      size,
      idle: Math.max(0, size - this.reserved - this.inflight),
      inflight: this.inflight,
      waiting: this.waiting,
    };
  }

  private holdGate(): { ready: Promise<void>; release: () => void } {
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

function aborted(watch: CallWatch | undefined): DriverCallError {
  return new DriverCallError(watch?.cause() === "timeout" ? "timeout" : "cancelled");
}

function asClient(value: object): QueryClient {
  if (!("unsafe" in value) || typeof value.unsafe !== "function") {
    throw new Error("expected a postgres.js client");
  }
  return value as QueryClient;
}

function asPending(value: unknown): Pending {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof Reflect.get(value, "cancel") !== "function"
  ) {
    throw new Error("expected a pending postgres.js query");
  }
  return value as Pending;
}

function readResult(result: unknown, notices: readonly Notice[]): ExecuteResult {
  const rows = Array.isArray(result)
    ? result.map((row) => (Array.isArray(row) ? row.map(wireCell) : []))
    : [];
  return {
    rows,
    columns: readColumns(result),
    count: readCount(result, rows.length),
    notices,
  };
}

function readColumns(result: unknown): string[] {
  if (typeof result !== "object" || result === null || !("columns" in result)) return [];
  const columns = Reflect.get(result, "columns") as unknown;
  if (!Array.isArray(columns)) return [];
  return columns.map((column) => {
    if (typeof column === "object" && column !== null && "name" in column) {
      const name = Reflect.get(column, "name");
      if (typeof name === "string") return name;
    }
    return "";
  });
}

function readCount(result: unknown, rows: number): number {
  if (typeof result === "object" && result !== null && "count" in result) {
    const count = Reflect.get(result, "count");
    if (typeof count === "number" && !Number.isNaN(count)) return count;
  }
  return rows;
}

function readDescribe(result: unknown): DescribeResult {
  const columns = readColumns(result);
  let parameterCount = 0;
  if (typeof result === "object" && result !== null && "types" in result) {
    const types = Reflect.get(result, "types");
    if (Array.isArray(types)) parameterCount = types.length;
  }
  return { columns, parameterCount };
}

function readChunk(chunk: unknown): (string | null)[][] {
  if (!Array.isArray(chunk)) return [];
  return chunk.map((row) => {
    if (Array.isArray(row)) return row.map((cell) => chunkCell(cell));
    if (typeof row === "object" && row !== null) {
      return Object.values(row).map((cell) => chunkCell(cell));
    }
    return [chunkCell(row)];
  });
}

function chunkCell(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "string") return cell;
  if (typeof cell === "number" || typeof cell === "boolean" || typeof cell === "bigint") {
    return String(cell);
  }
  if (cell instanceof Uint8Array) return Buffer.from(cell).toString("utf8");
  return JSON.stringify(cell);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * postgres.js rewrites parameters with its JavaScript serializers.
 * A boolean wire `t` would be sent as `f` because `serialize` tests `=== true`.
 * These overrides keep the caller's wire text.
 */
const WIRE_TYPES = {
  boolean: wireType(16, [16]),
  json: wireType(114, [114, 3802]),
  date: wireType(1184, [1082, 1114, 1184]),
  bytea: wireType(17, [17]),
};

function wireType(
  to: number,
  from: readonly number[],
): {
  to: number;
  from: number[];
  serialize: (value: string) => string;
  parse: (value: unknown) => string;
} {
  return {
    to,
    from: [...from],
    serialize: (value) => value,
    parse: (value) => (typeof value === "string" ? value : String(value)),
  };
}
