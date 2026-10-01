/**
 * Conformance cases for the driver spike.
 *
 * A declared capability maps to one of these ids. Contract cases run on every
 * adapter; `skipReason` records why a case does not apply.
 */

import { expect } from "bun:test";

import { isolatedSchemaName } from "@okmodel/harness";

import { DriverCallError, DriverError } from "./errors.js";
import { decodeBoolean, decodeTextArray, decodeTimestamp, qualify, quoteIdent } from "./sql.js";
import type { DriverPool, PreparedMode, Statement } from "./types.js";

/** One observation the suite wants printed, not asserted as a ceiling. */
export type Observation = {
  /** Adapter id. */
  readonly driver: string;
  /** Measurement name. */
  readonly name: string;
  /** Measured value. */
  readonly value: string;
};

/** What a case can see. */
export type CaseContext = {
  /** Adapter id. */
  readonly driver: string;
  /** Pool under test. */
  readonly pool: DriverPool;
  /** Kills the backend whose query contains the marker. Null on PGlite. */
  readonly terminate: ((marker: string) => Promise<number>) | null;
  /**
   * Records a measurement.
   *
   * @param name - Measurement name
   * @param value - Measured value
   */
  note(name: string, value: string | number): void;
};

/** A conformance case. */
export type ConformanceCase = {
  /** Stable id. The registry points at these. */
  readonly id: string;
  /**
   * Runs the case.
   *
   * @param ctx - Pool and hooks
   */
  run(ctx: CaseContext): Promise<void>;
};

const SKIP = {
  interactive: "transactions interactive is not declared",
  batch: "transactions batch is not declared",
  stream: "stream is not declared",
  listen: "listen is not declared",
  describe: "describe is not declared",
  cancel: "cancel is not declared",
  timeout: "cancel is not declared, so an in-flight timeout cannot be enforced",
  terminate: "no separate backend to terminate",
} as const;

/**
 * Why this case does not run on this pool.
 *
 * @param pool - Adapter
 * @param id - Case id
 * @param canTerminate - Whether `pg_terminate_backend` is available
 * @returns A skip reason, or undefined when the case should run
 */
export function skipReason(
  pool: DriverPool,
  id: string,
  canTerminate: boolean,
): string | undefined {
  const flags = pool.capabilities;
  if (id === "transactions.interactive" && flags.transactions !== "interactive")
    return SKIP.interactive;
  if (id === "transactions.batch" && flags.transactions !== "batch") return SKIP.batch;
  if (id === "stream.cursor" && !flags.stream) return SKIP.stream;
  if (id === "listen.notify" && !flags.listen) return SKIP.listen;
  if (id === "describe.query" && !flags.describe) return SKIP.describe;
  if ((id === "execute.cancel" || id === "batch.atomic.cancel") && !flags.cancel)
    return SKIP.cancel;
  if (id === "batch.atomic.timeout" && !flags.cancel) return SKIP.timeout;
  if (id === "batch.atomic.savepoint" && flags.transactions !== "interactive")
    return SKIP.interactive;
  if (id === "batch.atomic.outcome" && !canTerminate) return SKIP.terminate;
  if (id.startsWith("prepared.")) {
    const mode = id.slice("prepared.".length);
    if (!pool.preparedModes.includes(mode as PreparedMode))
      return `prepared ${mode} is not declared`;
  }
  return undefined;
}

/** Cases in table order. */
export const CASES: readonly ConformanceCase[] = [
  { id: "execute.rows", run: executeRows },
  { id: "execute.params", run: executeParams },
  { id: "execute.codecs", run: executeCodecs },
  { id: "execute.notices", run: executeNotices },
  { id: "execute.errors", run: executeErrors },
  { id: "signal.preaborted", run: signalPreaborted },
  { id: "execute.cancel", run: executeCancel },
  { id: "timeout.declaration", run: timeoutDeclaration },
  { id: "transactions.interactive", run: transactionsInteractive },
  { id: "transactions.batch", run: transactionsBatch },
  { id: "stream.cursor", run: streamCursor },
  { id: "listen.notify", run: listenNotify },
  { id: "describe.query", run: describeQuery },
  { id: "prepared.named", run: (ctx) => prepared(ctx, "named") },
  { id: "prepared.unnamed", run: (ctx) => prepared(ctx, "unnamed") },
  { id: "prepared.none", run: (ctx) => prepared(ctx, "none") },
  { id: "stats.shape", run: statsShape },
  { id: "batch.atomic.success", run: batchSuccess },
  { id: "batch.atomic.failure", run: batchFailure },
  { id: "batch.atomic.deferred", run: batchDeferred },
  { id: "batch.atomic.sequences", run: batchSequences },
  { id: "batch.atomic.cancel", run: batchCancel },
  { id: "batch.atomic.timeout", run: batchTimeout },
  { id: "batch.atomic.savepoint", run: batchSavepoint },
  { id: "batch.atomic.outcome", run: batchOutcome },
];

/** Case ids in table order. */
export const CASE_IDS: readonly string[] = CASES.map((item) => item.id);

async function executeRows(ctx: CaseContext): Promise<void> {
  const result = await ctx.pool.execute("SELECT n::text FROM generate_series(1, 2) AS g(n)");
  expect(result.columns).toEqual(["n"]);
  expect(result.rows.map((row) => row[0])).toEqual(["1", "2"]);
  expect(result.count).toBe(2);
}

async function executeParams(ctx: CaseContext): Promise<void> {
  const result = await ctx.pool.execute("SELECT $1::text AS value", ["hello"]);
  expect(result.rows[0]?.[0]).toBe("hello");
}

async function executeCodecs(ctx: CaseContext): Promise<void> {
  await withSchema(ctx.pool, async (schema) => {
    const table = qualify(schema, "codec");
    await ctx.pool.execute(
      `CREATE TABLE ${table} (
        id int PRIMARY KEY,
        n_int int,
        n_big bigint,
        n_num numeric,
        flag boolean,
        at timestamptz,
        doc jsonb,
        tags text[],
        nums int[]
      )`,
    );
    await ctx.pool.execute(
      `INSERT INTO ${table} (id, n_int, n_big, n_num, flag, at, doc, tags, nums)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        "1",
        "42",
        "9223372036854775807",
        "123456789.123456789",
        "t",
        "2020-01-02 03:04:05.123456+00",
        '{"a":1}',
        "{alpha,beta}",
        "{1,2}",
      ],
    );
    await ctx.pool.execute(
      `INSERT INTO ${table} (id, n_int, n_big, n_num, flag, at, doc, tags, nums)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      ["2", null, null, null, null, null, null, null, null],
    );
    const row = await ctx.pool.execute(
      `SELECT n_int, n_big, n_num, flag, at, doc, tags, nums FROM ${table} WHERE id = 1`,
    );
    const cells = row.rows[0];
    if (cells === undefined) throw new Error("missing codec row");
    expect(cells[0]).toBe("42");
    expect(cells[1]).toBe("9223372036854775807");
    expect(cells[2]).toBe("123456789.123456789");
    expect(decodeBoolean(cells[3] ?? "")).toBe(true);
    expect(decodeTimestamp(cells[4] ?? "")).toBe(Date.parse("2020-01-02T03:04:05.123Z"));
    expect(JSON.parse(cells[5] ?? "")).toEqual({ a: 1 });
    expect(decodeTextArray(cells[6] ?? "")).toEqual(["alpha", "beta"]);
    expect(decodeTextArray(cells[7] ?? "")).toEqual(["1", "2"]);
    const empty = await ctx.pool.execute(
      `SELECT n_int, n_big, flag, doc, tags FROM ${table} WHERE id = 2`,
    );
    expect(empty.rows[0]).toEqual([null, null, null, null, null]);
    const flag = await ctx.pool.execute("SELECT $1::boolean", ["f"]);
    expect(flag.rows[0]?.[0]).toBe("f");
  });
}

async function executeNotices(ctx: CaseContext): Promise<void> {
  const result = await ctx.pool.execute("DO $$ BEGIN RAISE NOTICE 'p06-hello'; END $$");
  expect(result.notices.some((notice) => notice.message.includes("p06-hello"))).toBe(true);
}

async function executeErrors(ctx: CaseContext): Promise<void> {
  await withSchema(ctx.pool, async (schema) => {
    const table = qualify(schema, "boxed");
    await ctx.pool.execute(
      `CREATE TABLE ${table} (id int PRIMARY KEY, email text CONSTRAINT email_uniq UNIQUE)`,
    );
    await ctx.pool.execute(`INSERT INTO ${table} (id, email) VALUES (1, 'a')`);
    const error = await catchError(() =>
      ctx.pool.execute(`INSERT INTO ${table} (id, email) VALUES (2, 'a')`),
    );
    expect(error).toBeInstanceOf(DriverError);
    if (!(error instanceof DriverError)) return;
    expect(error.sqlstate).toBe("23505");
    expect(error.constraint).toBe("email_uniq");
    expect(error.table).toBe("boxed");
  });
}

async function signalPreaborted(ctx: CaseContext): Promise<void> {
  await withSchema(ctx.pool, async (schema) => {
    const table = qualify(schema, "early");
    await ctx.pool.execute(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
    const signal = new AbortController();
    signal.abort();
    const error = await catchError(() =>
      ctx.pool.execute(`INSERT INTO ${table} (id) VALUES (1)`, undefined, {
        signal: signal.signal,
      }),
    );
    expect(error).toBeInstanceOf(DriverCallError);
    if (error instanceof DriverCallError) expect(error.kind).toBe("cancelled");
    const left = await ctx.pool.execute(`SELECT count(*)::text FROM ${table}`);
    expect(left.rows[0]?.[0]).toBe("0");
  });
}

async function executeCancel(ctx: CaseContext): Promise<void> {
  const reserve = ctx.pool.reserve;
  if (reserve !== undefined) {
    const connection = await reserve();
    try {
      const before = await connection.execute("SELECT pg_backend_pid()::text");
      await expectCancelled(ctx, (text, params, options) =>
        connection.execute(text, params, options),
      );
      const after = await connection.execute("SELECT pg_backend_pid()::text");
      expect(after.rows[0]?.[0]).toBe(before.rows[0]?.[0]);
    } finally {
      connection.release();
    }
    return;
  }
  await expectCancelled(ctx, (text, params, options) => ctx.pool.execute(text, params, options));
  const after = await ctx.pool.execute("SELECT 1::text");
  expect(after.rows[0]?.[0]).toBe("1");
}

async function expectCancelled(ctx: CaseContext, execute: DriverPool["execute"]): Promise<void> {
  const signal = new AbortController();
  const started = performance.now();
  const pending = execute("SELECT pg_sleep(8)", undefined, { signal: signal.signal });
  setTimeout(() => signal.abort(), 30);
  const error = await catchError(() => pending);
  const elapsed = performance.now() - started;
  expect(error).toBeInstanceOf(DriverCallError);
  if (error instanceof DriverCallError) expect(error.kind).toBe("cancelled");
  expect(elapsed).toBeLessThan(1500);
  ctx.note("cancelMs", Math.round(elapsed));
}

async function timeoutDeclaration(ctx: CaseContext): Promise<void> {
  if (ctx.pool.capabilities.cancel) {
    const started = performance.now();
    const error = await catchError(() =>
      ctx.pool.execute("SELECT pg_sleep(8)", undefined, { timeout: 80 }),
    );
    const elapsed = performance.now() - started;
    expect(error).toBeInstanceOf(DriverCallError);
    if (error instanceof DriverCallError) expect(error.kind).toBe("timeout");
    expect(elapsed).toBeLessThan(1500);
    await ctx.pool.execute("SELECT 1");
    ctx.note("timeoutMs", Math.round(elapsed));
    ctx.note("timeoutEnforced", "yes");
    return;
  }
  await ctx.pool.execute("SELECT set_config('statement_timeout', '40', false)");
  const started = performance.now();
  await ctx.pool.execute("SELECT pg_sleep(0.35)");
  const elapsed = performance.now() - started;
  await ctx.pool.execute("SELECT set_config('statement_timeout', '0', false)");
  expect(elapsed).toBeGreaterThan(250);
  ctx.note("timeoutMs", Math.round(elapsed));
  ctx.note("timeoutEnforced", "no");
}

async function transactionsInteractive(ctx: CaseContext): Promise<void> {
  const reserve = ctx.pool.reserve;
  if (reserve === undefined) throw new Error("interactive pool has no reserve");
  const connection = await reserve();
  const during = ctx.pool.stats();
  expect(during.idle).toBeLessThan(during.size);
  await connection.execute("SELECT set_config('okm.p06', 'yes', false)");
  const seen = await connection.execute("SELECT current_setting('okm.p06', true)");
  expect(seen.rows[0]?.[0]).toBe("yes");
  connection.release();
  const after = await ctx.pool.execute("SELECT current_setting('okm.p06', true)");
  ctx.note("sessionLeaked", after.rows[0]?.[0] === "yes" ? "yes" : "no");
  await ctx.pool.execute("SELECT 1");
}

async function transactionsBatch(ctx: CaseContext): Promise<void> {
  expect(ctx.pool.reserve).toBeUndefined();
  expect(ctx.pool.tx).toBeUndefined();
  await withSchema(ctx.pool, async (schema) => {
    const table = qualify(schema, "batched");
    await ctx.pool.execute(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
    await ctx.pool.batch([
      { text: `INSERT INTO ${table} (id) VALUES (1)` },
      { text: `INSERT INTO ${table} (id) VALUES (2)` },
    ]);
    const rows = await ctx.pool.execute(`SELECT id::text FROM ${table} ORDER BY id`);
    expect(rows.rows.map((row) => row[0])).toEqual(["1", "2"]);
  });
}

async function streamCursor(ctx: CaseContext): Promise<void> {
  const stream = ctx.pool.stream;
  if (stream === undefined) throw new Error("stream was declared without stream()");
  const chunks: (readonly (readonly (string | null)[])[])[] = [];
  for await (const chunk of stream("SELECT n::text FROM generate_series(1, 5) AS g(n)")) {
    chunks.push(chunk);
  }
  const rows = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  expect(rows).toBe(5);
  expect(chunks.length).toBeGreaterThan(1);
}

async function listenNotify(ctx: CaseContext): Promise<void> {
  const listen = ctx.pool.listen;
  const notify = ctx.pool.notify;
  if (listen === undefined || notify === undefined)
    throw new Error("listen was declared without listen()");
  const channel = `c${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const payloads: string[] = [];
  const unlisten = await listen(channel, (payload) => {
    payloads.push(payload);
  });
  try {
    await notify(channel, "ping");
    const deadline = performance.now() + 1000;
    while (payloads.length === 0 && performance.now() < deadline) {
      await delay(15);
    }
    expect(payloads).toEqual(["ping"]);
  } finally {
    await unlisten();
  }
}

async function describeQuery(ctx: CaseContext): Promise<void> {
  const describe = ctx.pool.describe;
  if (describe === undefined) throw new Error("describe was declared without describe()");
  const described = await describe("SELECT $1::int AS n, $2::text AS label", ["1", "a"]);
  expect(described.columns).toEqual(["n", "label"]);
  expect(described.parameterCount).toBe(2);
}

async function prepared(ctx: CaseContext, mode: PreparedMode): Promise<void> {
  await withSchema(ctx.pool, async (schema) => {
    const table = qualify(schema, "prep");
    const fn = qualify(schema, "capture");
    await ctx.pool.execute(
      `CREATE TABLE ${table} (
        id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        marker text NOT NULL,
        names text NOT NULL,
        seen text NOT NULL
      )`,
    );
    await ctx.pool.execute(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $body$
       DECLARE found text;
       BEGIN
         SELECT coalesce(string_agg(CASE WHEN name = '' THEN '<unnamed>' ELSE name END, ','), '<none>')
           INTO found
         FROM pg_prepared_statements
         WHERE statement LIKE '%' || NEW.marker || '%';
         NEW.names := found;
         NEW.seen := current_query();
         RETURN NEW;
       END;
       $body$`,
    );
    await ctx.pool.execute(
      `CREATE TRIGGER capture BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    const marker = `m${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const inserted = await ctx.pool.execute(
      `INSERT INTO ${table} (marker, names, seen) VALUES ($1, '', '') /* ${marker} */ RETURNING names, seen`,
      [marker],
      { prepared: mode },
    );
    const names = inserted.rows[0]?.[0] ?? "";
    const seen = inserted.rows[0]?.[1] ?? "";
    expect(classifyPrepared(names, seen, marker)).toBe(mode);
  });
}

async function statsShape(ctx: CaseContext): Promise<void> {
  await ctx.pool.execute("SELECT 1");
  const stats = ctx.pool.stats();
  expect(stats.size).toBeGreaterThan(0);
  expect(stats.idle).toBeGreaterThanOrEqual(0);
  expect(stats.inflight).toBeGreaterThanOrEqual(0);
  expect(stats.waiting).toBeGreaterThanOrEqual(0);
  expect(stats.idle).toBeLessThanOrEqual(stats.size);
}

async function batchSuccess(ctx: CaseContext): Promise<void> {
  await withSchema(ctx.pool, async (schema) => {
    const table = qualify(schema, "ok");
    await ctx.pool.execute(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
    const results = await ctx.pool.batch([
      { text: `INSERT INTO ${table} (id) VALUES (1) RETURNING id::text` },
      { text: `INSERT INTO ${table} (id) VALUES (2) RETURNING id::text` },
    ]);
    expect(results.map((result) => result.rows[0]?.[0])).toEqual(["1", "2"]);
    const stored = await ctx.pool.execute(`SELECT id::text FROM ${table} ORDER BY id`);
    expect(stored.rows.map((row) => row[0])).toEqual(["1", "2"]);
  });
}

async function batchFailure(ctx: CaseContext): Promise<void> {
  await withSchema(ctx.pool, async (schema) => {
    const table = qualify(schema, "fail");
    await ctx.pool.execute(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
    for (const index of [0, 1, 2]) {
      await ctx.pool.execute(`DELETE FROM ${table}`);
      const statements: Statement[] = [0, 1, 2].map((position) =>
        position === index
          ? { text: "SELECT 1/0" }
          : { text: `INSERT INTO ${table} (id) VALUES (${String(position + 1)})` },
      );
      const error = await catchError(() => ctx.pool.batch(statements));
      expect(error).toBeInstanceOf(DriverError);
      if (error instanceof DriverError) expect(error.batchIndex).toBe(index);
      const left = await ctx.pool.execute(`SELECT count(*)::text FROM ${table}`);
      expect(left.rows[0]?.[0]).toBe("0");
    }
  });
}

async function batchDeferred(ctx: CaseContext): Promise<void> {
  await withSchema(ctx.pool, async (schema) => {
    const table = qualify(schema, "later");
    await ctx.pool.execute(
      `CREATE TABLE ${table} (id int, CONSTRAINT later_pkey PRIMARY KEY (id) DEFERRABLE INITIALLY DEFERRED)`,
    );
    const error = await catchError(() =>
      ctx.pool.batch([
        { text: `INSERT INTO ${table} (id) VALUES (1)` },
        { text: `INSERT INTO ${table} (id) VALUES (1)` },
      ]),
    );
    expect(error).toBeInstanceOf(DriverError);
    if (error instanceof DriverError) {
      expect(error.batchIndex).toBeNull();
      expect(error.sqlstate).toBe("23505");
    }
    const left = await ctx.pool.execute(`SELECT count(*)::text FROM ${table}`);
    expect(left.rows[0]?.[0]).toBe("0");
  });
}

async function batchSequences(ctx: CaseContext): Promise<void> {
  await withSchema(ctx.pool, async (schema) => {
    const sequence = qualify(schema, "ids");
    const table = qualify(schema, "sequenced");
    await ctx.pool.execute(`CREATE SEQUENCE ${sequence}`);
    await ctx.pool.execute(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
    const error = await catchError(() =>
      ctx.pool.batch([
        { text: `SELECT nextval('${sequence}')` },
        { text: `INSERT INTO ${table} (id) VALUES (1)` },
        { text: `INSERT INTO ${table} (id) VALUES (1)` },
      ]),
    );
    expect(error).toBeInstanceOf(DriverError);
    if (error instanceof DriverError) expect(error.batchIndex).toBe(2);
    const left = await ctx.pool.execute(`SELECT count(*)::text FROM ${table}`);
    expect(left.rows[0]?.[0]).toBe("0");
    const value = await ctx.pool.execute(`SELECT last_value::text FROM ${sequence}`);
    expect(Number(value.rows[0]?.[0] ?? "0")).toBeGreaterThan(0);
  });
}

async function batchCancel(ctx: CaseContext): Promise<void> {
  await withSchema(ctx.pool, async (schema) => {
    const table = qualify(schema, "cancel");
    await ctx.pool.execute(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
    const signal = new AbortController();
    const started = performance.now();
    const pending = ctx.pool.batch(
      [{ text: `INSERT INTO ${table} (id) VALUES (1)` }, { text: "SELECT pg_sleep(8)" }],
      { signal: signal.signal },
    );
    setTimeout(() => signal.abort(), 40);
    const error = await catchError(() => pending);
    const elapsed = performance.now() - started;
    expect(error).toBeInstanceOf(DriverCallError);
    if (error instanceof DriverCallError) expect(error.kind).toBe("cancelled");
    expect(elapsed).toBeLessThan(1500);
    const left = await ctx.pool.execute(`SELECT count(*)::text FROM ${table}`);
    expect(left.rows[0]?.[0]).toBe("0");
    ctx.note("batchCancelMs", Math.round(elapsed));
  });
}

async function batchTimeout(ctx: CaseContext): Promise<void> {
  await withSchema(ctx.pool, async (schema) => {
    const table = qualify(schema, "timed");
    await ctx.pool.execute(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
    const started = performance.now();
    const error = await catchError(() =>
      ctx.pool.batch(
        [{ text: `INSERT INTO ${table} (id) VALUES (1)` }, { text: "SELECT pg_sleep(8)" }],
        { timeout: 80 },
      ),
    );
    const elapsed = performance.now() - started;
    expect(error).toBeInstanceOf(DriverCallError);
    if (error instanceof DriverCallError) expect(error.kind).toBe("cancelled");
    expect(elapsed).toBeLessThan(1500);
    const left = await ctx.pool.execute(`SELECT count(*)::text FROM ${table}`);
    expect(left.rows[0]?.[0]).toBe("0");
    ctx.note("batchTimeoutMs", Math.round(elapsed));
  });
}

async function batchSavepoint(ctx: CaseContext): Promise<void> {
  const tx = ctx.pool.tx;
  if (tx === undefined) throw new Error("savepoint case requires tx");
  await withSchema(ctx.pool, async (schema) => {
    const table = qualify(schema, "saved");
    await ctx.pool.execute(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
    await tx(async (connection) => {
      await connection.execute(`INSERT INTO ${table} (id) VALUES (1)`);
      const error = await catchError(() =>
        connection.batch([
          { text: `INSERT INTO ${table} (id) VALUES (2)` },
          { text: `INSERT INTO ${table} (id) VALUES (2)` },
        ]),
      );
      expect(error).toBeInstanceOf(DriverError);
      if (error instanceof DriverError) expect(error.batchIndex).toBe(1);
      await connection.execute(`INSERT INTO ${table} (id) VALUES (3)`);
    });
    const rows = await ctx.pool.execute(`SELECT id::text FROM ${table} ORDER BY id`);
    expect(rows.rows.map((row) => row[0])).toEqual(["1", "3"]);
  });
}

async function batchOutcome(ctx: CaseContext): Promise<void> {
  const terminate = ctx.terminate;
  if (terminate === null) throw new Error("outcome case requires terminate");
  await withSchema(ctx.pool, async (schema) => {
    const table = qualify(schema, "killed");
    await ctx.pool.execute(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
    const marker = `p06k${crypto.randomUUID().replaceAll("-", "")}`;
    const started = performance.now();
    const pending = ctx.pool.batch([
      { text: `INSERT INTO ${table} (id) VALUES (1)` },
      { text: `SELECT pg_sleep(8) /* ${marker} */` },
    ]);
    const captured = catchError(() => pending);
    const pid = await terminate(marker);
    const error = await captured;
    const elapsed = performance.now() - started;
    expect(pid).toBeGreaterThan(0);
    expect(error).toBeInstanceOf(DriverCallError);
    if (error instanceof DriverCallError) expect(error.kind).toBe("outcome_unknown");
    expect(error).not.toBeInstanceOf(DriverError);
    const left = await ctx.pool.execute(`SELECT count(*)::text FROM ${table}`);
    ctx.note("outcomeRows", left.rows[0]?.[0] ?? "missing");
    ctx.note("outcomeMs", Math.round(elapsed));
    await ctx.pool.execute("SELECT 1");
  });
}

async function withSchema(pool: DriverPool, fn: (schema: string) => Promise<void>): Promise<void> {
  const schema = isolatedSchemaName();
  await pool.execute(`CREATE SCHEMA ${quoteIdent(schema)}`);
  try {
    await fn(schema);
  } finally {
    await pool
      .execute(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
      .catch(() => undefined);
  }
}

function classifyPrepared(names: string, seen: string, marker: string): PreparedMode {
  if (names !== "<none>" && names !== "<unnamed>" && names.length > 0) return "named";
  if (seen.includes("$1")) return "unnamed";
  if (seen.includes(`'${marker}'`)) return "none";
  throw new Error(`unclassified prepared result names=${names} seen=${seen}`);
}

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
