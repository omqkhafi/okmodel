/**
 * Public `batch` (spec §15, batch contract).
 *
 * Plans each operation, joins their statements, and runs them as one atomic
 * unit on the primary. Results come back in the order given. A failure rolls
 * everything back and the error carries `batchIndex`, the failing operation,
 * or `null` when the commit failed. Inside `tx()` the unit is a savepoint, so
 * the transaction survives. Loaded the first time a batch is awaited.
 */

import type { ExecuteOptions, Statement } from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";
import { settleCall, withHttp, type Session } from "./client.js";
import { fail, isRecord, rejectKeys } from "./plan.js";
import { runWrite } from "./tx.js";
import type { PreparedWrite } from "./write.js";

/** A write handle, as `batch` reads it: it can plan itself without running. */
type Op = { readonly "~plan"?: () => Promise<PreparedWrite> };

/**
 * Runs write handles as one atomic unit.
 *
 * @param session - Client session
 * @param ops - Write handles: `insert`, `update`, `delete`, `archive`, `restore`
 * @param options - `signal` and `timeout` for the whole batch
 * @param replica - Set by `.replica()`. A batch needs the primary (OKM1840)
 * @returns One result per operation, in order
 */
export async function batch(
  session: Session,
  ops: unknown,
  options: object | undefined,
  replica: true | undefined,
): Promise<readonly unknown[]> {
  try {
    if (replica !== undefined) {
      throw new OkmError(
        "OKM1840",
        "batch() needs the primary. .replica() is not allowed on a batch.",
        withHttp(session.http, {
          fix: { summary: "Remove .replica(). A batch always runs on the primary." },
        }),
      );
    }
    if (!Array.isArray(ops)) fail("OKM1121", "batch expects a list of write operations.");
    const record = options ?? {};
    if (!isRecord(record)) fail("OKM1121", "batch options must be an object.");
    rejectKeys(record, ["signal", "timeout"], "batch");
    const prepared: PreparedWrite[] = [];
    for (const op of ops as readonly Op[]) {
      const plan = typeof op === "object" && op !== null ? op["~plan"] : undefined;
      if (plan === undefined) {
        fail(
          "OKM1121",
          "batch takes write operations: insert, update, delete, archive, and restore. Pass them without awaiting.",
        );
      }
      prepared.push(await plan());
    }
    return await run(session, prepared, record);
  } catch (error) {
    return settleCall(session, error);
  }
}

async function run(
  session: Session,
  prepared: readonly PreparedWrite[],
  options: Record<string, unknown>,
): Promise<readonly unknown[]> {
  await session.connected;
  const statements: Statement[] = [];
  const starts: number[] = [];
  for (const item of prepared) {
    starts.push(statements.length);
    statements.push(...item.statements);
  }
  if (statements.length === 0) return prepared.map((item) => item.finish([]));
  let results;
  try {
    results = await runWrite(session, statements, call(options), true);
  } catch (error) {
    throw at(error, starts);
  }
  return prepared.map((item, index) => {
    const from = starts[index] ?? 0;
    return item.finish(results.slice(from, from + item.statements.length));
  });
}

function call(options: Record<string, unknown>): ExecuteOptions | undefined {
  const { signal, timeout } = options;
  if (signal === undefined && timeout === undefined) return undefined;
  return {
    ...(signal !== undefined ? { signal: signal as AbortSignal } : {}),
    ...(typeof timeout === "number" ? { timeout } : {}),
  };
}

/** Turns the failing statement's index into the failing operation's index. */
function at(error: unknown, starts: readonly number[]): unknown {
  const failed = (error as { readonly batchIndex?: unknown } | null)?.batchIndex;
  const move = (error as { readonly at?: (index: number | null) => unknown } | null)?.at;
  if (typeof failed !== "number" || typeof move !== "function") return error;
  let index = 0;
  while (index + 1 < starts.length && (starts[index + 1] ?? Infinity) <= failed) index += 1;
  return index === failed ? error : move.call(error, index);
}
