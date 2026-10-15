/**
 * OpenTelemetry observers (`okmodel/otel`).
 *
 * The package does not import `@opentelemetry/*`. Pass a tracer you already
 * have. The observers are `hookm`, `onRoute`, and an `inspect()` result.
 * Statement text is off unless `statement` is true. Parameters and tenant ids
 * are never attributes (spec §5.5, D267).
 */

import type { RouteEvent } from "./topology.js";
import type { Hookm, Inspection, TransactionEvent } from "./types.js";

/** A scalar OpenTelemetry attribute. Arrays are not used. */
export type OtelAttribute = string | number | boolean;

/**
 * Status codes from the OpenTelemetry API.
 *
 * `0` is unset, `1` is OK, and `2` is ERROR.
 */
export type OtelStatusCode = 0 | 1 | 2;

/**
 * The span methods this entry calls.
 *
 * A tracer from `@opentelemetry/api` satisfies this shape.
 */
export interface OtelSpan {
  /** Sets one attribute. */
  setAttribute(key: string, value: OtelAttribute): void;
  /** Sets the span status. `message` is never sent. */
  setStatus(status: { readonly code: OtelStatusCode }): void;
  /**
   * Records an exception.
   *
   * `name` is the error name. `code` is an OKM code when the error has one.
   * Message and stack are omitted.
   */
  recordException(exception: { readonly name: string; readonly code?: string }): void;
  /** Adds a span event. */
  addEvent(name: string, attributes?: Readonly<Record<string, OtelAttribute>>): void;
  /** Ends the span. */
  end(): void;
}

/** Options passed to `startSpan`. `kind` is `2` (client). */
export interface OtelSpanOptions {
  /** OpenTelemetry span kind. This entry always passes `2`. */
  readonly kind?: number;
  /** Attributes set when the span starts. */
  readonly attributes?: Readonly<Record<string, OtelAttribute>>;
}

/**
 * The tracer methods this entry calls.
 *
 * A tracer from `@opentelemetry/api` satisfies this shape.
 */
export interface OtelTracer {
  /**
   * Starts a span.
   *
   * @param name - Span name
   * @param options - Kind and attributes
   */
  startSpan(name: string, options?: OtelSpanOptions): OtelSpan;
}

/** What {@link otel} accepts. */
export interface OtelOptions {
  /** Tracer the caller owns. This module does not construct one. */
  readonly tracer: OtelTracer;
  /**
   * Record `db.query.text` from `inspect()`.
   *
   * Omitted or false, the text is left off. Parameters stay off either way.
   */
  readonly statement?: boolean;
}

/**
 * Observers to pass to `connect`, plus `query` for one `inspect()` result.
 */
export interface OtelObservers {
  /** Pass this in `connect({ hookm })`. */
  readonly hookm: Hookm;
  /** Pass this in `connect({ onRoute })`. A topology calls it. */
  readonly onRoute: (event: RouteEvent) => void;
  /**
   * Records `db.query.summary` from `inspect()`.
   *
   * The fingerprint is that summary. `db.query.text` is included only when
   * `statement` is true.
   *
   * @param inspection - The result of `inspect()`
   */
  readonly query: (inspection: Inspection) => void;
}

/** `db.system.name` for every span. */
const SYSTEM = "postgresql";

/** OpenTelemetry `SpanKind.CLIENT`. */
const CLIENT = 2;

/** OpenTelemetry `SpanStatusCode.OK`. */
const STATUS_OK = 1;

/** OpenTelemetry `SpanStatusCode.ERROR`. */
const STATUS_ERROR = 2;

/** One transaction or savepoint span, paired by depth. */
type OpenTx = {
  readonly depth: number;
  readonly span: OtelSpan;
};

/**
 * Connects the existing observers to a tracer.
 *
 * `onRoute` spans start and end in that call, because the hook fires once.
 * A transaction span stays open from `start` until `commit` or `rollback`.
 *
 * @param options - Tracer, and whether statement text is recorded
 * @returns `hookm`, `onRoute`, and `query`
 */
export function otel(options: OtelOptions): OtelObservers {
  const tracer = options.tracer;
  const statement = options.statement === true;
  const open: OpenTx[] = [];

  const hookm: Hookm = {
    onTransaction(event: TransactionEvent): void {
      if (event.phase === "start") {
        const name = event.depth === 0 ? "transaction" : "savepoint";
        open.push({
          depth: event.depth,
          span: begin(tracer, name, {
            "db.system.name": SYSTEM,
            "db.operation.name": name,
          }),
        });
        return;
      }
      const index = latest(open, event.depth);
      const found = index < 0 ? undefined : open[index];
      if (found === undefined) return;
      open.splice(index, 1);
      if (event.phase === "rollback") {
        found.span.setAttribute("error.type", "rollback");
        found.span.setStatus({ code: STATUS_ERROR });
      } else {
        found.span.setStatus({ code: STATUS_OK });
      }
      found.span.end();
    },
    onError(error: unknown): void {
      const span = begin(tracer, "error", {
        "db.system.name": SYSTEM,
        "error.type": errorType(error),
      });
      span.recordException(recordedException(error));
      span.setStatus({ code: STATUS_ERROR });
      span.end();
    },
  };

  return {
    hookm,
    onRoute(event: RouteEvent): void {
      const span = begin(tracer, event.op, {
        "db.system.name": SYSTEM,
        "db.operation.name": event.op,
      });
      span.addEvent("route", { endpoint: event.endpoint, reason: event.reason });
      span.end();
    },
    query(inspection: Inspection): void {
      const op = inspection.intent.op;
      const table = inspection.intent.table;
      const attributes: Record<string, OtelAttribute> = {
        "db.system.name": SYSTEM,
        "db.operation.name": op,
        "db.collection.name": table,
        "db.query.summary": inspection.plan.fingerprint,
      };
      if (statement) attributes["db.query.text"] = inspection.sql.text;
      begin(tracer, `${op} ${table}`, attributes).end();
    },
  };
}

/**
 * Starts a client span.
 *
 * @param tracer - Caller-supplied tracer
 * @param name - Span name
 * @param attributes - `db.*` attributes
 */
function begin(
  tracer: OtelTracer,
  name: string,
  attributes: Readonly<Record<string, OtelAttribute>>,
): OtelSpan {
  return tracer.startSpan(name, { kind: CLIENT, attributes });
}

/**
 * Index of the latest open span at `depth`, or `-1`.
 *
 * The transaction event has no span id, so overlapping work at one depth
 * pairs last-in, first-out.
 *
 * @param open - Spans still running
 * @param depth - 0 for the transaction, 1 and up for savepoints
 */
function latest(open: readonly OpenTx[], depth: number): number {
  for (let index = open.length - 1; index >= 0; index -= 1) {
    if (open[index]?.depth === depth) return index;
  }
  return -1;
}

/**
 * Exception type for `error.type`.
 *
 * @param error - What `onError` received
 */
function errorType(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : "error";
}

/**
 * Name, and an OKM code when the error has one.
 *
 * The message and the stack stay off. A driver message can name a key and a value.
 *
 * @param error - What `onError` received
 */
function recordedException(error: unknown): { readonly name: string; readonly code?: string } {
  const name = errorType(error);
  const code = okmCode(error);
  return code === undefined ? { name } : { name, code };
}

/**
 * The OKM code on `error`, when that property is one.
 *
 * @param error - What `onError` received
 */
function okmCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" && /^OKM\d+$/.test(code) ? code : undefined;
}
