/**
 * Neon HTTP mode for `okmodel/pg/neon`.
 *
 * Loaded by `open` only for `mode: "http"`, so a WebSocket app does not carry it.
 */

import { neon, type HTTPQueryOptions, type NeonQueryFunction } from "@neondatabase/serverless";

import { OkmError } from "../../contracts/error.js";
import type { DriverPool, ExecuteResult, WireValue } from "../../contracts/driver.js";
import { NEON_HTTP_CAPABILITIES } from "../capabilities.js";
import { outcomeUnknown } from "../error.js";
import { mapFailure, rejectClosed } from "../failure.js";
import { runCall } from "./call.js";
import { WIRE, statsOf, type Counters, type NeonConfig } from "./neon.js";
import { noTimeout } from "./no-inflight-timeout.js";
import { EMPTY_NOTICES, resultFrom } from "./result.js";

/** HTTP client with array rows and a full result. */
type HttpSql = NeonQueryFunction<true, true>;

/**
 * HTTP query options. `neon()` ignores `types`. The driver reads it per query.
 */
const HTTP_QUERY: HTTPQueryOptions<true, true> = {
  arrayMode: true,
  fullResults: true,
  types: WIRE,
};

/**
 * Opens an HTTP pool. One request per statement, and `batch` is the driver's
 * non-interactive transaction. No socket is opened.
 *
 * @param config - URL and pool size
 * @returns The pool
 */
export function openHttp(config: NeonConfig): DriverPool {
  const max = config.max ?? 10;
  const counters: Counters = { reserved: 0, busy: 0, reservedBusy: 0, waiting: 0 };
  let closed = false;
  const sql: HttpSql = neon(config.url, HTTP_QUERY);
  const run = async (
    text: string,
    params: readonly WireValue[] | undefined,
  ): Promise<ExecuteResult> => {
    counters.busy += 1;
    try {
      const result = await sql.query(text, params === undefined ? [] : [...params], HTTP_QUERY);
      const odd = oddCell(result);
      return odd === undefined ? resultFrom(result, EMPTY_NOTICES) : rejectOdd(odd);
    } finally {
      counters.busy = Math.max(0, counters.busy - 1);
    }
  };

  return {
    capabilities: NEON_HTTP_CAPABILITIES,
    execute(text, params, options) {
      const refused = noTimeout(options);
      if (refused !== undefined) return refused;
      if (closed) return rejectClosed();
      return runCall(closed, options, () =>
        run(text, params).catch((error: unknown) =>
          mapFailure(error).then((mapped) => Promise.reject(mapped)),
        ),
      );
    },
    async batch(statements, options) {
      const refused = noTimeout(options);
      if (refused !== undefined) return refused;
      if (closed) return rejectClosed();
      counters.busy += 1;
      let results: unknown[];
      try {
        const queries = statements.map((statement) =>
          sql.query(
            statement.text,
            statement.params === undefined ? [] : [...statement.params],
            HTTP_QUERY,
          ),
        );
        results = await sql.transaction(queries, HTTP_QUERY);
      } catch (error) {
        if (!isDatabaseError(error)) throw outcomeUnknown(error);
        throw await mapFailure(error);
      } finally {
        counters.busy = Math.max(0, counters.busy - 1);
      }
      for (const result of results) {
        const odd = oddCell(result);
        if (odd !== undefined) return rejectOdd(odd);
      }
      return results.map((result) => resultFrom(result, EMPTY_NOTICES));
    },
    stats: () => statsOf(counters, max),
    close() {
      closed = true;
      return Promise.resolve();
    },
  };
}

/**
 * The first HTTP cell that is not wire text or SQL NULL.
 *
 * {@link HTTP_QUERY} keeps every cell as text, so a value here means the driver
 * parsed it anyway. Reading it as `null` would hide data.
 *
 * @param result - A full HTTP result
 * @returns What the cell is, or `undefined` when every cell is text or null
 */
function oddCell(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const rows: unknown = Reflect.get(result, "rows");
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const cell of row as unknown[]) {
      if (cell === null || typeof cell === "string") continue;
      return typeof cell === "object" ? Object.prototype.toString.call(cell) : typeof cell;
    }
  }
  return undefined;
}

/**
 * Rejects with kind `driver` for a cell that is not wire text.
 *
 * The value is not named: it may be row data.
 *
 * @param odd - What the cell was, such as `[object Date]`
 * @returns A rejected promise
 */
function rejectOdd(odd: string): Promise<never> {
  return Promise.reject(
    new OkmError("driver", `Neon HTTP returned a ${odd} cell instead of wire text.`, {
      kind: "driver",
      fix: {
        summary:
          "Use a @neondatabase/serverless version okmodel supports, and report the version if this persists.",
      },
    }),
  );
}

/** A Postgres SQLSTATE. A connection failure wrapped by the HTTP client has none. */
function isDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}
