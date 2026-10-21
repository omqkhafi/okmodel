/**
 * Typed `raw(db, sql, params)` (F7-3).
 *
 * Loaded on the first typed raw call, from the lane `raw` reads off a table
 * handle. It finds the statement in the lock, encodes the parameters and
 * decodes the rows with the codecs the typed API uses for each Postgres type,
 * and runs the statement through the same pool path as every other statement.
 * A write goes through `runWrite`, so `onWrite` sees it as a `raw` event.
 *
 * The lock is `.okm/raw.lock.json`, read once per directory, or the value
 * `registerRawLock` was given. A raw statement has no archive filter and no
 * hidden-column guard, and on a schema with tenancy it needs `trusted()`.
 */

import type { ExecuteOptions, ExecuteResult, WireValue } from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";
import { rejected } from "../dialects/pg/misuse.js";
import { rawCodec, type RawCodec, type RawCodecModes } from "../dialects/pg/raw-codec.js";
import { rawStatementKey } from "../dialects/pg/raw-key.js";
import {
  RAW_STALE,
  parseRawLockValue,
  registeredRawLock,
  type RawLock,
  type RawLockStatement,
} from "../dialects/pg/raw-lock.js";
import { artifactDir, readText } from "./artifact-file.js";
import { settleCall, withHttp, type Session } from "./client.js";
import { runSafety, safetyInstalled, type SafetyHatch } from "./safety-hook.js";
import { runWrite, type WriteObserveMeta } from "./tx.js";

type Columns = readonly {
  readonly name: string;
  readonly pgType: string;
  readonly decode: RawCodec["decode"];
}[];

type Codecs = {
  readonly bigint: string | undefined;
  readonly numeric: string | undefined;
  readonly params: readonly RawCodec[];
  readonly columns: Columns;
};

const locks = new Map<string, Promise<RawLock>>();
const codecs = new WeakMap<RawLockStatement, Codecs>();

/**
 * Runs one locked statement.
 *
 * @param session - Client session from the lane (a transaction's session inside `tx()`)
 * @param sql - The SQL literal
 * @param params - One value per `$n`
 * @param trust - The reason `trusted()` stored, or anything else when it was not used
 * @returns One object per row
 */
export async function runTypedRaw(
  session: object,
  sql: string,
  params: unknown,
  trust: unknown,
): Promise<readonly unknown[]> {
  const live = session as Session;
  const reason = typeof trust === "string" ? trust : undefined;
  const scope = live.scope;
  const unscoped = scope !== undefined && "unscoped" in scope ? scope.unscoped : undefined;
  if (live.schema.tenancy !== undefined && reason === undefined && unscoped === undefined) {
    throw refuse(
      live,
      "OKM1702",
      "Typed raw SQL has no tenant predicate, so a tenant client refuses it.",
      'Pass trusted(client, "reason") to run it on purpose, or use the table API, which adds the tenant predicate.',
    );
  }
  if (safetyInstalled()) {
    const hatches: SafetyHatch[] = [];
    if (reason !== undefined) hatches.push({ name: "trusted", reason });
    if (unscoped !== undefined) hatches.push({ name: "unscoped", reason: unscoped });
    runSafety([], hatches.length === 0 ? undefined : hatches);
  }
  await live.connected;
  const statement = await lockedStatement(live, sql);
  const bound = codecsOf(live, statement);
  if (!Array.isArray(params) || params.length !== bound.params.length) {
    const got = Array.isArray(params) ? String(params.length) : "no list of";
    throw refuse(
      live,
      "OKM1602",
      `This raw statement takes ${String(bound.params.length)} parameters. Received ${got}.`,
      "Pass one value per $n placeholder, in order, as an array.",
    );
  }
  const wire = encodeParams(bound.params, params);
  const result = await execute(live, statement, wire, reason);
  return decodeRows(live, bound.columns, result.rows);
}

async function lockedStatement(session: Session, sql: string): Promise<RawLockStatement> {
  const lock = registeredRawLock() ?? (await readLock(session));
  const statement = lock.statements[rawStatementKey(sql)];
  if (statement !== undefined) return statement;
  const shown = sql.length > 80 ? `${sql.slice(0, 77)}...` : sql;
  throw stale(session, `This raw statement is not in the lock: ${shown}`);
}

function readLock(session: Session): Promise<RawLock> {
  const path = `${artifactDir(session.dir)}/raw.lock.json`;
  let pending = locks.get(path);
  if (pending === undefined) {
    pending = loadLock(session, path);
    locks.set(path, pending);
    pending.catch(() => {
      if (locks.get(path) === pending) locks.delete(path);
    });
  }
  return pending;
}

async function loadLock(session: Session, path: string): Promise<RawLock> {
  const text = await readText(path);
  if (text === undefined) {
    throw stale(session, `${path} is missing, and no lock was registered with registerRawLock.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw stale(session, `${path} is not valid JSON.`);
  }
  const parsed = parseRawLockValue(value);
  if (parsed === undefined) {
    throw stale(session, `${path} is not a typed raw lock (version 1).`);
  }
  return parsed;
}

function codecsOf(session: Session, statement: RawLockStatement): Codecs {
  const modes = Reflect.get(session.schema, "codecs") as RawCodecModes | undefined;
  const found = codecs.get(statement);
  if (found !== undefined && found.bigint === modes?.bigint && found.numeric === modes?.numeric) {
    return found;
  }
  const made: Codecs = {
    bigint: modes?.bigint,
    numeric: modes?.numeric,
    params: statement.params.map((param) => rawCodec(param.pgType, param.enumLabels, modes)),
    columns: statement.columns.map((column) => ({
      name: column.name,
      pgType: column.pgType,
      decode: rawCodec(column.pgType, column.enumLabels, modes).decode,
    })),
  };
  codecs.set(statement, made);
  return made;
}

function encodeParams(
  codec: readonly RawCodec[],
  values: readonly unknown[],
): readonly (string | null)[] {
  const wire: (string | null)[] = [];
  for (let index = 0; index < codec.length; index += 1) {
    const value = values[index];
    const place = `$${String(index + 1)}`;
    if (value === undefined) rejected(`Parameter ${place} is undefined. Pass null for SQL null.`);
    if (value === null) {
      wire.push(null);
      continue;
    }
    try {
      wire.push(codec[index]?.encode(value) ?? null);
    } catch (error) {
      if (error instanceof OkmError) rejected(`Parameter ${place}: ${error.message}`);
      throw error;
    }
  }
  return wire;
}

async function execute(
  session: Session,
  statement: RawLockStatement,
  params: readonly (string | null)[],
  reason: string | undefined,
): Promise<ExecuteResult> {
  try {
    if (statement.kind === "write") {
      const meta: WriteObserveMeta = {
        table: null,
        op: "raw",
        tenant: null,
        settings: [],
        source: "raw",
        ...(reason !== undefined ? { tag: `trusted: ${reason}` } : {}),
        ...(/\breturning\b/i.test(statement.sql) ? { returning: true } : {}),
      };
      const [result] = await runWrite(
        session,
        [{ text: statement.sql, params: params as readonly WireValue[] }],
        { route: "primary" },
        undefined,
        [meta],
      );
      if (result === undefined) throw new Error("The write returned no result.");
      return result;
    }
    const timeout = session.timeouts?.statement;
    const options: ExecuteOptions | undefined = timeout === undefined ? undefined : { timeout };
    const result = await session.pool.execute(
      statement.sql,
      params as readonly WireValue[],
      options,
    );
    if (session.hookm !== undefined && result.notices.length > 0) {
      void import("./hookm.js").then((mod) => mod.notices(session.hookm, result.notices));
    }
    return result;
  } catch (error) {
    return settleCall(session, error);
  }
}

function decodeRows(
  session: Session,
  columns: Columns,
  rows: readonly (readonly (string | null)[])[],
): readonly unknown[] {
  const out: unknown[] = [];
  for (const wire of rows) {
    if (wire.length !== columns.length) {
      throw stale(
        session,
        `The statement returned ${String(wire.length)} columns and the lock has ${String(columns.length)}.`,
      );
    }
    const row: Record<string, unknown> = {};
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      if (column === undefined) continue;
      const text = wire[index];
      let value: unknown = null;
      if (text !== null && text !== undefined) {
        try {
          value = column.decode === undefined ? text : column.decode(text);
        } catch (error) {
          throw stale(session, `Column ${column.name} did not decode as ${column.pgType}.`, error);
        }
      }
      if (column.name === "__proto__") {
        Object.defineProperty(row, column.name, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        row[column.name] = value;
      }
    }
    out.push(row);
  }
  return out;
}

function refuse(session: Session, code: string, message: string, fix: string): OkmError {
  return new OkmError(code, message, withHttp(session.http, { fix: { summary: fix } }));
}

function stale(session: Session, message: string, cause?: unknown): OkmError {
  return new OkmError("OKM1601", message, {
    fix: { summary: RAW_STALE.fix },
    ...(cause !== undefined ? { cause } : {}),
    ...(session.http !== undefined ? { http: session.http } : {}),
  });
}
