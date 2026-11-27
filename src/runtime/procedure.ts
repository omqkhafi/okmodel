/**
 * `CALL` for `fn({ kind: "procedure" }).run`.
 *
 * Loaded from the client slot `Symbol.for("okm.procedure")`. A featureless
 * app does not import this module. The dialect builds the quoted spec, so
 * this file does not import the dialect at startup.
 */

import { OkmError, type OkmErrorOptions } from "../contracts/error.js";
import type { Session } from "./client.js";

/** One argument the dialect already quoted. */
type SpecArg = {
  readonly name: string;
  readonly quoted: string;
  readonly sqlType: string;
  readonly mode: "in" | "out" | "inout";
  readonly hasDefault: boolean;
  readonly encode: (value: unknown) => string;
  readonly decode: (wire: string) => unknown;
};

/** What `run` passes across the client slot. */
type Spec = {
  readonly label: string;
  readonly schema: string;
  readonly name: string;
  readonly commits: boolean;
  readonly raises: Readonly<Record<string, string>>;
  readonly arguments: readonly SpecArg[];
};

type RunOptions = {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
  readonly onNotice?: (notice: {
    readonly severity: string;
    readonly code?: string;
    readonly message: string;
  }) => void;
};

/**
 * Decodes one OUT value.
 *
 * `bigint` and `numeric` arrive as strings. A `Date` is accepted before the
 * codec: some drivers parse `timestamptz` into a `Date`, and the codec then
 * returns the mode the column builder declared.
 *
 * @param value - One cell from `CALL`
 * @param decode - The argument's codec
 * @returns The application value, or null
 */
export function decodeProcedureValue(value: unknown, decode: (wire: string) => unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return decode(value.toISOString());
  if (typeof value === "string") return decode(value);
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") {
    return decode(String(value));
  }
  throw new OkmError("OKM1210", "A procedure result cell is not text, a number, or a date.", {
    fix: { summary: "OUT values are decoded from the text the driver returns." },
  });
}

/**
 * Runs `CALL` for one procedure.
 *
 * A committing procedure is refused when the client is inside a transaction,
 * before any SQL is sent.
 *
 * @param session - The connected client
 * @param spec - Quoted signature from `fn()`
 * @param args - `IN` and `INOUT` values by name
 * @param options - Timeout, signal, and notices
 * @returns `OUT` and `INOUT` values, or `undefined` when there are none
 */
export async function runProcedure(
  session: Session,
  spec: unknown,
  args: unknown,
  options: unknown,
): Promise<unknown> {
  const routine = readSpec(spec);
  const call = readOptions(options);
  await session.connected;
  if (routine.arguments.some((argument) => /time|date|interval/i.test(argument.sqlType))) {
    await (await import("../dialects/pg/time.js")).loadTimeCodecs();
  }
  if (routine.commits && session.tx !== undefined) {
    throw new OkmError(
      "OKM1551",
      `Procedure ${routine.label} commits, so run() refuses a transaction (2D000).`,
      { fix: { summary: "Call it on the client, outside db.tx()." } },
    );
  }
  const record = readArgs(routine, args);
  const params: (string | null)[] = [];
  const parts: string[] = [];
  for (const argument of routine.arguments) {
    if (argument.mode === "out") {
      parts.push(`${argument.quoted} => null::${argument.sqlType}`);
      continue;
    }
    if (!Object.hasOwn(record, argument.name)) {
      if (argument.hasDefault) continue;
      throw new OkmError("OKM1120", `Procedure ${routine.label} needs ${argument.name}.`, {
        fix: { summary: "Pass the argument, or declare a default." },
      });
    }
    const value = record[argument.name];
    params.push(value === null ? null : argument.encode(value));
    parts.push(`${argument.quoted} => $${String(params.length)}::${argument.sqlType}`);
  }
  const sql = `call ${routine.schema}.${routine.name}(${parts.join(", ")})`;
  let result;
  try {
    result = await session.pool.execute(sql, params, {
      ...(call.timeout !== undefined ? { timeout: call.timeout } : {}),
      ...(call.signal !== undefined ? { signal: call.signal } : {}),
    });
  } catch (error) {
    throw await annotate(routine, error);
  }
  if (result.notices.length > 0) {
    if (call.onNotice !== undefined) {
      for (const notice of result.notices) call.onNotice(notice);
    }
    if (session.hookm !== undefined) {
      const hookm = session.hookm;
      const notices = result.notices;
      void import("./hookm.js").then((mod) => mod.notices(hookm, notices));
    }
  }
  const outs = routine.arguments.filter((argument) => argument.mode !== "in");
  if (outs.length === 0) return undefined;
  const row = result.rows[0];
  if (row === undefined) {
    throw new OkmError("OKM1121", `Procedure ${routine.label} returned no OUT row.`, {
      fix: { summary: "The CALL result has one column per OUT and INOUT argument." },
    });
  }
  const out: Record<string, unknown> = {};
  for (let index = 0; index < outs.length; index += 1) {
    const argument = outs[index];
    if (argument === undefined) continue;
    out[argument.name] = decodeProcedureValue(row[index], argument.decode);
  }
  return out;
}

function readSpec(value: unknown): Spec {
  if (typeof value !== "object" || value === null || !("arguments" in value)) {
    throw new OkmError("OKM1120", "run() received a procedure it cannot call.", {
      fix: { summary: "Call run on the object fn() returned." },
    });
  }
  return value as Spec;
}

function readOptions(value: unknown): RunOptions {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null) {
    throw new OkmError("OKM1120", "run() options must be an object.", {
      fix: { summary: "Pass { timeout, signal, onNotice } or omit them." },
    });
  }
  return value as RunOptions;
}

function readArgs(routine: Spec, value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OkmError("OKM1120", `Procedure ${routine.label} takes arguments by name.`, {
      fix: { summary: "Pass { name: value }." },
    });
  }
  return value as Record<string, unknown>;
}

async function annotate(routine: Spec, error: unknown): Promise<OkmError> {
  if (error instanceof OkmError) return tag(routine, error);
  const { mapPostgresError } = await import("../dialects/pg/errors.js");
  return tag(routine, mapPostgresError(error));
}

function tag(routine: Spec, error: OkmError): OkmError {
  const name = error.sqlstate === undefined ? undefined : routine.raises[error.sqlstate];
  if (name === undefined) return error;
  const options: OkmErrorOptions = {
    kind: error.kind,
    fix: error.fix,
    ...(error.table !== undefined ? { table: error.table } : {}),
    ...(error.columns.length > 0 ? { columns: error.columns } : {}),
    ...(error.constraint !== undefined ? { constraint: error.constraint } : {}),
    ...(error.sqlstate !== undefined ? { sqlstate: error.sqlstate } : {}),
    ...(error.detail !== undefined ? { detail: error.detail } : {}),
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
    raised: name,
    cause: error,
  };
  return new OkmError(error.code, error.message, options);
}
