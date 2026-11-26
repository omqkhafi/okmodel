/**
 * Waiting for a lock, and naming who holds it.
 *
 * One helper retries a step on SQLSTATE 55P03 and nothing else. Each attempt
 * is a new transaction, or a new statement outside one, so a failed attempt
 * leaves nothing behind. While an attempt is blocked, a second session reads
 * `pg_blocking_pids` once. When the wait ends, the holders it saw are on the
 * error. Nothing here cancels or ends a session.
 */

import type { DriverPool } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";

/** `application_name` the apply connection carries. */
export const APPLY_APPLICATION = "okm apply";

/** Total time `--lock-wait` keeps retrying when nothing else says. */
export const DEFAULT_LOCK_WAIT_MS = 120_000;

const OUTCOME = Symbol.for("okm.migrate.lockOutcome");
const POLL_MS = 250;
const PAUSE_MS = 50;
const PAUSE_CAP_MS = 500;
const NOTE_EVERY = 10;
const MAX_NAMED = 5;
const CONTROL = /\p{Cc}/gu;

/** What kind of session holds the lock. */
export const HOLDER_KINDS = [
  "okm-apply",
  "autovacuum",
  "prepared-transaction",
  "idle-in-transaction",
  "active",
  "other",
] as const;

/** One kind from {@link HOLDER_KINDS}. */
export type HolderKind = (typeof HOLDER_KINDS)[number];

/**
 * One holder. `pid` is 0 for a prepared transaction, which has no session.
 *
 * `query` and `gid` are for a terminal. They never reach `--json` or a log.
 */
export type LockHolder = {
  readonly pid: number;
  readonly application: string;
  readonly state: string;
  readonly ageMs: number | null;
  readonly kind: HolderKind;
  readonly query?: string;
  readonly gid?: string;
};

/** What a step that gave up on a lock leaves on its error. */
export type LockOutcome = {
  readonly attempts: number;
  readonly waitedMs: number;
  readonly blockedBy: readonly LockHolder[];
  /** The statement had already run when the wait gave up. */
  readonly ran: boolean;
  /** An earlier step or batch of this run is committed. */
  readonly earlier: boolean;
};

/** Locks this run waited for, over every step. */
export type LockTally = { attempts: number; waitedMs: number };

/** The `blockedBy` entry in `--json`. */
export type HolderBody = Pick<LockHolder, "pid" | "application" | "state" | "ageMs" | "kind">;

/**
 * Fields `--json` carries for a step that gave up.
 *
 * @param outcome - What the wait left on the error
 * @returns `attempts`, `waitedMs`, and `blockedBy`. No query text
 */
export function lockBody(outcome: LockOutcome): {
  readonly attempts: number;
  readonly waitedMs: number;
  readonly blockedBy: readonly HolderBody[];
} {
  return {
    attempts: outcome.attempts,
    waitedMs: outcome.waitedMs,
    blockedBy: outcome.blockedBy.map(({ pid, application, state, ageMs, kind }) => ({
      pid,
      application,
      state,
      ageMs,
      kind,
    })),
  };
}

/**
 * Remembers what the wait saw. The property is not enumerable.
 *
 * @param error - The lock timeout the wait gave up on
 * @param outcome - Attempts, time, and holders
 * @returns The same error
 */
export function attachLock<T extends object>(error: T, outcome: LockOutcome): T {
  Object.defineProperty(error, OUTCOME, { value: outcome, enumerable: false });
  return error;
}

/**
 * What {@link attachLock} recorded.
 *
 * @param error - Caught value
 * @returns The outcome, or `undefined`
 */
export function readLock(error: unknown): LockOutcome | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value: unknown = Reflect.get(error, OUTCOME);
  return typeof value === "object" && value !== null ? (value as LockOutcome) : undefined;
}

/**
 * True when a failure is SQLSTATE 55P03. Nothing else counts.
 *
 * @param error - Driver error, or whatever a step threw
 * @returns Whether the lock could not be taken in time
 */
export function isLockTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return Reflect.get(error, "sqlstate") === "55P03" || Reflect.get(error, "code") === "55P03";
}

/**
 * `1 attempt`, `2 attempts`.
 *
 * @param count - How many
 * @param one - Singular noun
 * @param many - Plural noun
 * @returns The count and its noun
 */
export function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/**
 * `850 ms`, `1.2 s`, `3 min 5 s`.
 *
 * @param ms - Milliseconds
 * @returns Short text
 */
export function span(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${String(Math.round(ms / 100) / 10)} s`;
  const seconds = Math.round(ms / 1_000);
  const rest = seconds % 60;
  return `${String(Math.floor(seconds / 60))} min${rest === 0 ? "" : ` ${String(rest)} s`}`;
}

/** Sessions that hold what the blocked backend waits for. A prepared transaction is pid 0. */
const HOLDERS = `select b.pid::text, a.application_name, a.state, a.backend_type,
       (extract(epoch from clock_timestamp() - coalesce(a.xact_start, a.query_start, a.state_change)) * 1000)::bigint::text,
       a.query, null::text
  from unnest(pg_blocking_pids($1::int)) as b(pid)
  left join pg_stat_activity a on a.pid = b.pid
 where b.pid <> 0
union all
select '0', null, 'prepared', null,
       (extract(epoch from clock_timestamp() - x.prepared) * 1000)::bigint::text, null, x.gid
  from pg_prepared_xacts x
  join pg_locks xl on xl.locktype = 'transactionid' and xl.transactionid = x.transaction
 where 0 = any(pg_blocking_pids($1::int))
   and exists (
     select 1
       from pg_locks w
       join pg_locks l
         on l.granted
        and l.virtualtransaction = xl.virtualtransaction
        and l.locktype = w.locktype
        and l.database is not distinct from w.database
        and l.relation is not distinct from w.relation
        and l.transactionid is not distinct from w.transactionid
      where w.pid = $1::int and not w.granted)`;

function holderOf(row: readonly unknown[]): LockHolder {
  const text = (index: number): string => (typeof row[index] === "string" ? row[index] : "");
  const gid = text(6);
  const application = text(1);
  const state = text(2);
  const age = Number(row[4]);
  const kind: HolderKind =
    gid !== ""
      ? "prepared-transaction"
      : text(3) === "autovacuum worker"
        ? "autovacuum"
        : application === APPLY_APPLICATION
          ? "okm-apply"
          : state.startsWith("idle in transaction")
            ? "idle-in-transaction"
            : state === "active"
              ? "active"
              : "other";
  const query = text(5);
  return {
    pid: Number(row[0]),
    application,
    state,
    ageMs: Number.isFinite(age) ? age : null,
    kind,
    ...(query !== "" ? { query } : {}),
    ...(gid !== "" ? { gid } : {}),
  };
}

/** A second session that reads who blocks the apply connection. */
export type LockObserver = {
  /** Reads the holders once the attempt has waited a moment. Call `stop` when it ends. */
  readonly watch: (pid: string, lockTimeoutMs: number) => { readonly stop: () => void };
  /** The holders of the last blocked attempt, once any read in flight has finished. */
  readonly seen: () => Promise<readonly LockHolder[]>;
  /** Forgets the holders of an earlier step. */
  readonly reset: () => void;
  readonly close: () => Promise<void>;
};

/**
 * Opens the observer on first use.
 *
 * @param connect - Opens a pool on the same target
 * @returns The observer. It opens nothing for an attempt that ends in time
 */
export function lockObserver(connect: () => DriverPool): LockObserver {
  let pool: DriverPool | undefined;
  let holders: readonly LockHolder[] = [];
  let reading: Promise<void> = Promise.resolve();
  return {
    watch(pid, lockTimeoutMs) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = Date.now();
      const read = async (): Promise<void> => {
        if (stopped) return;
        try {
          pool ??= connect();
          const found = (await pool.execute(HOLDERS, [pid])).rows.map(holderOf);
          if (found.length > 0) {
            holders = found;
            return;
          }
        } catch {
          // The names are a courtesy. A failed read must not fail the step.
        }
        if (!stopped && Date.now() - started < lockTimeoutMs) {
          timer = setTimeout(() => {
            reading = read();
          }, POLL_MS);
        }
      };
      timer = setTimeout(
        () => {
          reading = read();
        },
        Math.min(POLL_MS, Math.max(lockTimeoutMs / 2, 1)),
      );
      return {
        stop() {
          stopped = true;
          clearTimeout(timer);
        },
      };
    },
    async seen() {
      await reading;
      return holders;
    },
    reset() {
      holders = [];
    },
    async close() {
      await pool?.close().catch(() => undefined);
    },
  };
}

/** What a wait needs from the run. */
export type LockBudget = {
  /** `--lock-wait`. 0 is one attempt. */
  readonly waitMs: number;
  /** `lock_timeout` for one attempt. */
  readonly lockTimeoutMs: number;
  /** Backend pid of a connection that passed the direct check. */
  readonly pid?: string;
  readonly observer?: LockObserver;
  readonly note?: (line: string) => void;
  /** True once an earlier step or batch of this run has committed. */
  readonly earlier: () => boolean;
  readonly tally: LockTally;
};

/** Runs work again while the lock stays taken. */
export type LockWaiter = {
  /**
   * Runs `work`. A 55P03 is retried until the wait is spent. Any other error ends it.
   *
   * @param work - One attempt. It opens and closes its own transaction
   * @param ran - The statement already ran, so only its record is waiting
   */
  readonly run: <T>(work: () => Promise<T>, ran?: boolean) => Promise<T>;
};

/** A waiter that never waits: one attempt, for callers that have no connection to watch. */
export const ONCE: LockWaiter = { run: (work) => work() };

/**
 * A waiter for one step.
 *
 * @param budget - Time, observer, and the run's tally
 * @param label - `0007_x step 3`, for the progress line
 * @returns The waiter
 */
export function lockWaiter(budget: LockBudget, label: string): LockWaiter {
  return {
    async run(work, ran = false) {
      budget.observer?.reset();
      let blocked = 0;
      let waited = 0;
      for (;;) {
        const began = Date.now();
        const watching =
          budget.observer !== undefined && budget.pid !== undefined
            ? budget.observer.watch(budget.pid, budget.lockTimeoutMs)
            : undefined;
        try {
          const value = await work();
          if (blocked > 0) {
            budget.tally.attempts += blocked + 1;
            budget.tally.waitedMs += waited;
          }
          return value;
        } catch (error) {
          if (!isLockTimeout(error)) throw error;
          blocked += 1;
          waited += Date.now() - began;
          if (waited >= budget.waitMs) {
            budget.tally.attempts += blocked;
            budget.tally.waitedMs += waited;
            throw attachLock(error as object, {
              attempts: blocked,
              waitedMs: waited,
              blockedBy: (await budget.observer?.seen()) ?? [],
              ran,
              earlier: budget.earlier(),
            });
          }
          if (blocked === 1 || blocked % NOTE_EVERY === 0) {
            budget.note?.(
              `waiting for a lock: ${label}, attempt ${String(blocked + 1)}, ${span(waited)} so far`,
            );
          }
          const pause = Math.min(
            PAUSE_MS * 2 ** (blocked - 1),
            PAUSE_CAP_MS,
            budget.waitMs - waited,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, pause));
          waited += pause;
        } finally {
          watching?.stop();
        }
      }
    },
  };
}

function plain(text: string): string {
  return text.replace(CONTROL, "").slice(0, 80);
}

function holderLine(holder: LockHolder): string {
  const age = holder.ageMs === null ? "" : ` for ${span(holder.ageMs)}`;
  const app = holder.application === "" ? "" : ` (${plain(holder.application)})`;
  switch (holder.kind) {
    case "prepared-transaction":
      return `a prepared transaction "${plain(holder.gid ?? "")}", open${age}. It has no pid.`;
    case "autovacuum":
      return `autovacuum, pid ${String(holder.pid)}${age}.`;
    case "okm-apply":
      return `another okm apply, pid ${String(holder.pid)}, ${plain(holder.state)}${age}.`;
    case "idle-in-transaction":
      return `pid ${String(holder.pid)}${app}, idle in a transaction${age}.`;
    case "active":
      return `pid ${String(holder.pid)}${app}, running a statement${age}.`;
    default:
      return `pid ${String(holder.pid)}${app}${holder.state === "" ? "" : `, ${plain(holder.state)}`}${age}.`;
  }
}

/**
 * The error a step throws when a lock stayed taken for the whole wait.
 *
 * The message names the holders and says what changed. It carries no query
 * text. The terminal gets that from {@link queryLines}.
 *
 * @param migrationId - Migration the step belongs to
 * @param stepNumber - One-based step number
 * @param cause - The 55P03 the last attempt raised
 * @param outcome - What the wait left on `cause`
 * @param fix - What to tell the person to do next
 * @returns A retryable error that carries the outcome
 */
export function lockFailure(
  migrationId: string,
  stepNumber: number,
  cause: unknown,
  outcome: LockOutcome,
  fix: string,
): OkmError {
  const lines = [
    `Migration ${migrationId} failed at step ${String(stepNumber)}: I could not get a lock after ${counted(outcome.attempts, "attempt", "attempts")} over ${span(outcome.waitedMs)}.`,
  ];
  const named = outcome.blockedBy.slice(0, MAX_NAMED);
  if (named.length === 0) lines.push("I could not see which session holds it.");
  for (const holder of named) lines.push(`Held by ${holderLine(holder)}`);
  const more = outcome.blockedBy.length - named.length;
  if (more > 0) lines.push(`And ${counted(more, "more session", "more sessions")}.`);
  if (named.length > 0) lines.push("I did not touch any of them.");
  lines.push(
    outcome.ran
      ? "The statement ran, but I could not record it. okm migrate status shows where it stands."
      : outcome.earlier
        ? "This step changed nothing. The steps before it stay applied."
        : "Nothing was changed.",
  );
  return attachLock(
    new OkmError("invalid", lines.join("\n"), { cause, fix: { summary: fix }, retryable: true }),
    outcome,
  );
}

/**
 * Query text lines for a terminal, one line each.
 *
 * Only a pretty terminal calls this. A holder this role cannot see says so.
 *
 * @param outcome - What the wait saw
 * @returns Lines to print after the failure, or none
 */
export function queryLines(outcome: LockOutcome): readonly string[] {
  return outcome.blockedBy.slice(0, MAX_NAMED).flatMap((holder) => {
    if (holder.kind === "prepared-transaction" || holder.query === undefined) return [];
    const who = `pid ${String(holder.pid)}`;
    if (holder.query === "<insufficient privilege>") {
      return [`${who} query: hidden, this role cannot read it.`];
    }
    const flat = holder.query.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
    return [`${who} query: ${flat.length > 100 ? `${flat.slice(0, 99)}…` : flat}`];
  });
}
