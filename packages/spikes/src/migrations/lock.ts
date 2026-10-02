/**
 * Lock a planned step takes, and whether that lock blocks readers or writers.
 *
 * Modes are the names `pg_locks.mode` returns. `none` means the step takes no
 * lock on a user relation in the scratch schema.
 */

/** A `pg_locks.mode` value, or `none` when the step locks no user relation. */
export type LockMode =
  | "AccessExclusiveLock"
  | "ShareLock"
  | "ShareRowExclusiveLock"
  | "AccessShareLock"
  | "none";

/** Lock claimed for one planned statement. */
export type LockInfo = {
  readonly mode: LockMode;
  /** Unqualified relation name. Empty when `mode` is `none`. */
  readonly relation: string;
  readonly blocksReads: boolean;
  readonly blocksWrites: boolean;
};

/**
 * Builds a lock claim from the mode Postgres will take.
 *
 * `ACCESS EXCLUSIVE` blocks reads and writes. `SHARE` and
 * `SHARE ROW EXCLUSIVE` block writes and still allow reads.
 *
 * @param mode - Lock mode
 * @param relation - Unqualified relation the lock is taken on
 * @returns The claim shown on a plan step
 */
export function lockInfo(mode: LockMode, relation: string): LockInfo {
  if (mode === "none") {
    return { mode, relation: "", blocksReads: false, blocksWrites: false };
  }
  const blocksReads = mode === "AccessExclusiveLock";
  const blocksWrites =
    mode === "AccessExclusiveLock" || mode === "ShareLock" || mode === "ShareRowExclusiveLock";
  return { mode, relation, blocksReads, blocksWrites };
}

/**
 * Infers the user-relation lock from a statement this spike emits.
 *
 * @param sql - One planned statement
 * @returns The lock that statement takes
 */
export function lockForStatement(sql: string): LockInfo {
  const text = sql.trim().toLowerCase();
  if (
    /^(create( or replace)? function|drop function|create domain|drop domain|alter domain|create sequence|drop sequence|create role|drop role|alter role|grant |revoke |alter default privileges|alter extension)\b/.test(
      text,
    )
  ) {
    return lockInfo("none", "");
  }
  if (text.startsWith("create unique index") || text.startsWith("create index")) {
    return lockInfo("ShareLock", relationAfterOn(sql));
  }
  if (text.startsWith("create trigger"))
    return lockInfo("ShareRowExclusiveLock", relationAfterOn(sql));
  if (text.startsWith("drop trigger")) return lockInfo("AccessExclusiveLock", relationAfterOn(sql));
  if (text.startsWith("drop index")) return lockInfo("AccessExclusiveLock", secondIdent(sql));
  return lockInfo("AccessExclusiveLock", secondIdent(sql));
}

function relationAfterOn(sql: string): string {
  const match = /\bon\s+"[^"]+"\."((?:[^"]|"")*)"/i.exec(sql);
  return match?.[1]?.replaceAll('""', '"') ?? secondIdent(sql);
}

function secondIdent(sql: string): string {
  const names = [...sql.matchAll(/"((?:[^"]|"")*)"/g)].map((match) =>
    (match[1] ?? "").replaceAll('""', '"'),
  );
  return names[1] ?? names[0] ?? "";
}
