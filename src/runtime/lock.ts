/**
 * Row locks on `find` (spec §15): `lock: "update" | "share"` and
 * `wait: "nowait" | "skip"`.
 *
 * A lock lives as long as its transaction, so it exists inside `tx()` only
 * (OKM1830 outside one). The lock clause is the end of the statement and names
 * the table alone (`for update of t`), so a to-one include does not lock the
 * related row. Loaded on the first `find` that names `lock` or `wait`.
 */

import { OkmError, throwNamed } from "../contracts/error.js";
import { attachHttp, decodeRows, readCall, readHandle, type Mods, type Session } from "./client.js";
import { fail, type ArchiveView } from "./plan.js";

const LOCKS = ["update", "share"] as const;
const WAITS = ["nowait", "skip"] as const;

/** A value as the error shows it: a string as is, anything else as JSON. */
function shown(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined");
}

/**
 * Builds the handle for one locking `find`.
 *
 * @param session - Client session. It must belong to a transaction
 * @param table - Table name
 * @param options - `find` options plus `lock` and `wait`
 * @param mods - `.all` reason and presets
 * @param view - Archive visibility
 * @returns A handle that resolves to the locked rows
 */
export function build(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
): Promise<unknown> & Record<string, unknown> {
  try {
    return plan(session, table, options, mods, view);
  } catch (error) {
    throw error instanceof OkmError ? attachHttp(session.http, error) : error;
  }
}

function plan(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
): Promise<unknown> & Record<string, unknown> {
  const { lock, wait, ...rest } = options as Record<string, unknown>;
  if (session.tx === undefined) {
    throw new OkmError("OKM1830", "A row lock needs a transaction. find was called outside tx().", {
      fix: { summary: "Move the find into tx(): the lock lasts until the transaction ends." },
    });
  }
  if (lock === undefined) fail("OKM1121", "wait needs lock: pass lock: update or lock: share.");
  if (typeof lock !== "string" || !LOCKS.includes(lock as (typeof LOCKS)[number])) {
    throwNamed("OKM1120", shown(lock), LOCKS, `lock must be one of: ${LOCKS.join(", ")}.`);
  }
  if (wait !== undefined && (typeof wait !== "string" || !WAITS.includes(wait as never))) {
    throwNamed("OKM1120", shown(wait), WAITS, `wait must be one of: ${WAITS.join(", ")}.`);
  }
  const clause = ` for ${lock} of t${wait === undefined ? "" : wait === "skip" ? " skip locked" : " nowait"}`;
  const call = {
    ...readCall(
      "find",
      table,
      rest,
      mods.all,
      session.scope,
      session.schema.model[table],
      session.schema,
      view,
    ),
    tail(sink: { text(value: string): void; mark(token: string): void }) {
      sink.text(clause);
      sink.mark(`lock:${clause}`);
    },
  };
  return readHandle(session, table, call, mods, (compiled, rows) =>
    decodeRows(compiled, rows, table),
  );
}
