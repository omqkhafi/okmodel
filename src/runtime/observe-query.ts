/**
 * Per-statement query observer (`okm.observe/1`).
 *
 * Loaded only when `connect({ onQuery })` is set. Reads enter through
 * `runObservedRead`. Writes enter through `holdWrite` / `failWrite` in
 * `runWrite`, then `finishObserved` after the caller decodes. Row counts use
 * `rowCountOf`, the same function as write events.
 */

import type { ExecuteResult, Statement } from "../contracts/driver.js";
import type { ColumnModel, QuerySchema } from "../dialects/pg/model.js";
import { mapPostgresError } from "../dialects/pg/errors.js";
import { OkmError } from "../contracts/error.js";
import { callOptions, failRead, type Session } from "./client.js";
import { observeTagOk, txScope } from "./observe-emit.js";
import { observerBufferOverflow } from "./observe.js";
import { servedBy } from "./served-by.js";
import type {
  QueryError,
  QueryEvent,
  QueryLimit,
  QueryRoute,
  RowCountMode,
} from "./observe-types.js";
import { statementFingerprint, type CallScope, type Plan, type ReadCall } from "./plan.js";
import { rowCountOf, type RunHost, type WriteObserveMeta } from "./tx.js";

const REDACTED = "[redacted]";
const EMPTY_SECRETS: ReadonlySet<string> = new Set();

type Place = { readonly unit: string; readonly seq: number };

type HeldWrite = {
  readonly host: RunHost;
  readonly statements: readonly Statement[];
  readonly observe: readonly WriteObserveMeta[] | undefined;
  readonly queryMs: number;
  readonly places: readonly Place[];
  readonly stack: string | undefined;
};

type QueryHandler = {
  (event: QueryEvent): void | Promise<void>;
  readonly maxPending?: number;
  onObserverError?: (err: unknown, event: QueryEvent) => void;
  readonly observeParams?: boolean;
  readonly observeStack?: boolean;
  readonly tag?: unknown;
};

const heldWrites = new WeakMap<object, HeldWrite>();
const secretBags = new WeakMap<object, ReadonlySet<string>>();
const txUnits = new WeakMap<object, { unit: string; seq: number }>();
const controllers = new WeakMap<object, QueryController>();

let eventSeq = 0;
let unitSeq = 0;

/**
 * Records values that must be redacted from statement parameters.
 *
 * Call before `runWrite` when the observer opted into `params`.
 *
 * @param statements - The array passed to `runWrite`
 * @param schema - Connected schema
 * @param scope - Tenant scope. Its values are redacted, and so are sensitive and hidden values
 * @param bag - Caller input (`where`, insert row, update set)
 */
export function rememberSecrets(
  statements: object,
  schema: QuerySchema,
  scope: CallScope | undefined,
  bag: unknown,
): void {
  secretBags.set(statements, collectSecrets(schema, scope, bag));
}

/**
 * Runs one read, then delivers its query event.
 *
 * A throwing observer cannot change the decoded value.
 *
 * @param session - Client session
 * @param table - Table name
 * @param plan - Compiled statement
 * @param params - Bound parameters
 * @param call - The read
 * @param decode - Turns wire rows into the caller value
 * @returns The decoded value
 */
export async function runObservedRead(
  session: Session,
  table: string,
  plan: Plan,
  params: readonly (string | null)[],
  call: ReadCall,
  decode: (plan: Plan, rows: readonly (readonly (string | null)[])[]) => unknown,
): Promise<unknown> {
  const handler = session.q;
  if (handler === undefined) {
    const result = await session.pool.execute(
      plan.text,
      params,
      callOptions(call, session.timeouts?.statement),
    );
    return decode(plan, result.rows);
  }
  const place = readPlace(session);
  const stack = wantsStack(handler) ? new Error().stack : undefined;
  const started = Date.now();
  let result: ExecuteResult;
  try {
    result = await session.pool.execute(
      plan.text,
      params,
      callOptions(call, session.timeouts?.statement),
    );
  } catch (error) {
    deliver(
      handler,
      readEvent(
        session,
        table,
        plan,
        params,
        call,
        place,
        Date.now() - started,
        null,
        undefined,
        error,
        stack,
      ),
    );
    return failRead(session, table, call, error);
  }
  const queryMs = Date.now() - started;
  if (session.hookm !== undefined && result.notices.length > 0) {
    void import("./hookm.js").then((mod) => mod.notices(session.hookm, result.notices));
  }
  const decodeStarted = Date.now();
  try {
    const value = await decode(plan, result.rows);
    deliver(
      handler,
      readEvent(
        session,
        table,
        plan,
        params,
        call,
        place,
        queryMs,
        Date.now() - decodeStarted,
        result,
        undefined,
        stack,
      ),
    );
    return value;
  } catch (error) {
    deliver(
      handler,
      readEvent(session, table, plan, params, call, place, queryMs, null, result, error, stack),
    );
    return failRead(session, table, call, error);
  }
}

/**
 * Runs a typed raw read and delivers its query event (`op: "raw"`, no table).
 *
 * @param session - Client session
 * @param text - The statement text from the lock
 * @param params - Bound parameters
 * @param run - Sends the statement. It throws the error the caller will see
 * @param decode - Turns wire rows into the caller value
 * @returns The decoded rows
 */
export async function runObservedRaw<T>(
  session: Session,
  text: string,
  params: readonly (string | null)[],
  run: () => Promise<ExecuteResult>,
  decode: (rows: readonly (readonly (string | null)[])[]) => T,
): Promise<T> {
  const handler = session.q as QueryHandler;
  const place = readPlace(session);
  const stack = wantsStack(handler) ? new Error().stack : undefined;
  const started = Date.now();
  const event = (
    queryMs: number,
    decodeMs: number | null,
    result: ExecuteResult | undefined,
    error: unknown,
  ): QueryEvent => {
    const summary = summaryOf("raw", null);
    const counted = readCount(result);
    return baseEvent({
      place,
      table: null,
      op: "raw",
      summary,
      fingerprint: statementFingerprint(text),
      text: sanitizeSql(text, summary),
      queryMs,
      decodeMs,
      rowCount: counted.rowCount,
      rowCountMode: counted.rowCountMode,
      route: routeOf(undefined),
      error: error === undefined ? undefined : describeError(error),
      tag: handlerTag(handler),
      params: eventParams(handler, params, EMPTY_SECRETS),
      stack: eventStack(handler, stack),
    });
  };
  let result: ExecuteResult;
  try {
    result = await run();
  } catch (error) {
    deliver(handler, event(Date.now() - started, null, undefined, error));
    throw error;
  }
  const queryMs = Date.now() - started;
  const decodeStarted = Date.now();
  try {
    const value = decode(result.rows);
    deliver(handler, event(queryMs, Date.now() - decodeStarted, result, undefined));
    return value;
  } catch (error) {
    deliver(handler, event(queryMs, null, result, error));
    throw error;
  }
}

/**
 * Snapshots query events for a write that succeeded.
 *
 * The write unit is still open. Delivery waits until `finishObserved`, so
 * `decodeMs` can include the caller's `finish`.
 *
 * @param host - Pool and observers
 * @param statements - Statements that ran
 * @param observe - Per-statement metadata. Shared with write events
 * @param queryMs - Send-to-result time of the whole batch
 * @param results - Driver results. The stash key
 * @param stack - Captured stack when the observer opted in
 */
export function holdWrite(
  host: RunHost,
  statements: readonly Statement[],
  observe: readonly WriteObserveMeta[] | undefined,
  queryMs: number,
  results: object,
  stack: string | undefined,
): void {
  heldWrites.set(results, {
    host,
    statements,
    observe,
    queryMs,
    places: writePlaces(host, statements.length),
    stack,
  });
}

/**
 * Delivers query events for a write that failed.
 *
 * @param host - Pool and observers
 * @param statements - Statements that were sent
 * @param observe - Per-statement metadata
 * @param queryMs - Time until the driver rejected
 * @param error - The rejection
 * @param stack - Captured stack when the observer opted in
 */
export function failWrite(
  host: RunHost,
  statements: readonly Statement[],
  observe: readonly WriteObserveMeta[] | undefined,
  queryMs: number,
  error: unknown,
  stack: string | undefined,
): void {
  const handler = host.q;
  if (handler === undefined) return;
  const places = writePlaces(host, statements.length);
  const failure = describeError(error);
  for (let index = 0; index < statements.length; index += 1) {
    deliver(
      handler,
      writeEvent(
        host,
        statements,
        observe,
        places,
        queryMs,
        null,
        index,
        undefined,
        failure,
        stack,
      ),
    );
  }
  secretBags.delete(statements);
}

/**
 * Decodes a write, then delivers the query events stashed for `groups`.
 *
 * Without a query observer this is `decode()` and does not read the clock.
 *
 * @param host - Pool and observers
 * @param groups - Result arrays passed to `holdWrite`, in order
 * @param decode - The caller's `finish`
 * @returns The decoded value
 */
export function finishObserved<T>(
  host: RunHost,
  groups: readonly (readonly ExecuteResult[])[],
  decode: () => T,
): T {
  if (host.q === undefined) return decode();
  const started = Date.now();
  try {
    const value = decode();
    settle(groups, Date.now() - started);
    return value;
  } catch (error) {
    failHeld(groups, error);
    throw error;
  }
}

/**
 * Settles tracked `onQuery` promises for one handler.
 *
 * @param handler - The `onQuery` function
 * @returns When every tracked promise has settled
 */
export function flushQuery(handler: object): Promise<void> {
  return controllerFor(handler).flush();
}

/**
 * Replaces string and numeric literals with `?`.
 *
 * `$n` placeholders stay. A comment, a dollar quote, or an unbalanced quote
 * returns `summary` so raw text is never shipped.
 *
 * @param text - Parameterised statement text
 * @param summary - Low-cardinality label used when the text cannot be sanitised
 * @returns Sanitised text, or `summary`
 */
export function sanitizeSql(text: string, summary: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 45 && text.charCodeAt(index + 1) === 45) return summary;
    if (code === 47 && text.charCodeAt(index + 1) === 42) return summary;
    if (
      (code === 69 || code === 101) &&
      text.charCodeAt(index + 1) === 39 &&
      !identBefore(text, index)
    ) {
      const end = scanString(text, index + 1);
      if (end < 0) return summary;
      out += "?";
      index = end;
      continue;
    }
    if (code === 39) {
      const end = scanString(text, index);
      if (end < 0) return summary;
      out += "?";
      index = end;
      continue;
    }
    if (code === 36) {
      let next = index + 1;
      if (next < text.length && isDigit(text.charCodeAt(next))) {
        next += 1;
        while (next < text.length && isDigit(text.charCodeAt(next))) next += 1;
        out += text.slice(index, next);
        index = next;
        continue;
      }
      return summary;
    }
    if (isDigit(code) && !identBefore(text, index)) {
      let next = index + 1;
      while (next < text.length && isDigit(text.charCodeAt(next))) next += 1;
      if (text.charCodeAt(next) === 46 && isDigit(text.charCodeAt(next + 1))) {
        next += 2;
        while (next < text.length && isDigit(text.charCodeAt(next))) next += 1;
      }
      out += "?";
      index = next;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

class QueryController {
  private readonly handler: QueryHandler;
  private readonly pending: Promise<unknown>[] = [];
  private readonly max: number;

  constructor(handler: object) {
    this.handler = handler as QueryHandler;
    const max = this.handler.maxPending;
    this.max = typeof max === "number" && max >= 0 ? max : 10_000;
  }

  deliver(event: QueryEvent): void {
    if (this.pending.length >= this.max) {
      this.report(observerBufferOverflow(), event);
      return;
    }
    let result: void | Promise<void>;
    try {
      result = this.handler(event);
    } catch (error) {
      this.report(error, event);
      return;
    }
    if (result === undefined || typeof result.then !== "function") return;
    const tracked = Promise.resolve(result).then(
      () => undefined,
      (error: unknown) => {
        this.report(error, event);
      },
    );
    this.pending.push(tracked);
    void tracked.finally(() => {
      const at = this.pending.indexOf(tracked);
      if (at >= 0) void this.pending.splice(at, 1);
    });
  }

  flush(): Promise<void> {
    if (this.pending.length === 0) return Promise.resolve();
    const batch = this.pending.splice(0, this.pending.length);
    return Promise.all(batch.map((item) => item.catch(() => undefined))).then(() => undefined);
  }

  private report(error: unknown, event: QueryEvent): void {
    try {
      this.handler.onObserverError?.(error, event);
    } catch {
      // Isolation: the observer cannot change the statement result.
    }
  }
}

function controllerFor(handler: object): QueryController {
  let found = controllers.get(handler);
  if (found === undefined) {
    found = new QueryController(handler);
    controllers.set(handler, found);
  }
  return found;
}

function deliver(handler: object, event: QueryEvent): void {
  try {
    controllerFor(handler).deliver(event);
  } catch {
    // Isolation.
  }
}

function settle(groups: readonly (readonly ExecuteResult[])[], decodeMs: number): void {
  const paired: { readonly item: HeldWrite; readonly group: readonly ExecuteResult[] }[] = [];
  let returning = 0;
  for (const group of groups) {
    const item = heldWrites.get(group);
    if (item === undefined) continue;
    paired.push({ item, group });
    for (let index = 0; index < item.statements.length; index += 1) {
      if (metaAt(item.observe, index)?.returning === true) returning += 1;
    }
  }
  let left = decodeMs;
  let seen = 0;
  for (const { item, group } of paired) {
    const handler = item.host.q;
    heldWrites.delete(group);
    if (handler === undefined) {
      secretBags.delete(item.statements);
      continue;
    }
    for (let index = 0; index < item.statements.length; index += 1) {
      const returns = metaAt(item.observe, index)?.returning === true;
      let share: number | null = null;
      if (returns && returning > 0) {
        seen += 1;
        share = seen === returning ? left : Math.floor(decodeMs / returning);
        left -= share;
      }
      deliver(
        handler,
        writeEvent(
          item.host,
          item.statements,
          item.observe,
          item.places,
          item.queryMs,
          share,
          index,
          group[index],
          undefined,
          item.stack,
        ),
      );
    }
    secretBags.delete(item.statements);
  }
}

function failHeld(groups: readonly (readonly ExecuteResult[])[], error: unknown): void {
  const failure = describeError(error);
  for (const group of groups) {
    const item = heldWrites.get(group);
    if (item === undefined) continue;
    const handler = item.host.q;
    heldWrites.delete(group);
    if (handler === undefined) {
      secretBags.delete(item.statements);
      continue;
    }
    for (let index = 0; index < item.statements.length; index += 1) {
      deliver(
        handler,
        writeEvent(
          item.host,
          item.statements,
          item.observe,
          item.places,
          item.queryMs,
          null,
          index,
          undefined,
          failure,
          item.stack,
        ),
      );
    }
    secretBags.delete(item.statements);
  }
}

function writeEvent(
  host: RunHost,
  statements: readonly Statement[],
  observe: readonly WriteObserveMeta[] | undefined,
  places: readonly Place[],
  queryMs: number,
  decodeMs: number | null,
  index: number,
  result: ExecuteResult | undefined,
  error: QueryError | undefined,
  stack: string | undefined,
): QueryEvent {
  const statement = statements[index];
  const text = statement?.text ?? "";
  const meta = metaAt(observe, index);
  const op = meta?.op ?? opFromSql(text);
  const table = meta?.table ?? null;
  const summary = summaryOf(op, table);
  const counted = rowCountOf(meta, result);
  const place = places[index];
  return baseEvent({
    place,
    table,
    op,
    summary,
    fingerprint: statementFingerprint(text),
    text: sanitizeSql(text, summary),
    queryMs,
    decodeMs,
    rowCount: counted.rowCount,
    rowCountMode: counted.rowCountMode,
    route: { endpoint: "primary", role: "primary" },
    error,
    tag: handlerTag(host.q),
    params: writeParams(host, statements, statement?.params),
    stack: eventStack(host.q, stack),
  });
}

function writeParams(
  host: RunHost,
  statements: readonly Statement[],
  params: readonly (string | null)[] | undefined,
): readonly unknown[] | undefined {
  if ((host.q as { observeParams?: boolean } | undefined)?.observeParams !== true) return undefined;
  return eventParams(host.q, params, secretsFor(host, statements));
}

function readEvent(
  session: Session,
  table: string,
  plan: Plan,
  params: readonly (string | null)[],
  call: ReadCall,
  place: Place | undefined,
  queryMs: number,
  decodeMs: number | null,
  result: ExecuteResult | undefined,
  error: unknown,
  stack: string | undefined,
): QueryEvent {
  const summary = summaryOf(call.op, table);
  const counted = readCount(result);
  const failure = error === undefined ? undefined : describeError(error);
  const limit = limitOf(call);
  return baseEvent({
    place,
    table,
    op: call.op,
    summary,
    fingerprint: plan.fingerprint,
    text: sanitizeSql(plan.text, summary),
    queryMs,
    decodeMs,
    rowCount: counted.rowCount,
    rowCountMode: counted.rowCountMode,
    route: routeOf(call.route, result),
    error: failure,
    tag: handlerTag(session.q),
    limit,
    params: eventParams(session.q, params, readSecrets(session, call)),
    stack: eventStack(session.q, stack),
  });
}

function baseEvent(input: {
  readonly place: Place | undefined;
  readonly table: string | null;
  readonly op: string;
  readonly summary: string;
  readonly fingerprint: string;
  readonly text: string;
  readonly queryMs: number;
  readonly decodeMs: number | null;
  readonly rowCount: number | null;
  readonly rowCountMode: RowCountMode;
  readonly route: QueryRoute;
  readonly error: QueryError | undefined;
  readonly tag: string | undefined;
  readonly limit?: QueryLimit | undefined;
  readonly params: readonly unknown[] | undefined;
  readonly stack: string | undefined;
}): QueryEvent {
  eventSeq += 1;
  const decodeMs = input.decodeMs;
  return {
    id: `q${eventSeq}`,
    ...(input.place !== undefined ? { unit: input.place.unit, seq: input.place.seq } : {}),
    dialect: "postgres",
    table: input.table,
    op: input.op,
    summary: input.summary,
    fingerprint: input.fingerprint,
    text: input.text,
    durationMs: input.queryMs + (decodeMs ?? 0),
    queueMs: null,
    queryMs: input.queryMs,
    decodeMs,
    rowCount: input.rowCount,
    rowCountMode: input.rowCountMode,
    route: input.route,
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.params !== undefined ? { params: input.params } : {}),
    ...(input.stack !== undefined ? { stack: input.stack } : {}),
  };
}

function readCount(result: ExecuteResult | undefined): {
  readonly rowCount: number | null;
  readonly rowCountMode: RowCountMode;
} {
  const reported = result?.reported;
  if (typeof reported !== "number") return { rowCount: null, rowCountMode: "unknown" };
  return { rowCount: reported, rowCountMode: "returned" };
}

function metaAt(
  observe: readonly WriteObserveMeta[] | undefined,
  index: number,
): WriteObserveMeta | undefined {
  if (observe === undefined) return undefined;
  return observe[index] ?? observe[observe.length - 1];
}

function opFromSql(text: string): WriteObserveMeta["op"] {
  const trimmed = text.trimStart().toLowerCase();
  if (trimmed.startsWith("insert")) return /\bon\s+conflict\b/i.test(text) ? "upsert" : "insert";
  if (trimmed.startsWith("update")) return "update";
  if (trimmed.startsWith("delete")) return "delete";
  return "raw";
}

function summaryOf(op: string, table: string | null): string {
  let verb = "SQL";
  switch (op) {
    case "find":
    case "one":
    case "count":
    case "exists":
    case "aggregate":
    case "descendants":
    case "ancestors":
    case "page":
      verb = "SELECT";
      break;
    case "insert":
    case "restore":
      verb = "INSERT";
      break;
    case "update":
    case "archive":
      verb = "UPDATE";
      break;
    case "delete":
      verb = "DELETE";
      break;
    case "upsert":
      verb = "UPSERT";
      break;
    default:
      verb = "SQL";
  }
  return table === null || table.length === 0 ? verb : `${verb} ${table}`;
}

function routeOf(route: ReadCall["route"], result?: ExecuteResult): QueryRoute {
  const served = result === undefined ? undefined : servedBy.get(result);
  if (served !== undefined) return { endpoint: served, role: "replica" };
  if (route === "replica") return { endpoint: "replica", role: "replica" };
  return { endpoint: "primary", role: "primary" };
}

function limitOf(call: ReadCall): QueryLimit | undefined {
  if (call.dl !== undefined) return { value: call.dl[1], source: `limits.${call.dl[0]}` };
  const value = call.limit;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return { value, source: "caller" };
}

function describeError(error: unknown): QueryError {
  const mapped = error instanceof OkmError ? error : mapPostgresError(error);
  return {
    kind: mapped.kind,
    category: mapped.category,
    code: mapped.code,
    ...(mapped.sqlstate !== undefined ? { sqlstate: mapped.sqlstate } : {}),
  };
}

function readPlace(session: Session): Place | undefined {
  const open = session.o?.c?.nextQueryPlace(txScope(session.tx));
  if (open !== undefined) return open;
  if (session.tx !== undefined) return txPlace(session.tx);
  return undefined;
}

function writePlaces(host: RunHost, count: number): Place[] {
  const places: Place[] = [];
  let local: { unit: string; seq: number } | undefined;
  for (let index = 0; index < count; index += 1) {
    const open = host.o?.c?.nextQueryPlace(host.u ?? txScope(host.tx));
    if (open !== undefined) {
      places.push(open);
      continue;
    }
    if (host.tx !== undefined) {
      places.push(txPlace(host.tx));
      continue;
    }
    if (local === undefined) {
      unitSeq += 1;
      local = { unit: `qu${unitSeq}`, seq: 0 };
    }
    places.push({ unit: local.unit, seq: local.seq });
    local.seq += 1;
  }
  return places;
}

function txPlace(tx: object): Place {
  const key = txScope(tx) ?? tx;
  let state = txUnits.get(key);
  if (state === undefined) {
    unitSeq += 1;
    state = { unit: `qu${unitSeq}`, seq: 0 };
    txUnits.set(key, state);
  }
  const place = { unit: state.unit, seq: state.seq };
  state.seq += 1;
  return place;
}

function wantsStack(handler: object | undefined): boolean {
  return (handler as { observeStack?: boolean } | undefined)?.observeStack === true;
}

function handlerTag(handler: object | undefined): string | undefined {
  const value = (handler as { tag?: unknown } | undefined)?.tag;
  return typeof value === "string" && observeTagOk(value) ? value : undefined;
}

function eventStack(handler: object | undefined, stack: string | undefined): string | undefined {
  if (!wantsStack(handler) || stack === undefined || stack.length === 0) return undefined;
  return stack;
}

function eventParams(
  handler: object | undefined,
  params: readonly (string | null)[] | undefined,
  secrets: ReadonlySet<string>,
): readonly unknown[] | undefined {
  if ((handler as { observeParams?: boolean } | undefined)?.observeParams !== true)
    return undefined;
  if (params === undefined || params.length === 0) return [];
  if (secrets.size === 0) return params;
  return params.map((value) => (value !== null && secrets.has(value) ? REDACTED : value));
}

function readSecrets(session: Session, call: ReadCall): ReadonlySet<string> {
  if ((session.q as { observeParams?: boolean } | undefined)?.observeParams !== true) {
    return EMPTY_SECRETS;
  }
  return collectSecrets(session.schema, call.scope ?? session.scope, call.where);
}

function secretsFor(host: object, statements: object): ReadonlySet<string> {
  const noted = secretBags.get(statements);
  if (noted !== undefined) return noted;
  const facts = host as { readonly schema?: QuerySchema; readonly scope?: CallScope };
  if (facts.schema === undefined) return EMPTY_SECRETS;
  return collectSecrets(facts.schema, facts.scope, undefined);
}

function collectSecrets(
  schema: QuerySchema,
  scope: CallScope | undefined,
  bag: unknown,
): ReadonlySet<string> {
  const secrets = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string") secrets.add(value);
    else if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      secrets.add(String(value));
    }
  };
  if (scope !== undefined && "value" in scope) {
    add(scope.value);
    if (scope.values !== undefined) {
      for (const value of Object.values(scope.values)) add(value);
    }
  }
  const fields = new Map<string, ColumnModel["encode"][]>();
  const tenant = new Set<string>();
  if (schema.tenancy !== undefined) {
    tenant.add(schema.tenancy.key);
    const extra = schema.tenancy.keys;
    if (extra !== undefined) for (const key of extra) tenant.add(key);
  }
  for (const model of Object.values(schema.model)) {
    for (const column of model.columns.values()) {
      if (
        column.sensitive ||
        column.hidden === true ||
        column.hidden === "filter" ||
        tenant.has(column.field)
      ) {
        const list = fields.get(column.field);
        if (list === undefined) fields.set(column.field, [column.encode]);
        else list.push(column.encode);
      }
    }
  }
  const walk = (value: unknown, field: string | undefined): void => {
    if (value === null || value === undefined) return;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "boolean"
    ) {
      if (field === undefined) return;
      add(value);
      const encodes = fields.get(field);
      if (encodes === undefined) return;
      for (const encode of encodes) {
        try {
          add(encode(value));
        } catch {
          // A value the codec refuses is still redacted as text above.
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, field);
      return;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        walk(child, fields.has(key) ? key : field);
      }
    }
  };
  walk(bag, undefined);
  return secrets;
}

function identBefore(text: string, index: number): boolean {
  if (index === 0) return false;
  const code = text.charCodeAt(index - 1);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function scanString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text.charCodeAt(index) !== 39) {
      index += 1;
      continue;
    }
    if (text.charCodeAt(index + 1) === 39) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return -1;
}
