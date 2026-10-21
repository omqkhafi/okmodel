/**
 * Typed raw lock: its shape, its parser, and the registration slot.
 *
 * `okm raw sync` writes `.okm/raw.lock.json`. The runtime reads it on the first
 * typed `raw()` call, or takes it from {@link registerRawLock} on a runtime
 * with no file access. Nothing in the runtime entry imports this module.
 */

import { OkmError } from "../../contracts/error.js";

/** One parameter in the lock. `enumLabels` is omitted unless the type is an enum. */
export type RawLockParam = {
  readonly pgType: string;
  readonly enumLabels?: readonly string[];
};

/** One result column. `name` has no `!` or `?` suffix. */
export type RawLockColumn = {
  readonly name: string;
  readonly pgType: string;
  readonly nullable: boolean;
  readonly enumLabels?: readonly string[];
};

/** One locked statement. `sql` is the normalised text. */
export type RawLockStatement = {
  readonly sql: string;
  readonly kind: "read" | "write";
  readonly params: readonly RawLockParam[];
  readonly columns: readonly RawLockColumn[];
};

/** The file `.okm/raw.lock.json`. */
export type RawLock = {
  readonly version: 1;
  readonly dialect: "postgres";
  readonly catalogHash: string;
  readonly statements: Readonly<Record<string, RawLockStatement>>;
};

/** OKM1601 text. The doctor page, `okm raw sync`, and the runtime share it. */
export const RAW_STALE = {
  summary:
    "A typed raw statement is missing from the lock, the lock does not parse, or its signature no longer matches the database.",
  fix: "Run okm raw sync and commit .okm/raw.lock.json and .okm/raw.d.ts.",
} as const;

/**
 * OKM1601 with the shared fix.
 *
 * @param message - What went wrong. Omitted, the shared summary
 * @returns The error to throw
 */
export function staleRaw(message?: string): OkmError {
  return new OkmError("OKM1601", message ?? RAW_STALE.summary, {
    fix: { summary: RAW_STALE.fix },
  });
}

/**
 * Validates a parsed lock.
 *
 * @param value - Result of `JSON.parse`, or an imported JSON module
 * @returns The lock, or `undefined` when the value is not a version 1 lock
 */
export function parseRawLockValue(value: unknown): RawLock | undefined {
  if (!isRecord(value) || value.version !== 1 || value.dialect !== "postgres") return undefined;
  if (typeof value.catalogHash !== "string" || !isRecord(value.statements)) return undefined;
  const statements: Record<string, RawLockStatement> = {};
  for (const [hash, statement] of Object.entries(value.statements)) {
    const parsed = parseStatement(statement);
    if (parsed === undefined) return undefined;
    statements[hash] = parsed;
  }
  return { version: 1, dialect: "postgres", catalogHash: value.catalogHash, statements };
}

let registered: RawLock | undefined;

/**
 * Gives the typed `raw()` the lock without a file read.
 *
 * Use it where the runtime has no file access, such as a Worker: import the
 * JSON and pass it here before the first typed `raw()`. A registered lock wins
 * over `.okm/raw.lock.json`. An app that never calls this keeps no bytes for it.
 *
 * @param lock - The parsed contents of `.okm/raw.lock.json`. `undefined` drops a registered lock
 * @throws OkmError OKM1601 when the value is not a version 1 lock
 */
export function registerRawLock(lock: unknown): void {
  if (lock === undefined) {
    registered = undefined;
    return;
  }
  const parsed = parseRawLockValue(lock);
  if (parsed === undefined) {
    throw staleRaw("The value passed to registerRawLock is not a typed raw lock (version 1).");
  }
  registered = parsed;
}

/**
 * The lock {@link registerRawLock} stored.
 *
 * @returns The lock, or `undefined` when none was registered
 */
export function registeredRawLock(): RawLock | undefined {
  return registered;
}

function parseStatement(value: unknown): RawLockStatement | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.sql !== "string") return undefined;
  if (value.kind !== "read" && value.kind !== "write") return undefined;
  if (!Array.isArray(value.params) || !Array.isArray(value.columns)) return undefined;
  const params: RawLockParam[] = [];
  for (const item of value.params) {
    const parsed = parseTyped(item);
    if (parsed === undefined) return undefined;
    params.push(parsed);
  }
  const columns: RawLockColumn[] = [];
  for (const item of value.columns) {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.nullable !== "boolean") {
      return undefined;
    }
    const parsed = parseTyped(item);
    if (parsed === undefined) return undefined;
    columns.push({ name: item.name, ...parsed, nullable: item.nullable });
  }
  return { sql: value.sql, kind: value.kind, params, columns };
}

function parseTyped(
  value: unknown,
): { readonly pgType: string; readonly enumLabels?: readonly string[] } | undefined {
  if (!isRecord(value) || typeof value.pgType !== "string") return undefined;
  if (value.enumLabels === undefined) return { pgType: value.pgType };
  if (
    !Array.isArray(value.enumLabels) ||
    value.enumLabels.some((item) => typeof item !== "string")
  ) {
    return undefined;
  }
  return { pgType: value.pgType, enumLabels: value.enumLabels as readonly string[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
