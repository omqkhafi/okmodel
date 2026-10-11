/**
 * Keeps `okm migrate check` off the real schema.
 *
 * Replay runs in a scratch schema. A statement that still names `public`
 * would change the target, and a text replace of `"public".` misses
 * `public.t`, `PUBLIC.t`, and a `DO` block. This wrapper locks `search_path`
 * to the scratch schema for the transaction, revokes `public` for that
 * transaction, and refuses to commit when the public catalog moved. The
 * revoke is restored before a clean commit and rolled back with everything
 * else. A statement Postgres will not run inside a transaction is refused
 * before it is sent when it names `public`.
 */

import { nextTransactionDepth } from "../../adapters/pg/call.js";
import type { DriverConnection } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { statementOutsideTransaction } from "./runner.js";

const FINGERPRINT = `select md5(coalesce(string_agg(line, E'\\n' order by line), ''))
from (
  select 'ns|' || n.nspowner::text as line
  from pg_namespace n
  where n.nspname = 'public'
  union all
  select 'rel|' || c.relname || '|' || c.relkind::text || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text
    || '|' || coalesce((
      select string_agg(a.attname || ':' || a.atttypid::text || ':' || a.attnum::text || ':' || a.attnotnull::text, ',' order by a.attnum)
      from pg_attribute a
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    ), '')
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'i', 'S', 'f')
  union all
  select 'pol|' || c.relname || '|' || p.polname || '|' || p.polcmd::text || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '')
    || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
) s`;

/**
 * Wraps a check connection so a commit cannot persist a public change.
 *
 * @param inner - Reserved connection. The caller still releases it
 * @param scratch - Schema the replay is allowed to change
 * @returns The same connection, with public guarded
 */
export async function isolatePublic(
  inner: DriverConnection,
  scratch: string,
): Promise<DriverConnection> {
  let depth = 0;
  let baseline: string | undefined;
  let savedAcl: string | undefined;
  const wrapped: DriverConnection = {
    async execute(text, params, options) {
      const command = commandOf(text);
      const next = nextTransactionDepth(depth, text);
      if (isBegin(command) && next > depth) {
        const result = await inner.execute(text, params, options);
        const opening = depth === 0;
        depth = next;
        if (opening) {
          baseline ??= await asSession(inner, () => fingerprint(inner));
          await inner.execute("select set_config('search_path', $1, true)", [scratch]);
          savedAcl = await asSession(inner, () => lockPublic(inner));
        }
        return result;
      }
      if (isCommit(command) && next < depth) {
        if (next === 0) {
          await asSession(inner, () => assertUntouched(inner, baseline));
          const acl = savedAcl;
          if (acl !== undefined) await asSession(inner, () => restorePublic(inner, acl));
        }
        const result = await inner.execute(text, params, options);
        depth = next;
        return result;
      }
      if (isRollback(command)) {
        const result = await inner.execute(text, params, options);
        depth = next;
        return result;
      }
      if (depth === 0 && statementOutsideTransaction(text) && qualifiesPublic(text)) {
        throw outsideScratch();
      }
      if (depth > 0) await inner.execute("select set_config('search_path', $1, true)", [scratch]);
      const result = await inner.execute(text, params, options);
      depth = next;
      return result;
    },
    batch: (statements, options) => inner.batch(statements, options),
    release: () => inner.release(),
  };
  if (inner.cancel !== undefined) wrapped.cancel = () => inner.cancel?.();
  return wrapped;
}

function commandOf(text: string): string {
  return text.trim().replace(/;\s*$/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isBegin(command: string): boolean {
  return (
    command === "begin" || command.startsWith("begin ") || command.startsWith("start transaction")
  );
}

function isCommit(command: string): boolean {
  return (
    command === "commit" ||
    command === "commit work" ||
    command === "end" ||
    command.startsWith("end ")
  );
}

function isRollback(command: string): boolean {
  return command === "rollback" || command.startsWith("rollback");
}

function qualifiesPublic(sql: string): boolean {
  return /(?:"public"|\bpublic)\s*\./i.test(sql);
}

async function fingerprint(connection: DriverConnection): Promise<string> {
  const result = await connection.execute(FINGERPRINT);
  const value = result.rows[0]?.[0];
  return typeof value === "string" ? value : "";
}

async function lockPublic(connection: DriverConnection): Promise<string> {
  const result = await connection.execute(
    "select coalesce(nspacl::text, '') from pg_namespace where nspname = 'public'",
  );
  const value = result.rows[0]?.[0];
  const acl = typeof value === "string" ? value : "";
  await connection.execute("revoke all on schema public from public");
  await connection.execute("revoke all on schema public from current_user");
  return acl;
}

async function restorePublic(connection: DriverConnection, acl: string): Promise<void> {
  await connection.execute(
    `update pg_namespace
     set nspacl = case when $1 = '' then null else $1::aclitem[] end
     where nspname = 'public'`,
    [acl],
  );
}

/**
 * Runs catalog guards as the session user.
 *
 * A check sets the migration role, which cannot update `pg_namespace`.
 * The role is put back before the replay continues.
 *
 * @param connection - Reserved connection
 * @param run - Statements that read or restore the public catalog
 * @returns The callback result
 */
async function asSession<T>(connection: DriverConnection, run: () => Promise<T>): Promise<T> {
  const current = await connection.execute("select current_user");
  const session = await connection.execute("select session_user");
  const role = current.rows[0]?.[0];
  const owner = session.rows[0]?.[0];
  const switched = typeof role === "string" && typeof owner === "string" && role !== owner;
  if (switched) await connection.execute("reset role");
  try {
    return await run();
  } finally {
    if (switched && typeof role === "string") {
      await connection.execute(`set role ${quoteIdent(role)}`);
    }
  }
}

async function assertUntouched(
  connection: DriverConnection,
  baseline: string | undefined,
): Promise<void> {
  if (baseline === undefined) return;
  const now = await fingerprint(connection);
  if (now === baseline) return;
  throw new OkmError(
    "invalid",
    "okm migrate check would have changed objects outside the scratch schema.",
    {
      kind: "invalid",
      fix: {
        summary:
          "A check replays into its scratch schema and rolls a public change back. Rewrite the step so it does not name public.",
      },
    },
  );
}

function outsideScratch(): OkmError {
  return new OkmError(
    "invalid",
    "okm migrate check cannot run a statement that names a schema other than its scratch schema.",
    {
      kind: "invalid",
      fix: {
        summary:
          "CREATE INDEX CONCURRENTLY, ALTER TYPE ADD VALUE, and VACUUM cannot be rolled back. Keep them in the scratch schema.",
      },
    },
  );
}
