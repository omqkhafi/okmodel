/**
 * Durable change feed for `watch({ feed })`.
 *
 * The active consumer holds a session advisory lock on a reserved connection.
 * A standby with the same name waits and takes the lock when the holder
 * leaves. The read is the truth: only rows with `xid` below the snapshot
 * horizon are delivered, in `seq` order. `{ tx }` runs the handler and the
 * cursor update in one transaction. A proven transaction-pooler URL refuses
 * that form and uses a transaction-scoped lock for the batch instead.
 */

import type {
  DriverConnection,
  DriverPool,
  ExecuteResult,
  WireValue,
} from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";
import { poolerUrlSignal } from "../dialects/pg/pooler-url.js";
import type { Session } from "./client.js";
import type { FeedChange, FeedResync } from "./types.js";

const PAGE = 1_000;
const MAX_PAGES = 20;

type Pool = Pick<DriverPool, "execute">;

type FeedHandler = (changes: readonly FeedChange[], ctx: { readonly tx: unknown }) => unknown;

/** One feed pass. `owner` is the subscription token `stop` releases. */
export type FeedDelivery = {
  readonly session: Session;
  readonly table: string;
  readonly name: string;
  readonly handler: FeedHandler;
  readonly transactional: boolean;
  readonly onResync: ((info: FeedResync) => unknown) | undefined;
  readonly owner: object;
  readonly token: string | undefined;
  readonly stopped: () => boolean;
};

type Lease = {
  readonly owner: object;
  readonly conn: DriverConnection;
};

const leases = new Map<string, Lease>();
const poolIds = new WeakMap<object, number>();
let nextPoolId = 1;

/**
 * Delivers one feed pass, or returns when another process holds the name.
 *
 * @param input - Subscription, handler, and scope token
 */
export async function deliverFeed(input: FeedDelivery): Promise<void> {
  const model = input.session.schema.model[input.table];
  const keepMs = model?.watch?.feed?.keepMs;
  if (keepMs === undefined) {
    throw new OkmError("OKM1121", `Table ${input.table} has no watch feed.`, { kind: "invalid" });
  }
  const rel = model?.sql ?? input.table;
  const url = input.session.targetUrl ?? input.session.listenUrl;
  const pooled = url !== undefined ? poolerUrlSignal(url) : undefined;
  if (input.transactional && pooled !== undefined) {
    throw new OkmError(
      "OKM1936",
      `watch feed cannot run its handler transaction on a transaction pooler (${pooled.detail}). Use a direct or session connection.`,
      { kind: "unavailable" },
    );
  }
  if (pooled !== undefined) {
    await pooledPass(input, rel, keepMs);
    return;
  }
  const held = await holdLease(input, rel);
  if (!held || input.stopped()) return;
  if (input.transactional) {
    const { tx } = await import("./transaction.js");
    await tx(input.session, [
      async (client: object) => {
        await pass(connectionPool(client, input.table), input, rel, keepMs, client);
      },
    ]);
    return;
  }
  await pass(input.session.pool, input, rel, keepMs, undefined);
}

/**
 * Drops the session lock when `owner` still holds it.
 *
 * @param session - Client session
 * @param table - Table name
 * @param name - Consumer name
 * @param owner - Subscription token passed to {@link deliverFeed}
 */
export async function releaseFeed(
  session: Session,
  table: string,
  name: string,
  owner: object,
): Promise<void> {
  const rel = session.schema.model[table]?.sql ?? table;
  const key = leaseKey(session.pool, rel, name);
  const slot = leases.get(key);
  if (slot === undefined || slot.owner !== owner) return;
  leases.delete(key);
  await slot.conn.release().catch(() => undefined);
}

/**
 * Doctor lines for feed lag, the snapshot horizon, and a cursor behind retention.
 *
 * Empty when `okm_changes` is absent. The host and the query text are not included.
 *
 * @param pool - A pool that can read `pg_stat_activity`
 * @returns Lines, each ending in a newline
 */
export async function feedDoctorText(pool: Pool): Promise<string> {
  const exists = await pool.execute("select to_regclass('public.okm_changes')::text", []);
  const name = cell(exists, 0);
  if (name === undefined || name.length === 0) return "";
  const consumers = await pool.execute(
    `select c.rel, c.name, c.seq::text as cursor,
       coalesce((
         select max(ch.seq) from okm_changes ch
         where ch.rel = c.rel and ch.xid < pg_snapshot_xmin(pg_current_snapshot())
       ), c.seq)::text as head,
       coalesce(extract(epoch from (
         clock_timestamp() - (
           select min(ch.at) from okm_changes ch
           where ch.rel = c.rel and ch.seq > c.seq
             and ch.xid < pg_snapshot_xmin(pg_current_snapshot())
         )
       )), 0)::text as lag
     from okm_cursors c
     order by c.rel, c.name`,
    [],
  );
  const behind = await pool.execute(
    `select c.rel, c.name, c.seq::text as cursor, f.seq::text as floor
     from okm_cursors c
     join okm_feed_floor f on f.rel = c.rel
     where c.seq < f.seq
     order by c.rel, c.name`,
    [],
  );
  const horizon = await pool.execute(
    `select pid::text as pid, state,
       extract(epoch from (clock_timestamp() - xact_start))::text as age
     from pg_stat_activity
     where backend_xid is not null and pid <> pg_backend_pid()
     order by xact_start
     limit 1`,
    [],
  );
  const lines: string[] = [];
  if (consumers.rows.length === 0) lines.push("feed: no consumers.");
  const late = new Set(behind.rows.map((row) => `${text(row[0])}/${text(row[1])}`));
  for (const row of consumers.rows) {
    const label = `${text(row[0])}/${text(row[1])}`;
    if (late.has(label)) continue;
    lines.push(
      `feed ${label}: cursor ${text(row[2])}, head ${text(row[3])}, lag ${seconds(row[4])}.`,
    );
  }
  for (const row of behind.rows) {
    lines.push(
      `feed ${text(row[0])}/${text(row[1])}: cursor ${text(row[2])} is behind the retention floor ${text(row[3])}.`,
    );
  }
  const open = horizon.rows[0];
  lines.push(
    open === undefined
      ? "feed horizon: no open transaction holds the snapshot."
      : `feed horizon: oldest open transaction is pid ${text(open[0])} (${text(open[1])}, ${seconds(open[2])}).`,
  );
  return `${lines.join("\n")}\n`;
}

async function pooledPass(input: FeedDelivery, rel: string, keepMs: number): Promise<void> {
  const conn = await checkout(input.session.pool);
  let open = false;
  try {
    await conn.execute("begin", []);
    open = true;
    const got = await conn.execute("select pg_try_advisory_xact_lock(hashtextextended($1, 0))", [
      lockToken(rel, input.name),
    ]);
    if (!locked(cell(got, 0))) {
      await conn.execute("rollback", []);
      open = false;
      return;
    }
    await pass(conn, input, rel, keepMs, undefined);
    await conn.execute("commit", []);
    open = false;
  } catch (error) {
    if (open) await conn.execute("rollback", []).catch(() => undefined);
    throw error;
  } finally {
    await releaseQuiet(conn);
  }
}

async function holdLease(input: FeedDelivery, rel: string): Promise<boolean> {
  const key = leaseKey(input.session.pool, rel, input.name);
  const existing = leases.get(key);
  if (existing !== undefined) {
    if (existing.owner !== input.owner) return false;
    try {
      await existing.conn.execute("select 1", []);
      return true;
    } catch {
      leases.delete(key);
      await releaseQuiet(existing.conn);
    }
  }
  const conn = await checkout(input.session.pool);
  try {
    const got = await conn.execute("select pg_try_advisory_lock(hashtextextended($1, 0))", [
      lockToken(rel, input.name),
    ]);
    if (!locked(cell(got, 0))) {
      await releaseQuiet(conn);
      return false;
    }
    leases.set(key, { owner: input.owner, conn });
    return true;
  } catch (error) {
    await releaseQuiet(conn);
    throw error;
  }
}

async function checkout(pool: DriverPool): Promise<DriverConnection> {
  const conn = await pool.reserve?.();
  if (conn === undefined) {
    throw new OkmError("OKM1111", "watch feed needs a pool that can reserve a connection.", {
      kind: "unavailable",
    });
  }
  return conn;
}

async function releaseQuiet(conn: DriverConnection): Promise<void> {
  try {
    await conn.release();
  } catch {
    // The connection is already finished. The lock leaves with it.
  }
}

async function pass(
  pool: Pool,
  input: FeedDelivery,
  rel: string,
  keepMs: number,
  txClient: object | undefined,
): Promise<void> {
  if (input.stopped()) return;
  let cursor = await readCursor(pool, rel, input.name);
  const gap = await readGap(pool, rel, cursor);
  if (gap !== undefined) {
    const head = bigMax(await readHead(pool, rel), gap);
    const info: FeedResync = {
      table: input.table,
      feed: input.name,
      cursor,
      floor: gap,
    };
    if (input.onResync === undefined) {
      throw new OkmError(
        "OKM1935",
        `watch feed ${input.table}/${input.name} cursor ${cursor} is behind the oldest retained change ${gap}.`,
        {
          kind: "invalid",
          fix: {
            summary: "Pass onResync and rebuild from the table, or raise keep.",
          },
        },
      );
    }
    await Promise.resolve(input.onResync(info));
    await advance(pool, rel, input.name, head);
    cursor = head;
  }
  const changes = await readAll(pool, rel, cursor, input.token, input.stopped);
  if (changes.length > 0) {
    if (input.transactional && txClient !== undefined) {
      await input.handler(changes, { tx: txClient });
    } else {
      await input.handler(changes, { tx: undefined });
    }
    const last = changes[changes.length - 1];
    if (last !== undefined) await advance(pool, rel, input.name, last.seq);
  }
  if (!input.stopped()) await prune(pool, rel, keepMs);
}

async function readCursor(pool: Pool, rel: string, name: string): Promise<string> {
  const result = await pool.execute(
    "select seq::text from okm_cursors where rel = $1 and name = $2",
    [rel, name],
  );
  return cell(result, 0) ?? "0";
}

async function readGap(pool: Pool, rel: string, cursor: string): Promise<string | undefined> {
  const result = await pool.execute(
    `select coalesce((select seq::text from okm_feed_floor where rel = $1), '0'),
            (select min(seq)::text from okm_changes where rel = $1)`,
    [rel],
  );
  const row = result.rows[0];
  const floor = text(row?.[0] ?? "0");
  const min = row?.[1];
  const behindFloor = BigInt(floor) > BigInt(cursor);
  const behindMin = typeof min === "string" && min.length > 0 && BigInt(min) > BigInt(cursor) + 1n;
  if (!behindFloor && !behindMin) return undefined;
  return behindFloor ? floor : text(min);
}

async function readHead(pool: Pool, rel: string): Promise<string> {
  const result = await pool.execute(
    `select coalesce((
       select max(seq)::text from okm_changes
       where rel = $1 and xid < pg_snapshot_xmin(pg_current_snapshot())
     ), '0')`,
    [rel],
  );
  return cell(result, 0) ?? "0";
}

type Row = FeedChange & { readonly seq: string };

async function readAll(
  pool: Pool,
  rel: string,
  cursor: string,
  token: string | undefined,
  stopped: () => boolean,
): Promise<Row[]> {
  const rows: Row[] = [];
  let after = cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (stopped()) return rows;
    const result = await pool.execute(
      `select seq::text, op, key::text, tenant
       from okm_changes
       where rel = $1 and seq > $2::bigint
         and xid < pg_snapshot_xmin(pg_current_snapshot())
         and ($3::text is null or tenant is null or tenant = $3)
       order by seq
       limit ${String(PAGE)}`,
      [rel, after, token ?? null],
    );
    if (result.rows.length === 0) break;
    for (const row of result.rows) {
      const op = readOp(row[1]);
      const seq = text(row[0]);
      if (op === undefined || seq.length === 0) continue;
      const tenant = text(row[3]);
      rows.push({
        seq,
        op,
        key: readKey(row[2]),
        ...(tenant.length > 0 ? { tenant } : {}),
      });
      after = seq;
    }
    if (result.rows.length < PAGE) break;
  }
  return rows;
}

async function advance(pool: Pool, rel: string, name: string, seq: string): Promise<void> {
  await pool.execute(
    `insert into okm_cursors (rel, name, seq)
     values ($1, $2, $3::bigint)
     on conflict (rel, name) do update set seq = excluded.seq
     where okm_cursors.seq < excluded.seq`,
    [rel, name, seq],
  );
}

async function prune(pool: Pool, rel: string, keepMs: number): Promise<void> {
  await pool.execute(
    `with doomed as (
       delete from okm_changes
       where rel = $1
         and at < clock_timestamp() - ($2::double precision * interval '1 millisecond')
       returning seq
     ), top as (
       select max(seq) as seq from doomed
     )
     insert into okm_feed_floor (rel, seq)
     select $1, seq from top where seq is not null
     on conflict (rel) do update
     set seq = greatest(okm_feed_floor.seq, excluded.seq)`,
    [rel, String(keepMs)],
  );
}

function connectionPool(client: object, table: string): Pool {
  const api = (client as Record<string, unknown>)[table];
  if (typeof api !== "object" || api === null) {
    throw new OkmError("OKM1121", `watch feed cannot find ${table} on the handler transaction.`, {
      kind: "invalid",
    });
  }
  const lane = (api as Record<symbol, unknown>)[Symbol.for("okm.lane")];
  if (!Array.isArray(lane)) {
    throw new OkmError("OKM1121", "watch feed cannot use the handler transaction.", {
      kind: "invalid",
    });
  }
  const session = lane[0] as { readonly pool?: Pool } | undefined;
  if (session?.pool === undefined) {
    throw new OkmError("OKM1121", "watch feed cannot use the handler transaction.", {
      kind: "invalid",
    });
  }
  return session.pool;
}

function leaseKey(pool: object, rel: string, name: string): string {
  const found = poolIds.get(pool);
  const id = found ?? nextPoolId;
  if (found === undefined) {
    nextPoolId += 1;
    poolIds.set(pool, id);
  }
  return `${String(id)}\u0000${rel}\u0000${name}`;
}

function lockToken(rel: string, name: string): string {
  // Postgres text rejects a NUL byte. Unit separator stays out of an identifier.
  return `okm-feed\u001f${rel}\u001f${name}`;
}

function cell(result: ExecuteResult, index: number): string | undefined {
  const value = result.rows[0]?.[index];
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function text(value: WireValue | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function locked(value: string | undefined): boolean {
  return value === "true" || value === "t" || value === "1";
}

function readOp(value: WireValue | undefined): FeedChange["op"] | undefined {
  if (value === "insert" || value === "update" || value === "delete" || value === "truncate") {
    return value;
  }
  return undefined;
}

function readKey(value: WireValue | undefined): Readonly<Record<string, unknown>> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function bigMax(left: string, right: string): string {
  return BigInt(left) > BigInt(right) ? left : right;
}

function seconds(value: WireValue | undefined): string {
  const n = typeof value === "number" ? value : Number(text(value));
  if (!Number.isFinite(n) || n < 0) return "0s";
  return `${String(Math.floor(n))}s`;
}
