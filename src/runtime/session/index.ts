/**
 * Transaction-local session settings (`okmodel/session`).
 *
 * `sessionSettings()` declares the settings an application passes to the
 * database, such as `app.user_id`, for a row-level security policy or a
 * trigger to read. `connect({ session })` installs them and `db.with()` gives
 * the values. Each unit sets them in one `set_config(..., true)` statement
 * that is the first statement of its transaction. A transaction-mode pooler
 * cannot hand them to the next client. Not in the runtime entry.
 */

import { OkmError } from "../../contracts/error.js";
import type { DriverPool } from "../../contracts/driver.js";
import type { SchemaHook } from "../../dialects/pg/model.js";
import { INNER, isWrapped, wrapPool, type Setting } from "../tenancy/scope-pool.js";

/** Column types a setting can declare. The value is text on the wire. */
export type SettingType = "text" | "uuid" | "int" | "bool";

/** One declared setting. */
export type SettingDecl = {
  /** The Postgres setting name. It has a dot, like `app.user_id`. */
  readonly name: string;
  readonly type: SettingType;
  /** Every `db.with()` must give it, and a client with no `with()` refuses statements. */
  readonly required?: true;
};

/** Declared settings by the key `db.with()` takes. */
export type SettingMap = Readonly<Record<string, SettingDecl>>;

type ValueOf<T extends SettingType> = T extends "int"
  ? number
  : T extends "bool"
    ? boolean
    : string;

type RequiredKey<M extends SettingMap> = {
  readonly [K in keyof M]: M[K] extends { readonly required: true } ? K : never;
}[keyof M];

/**
 * What `db.with()` takes: every required key, and the optional ones.
 *
 * @typeParam M - The map `sessionSettings()` was given
 */
export type SessionValues<M extends SettingMap> = {
  readonly [K in RequiredKey<M>]: ValueOf<M[K]["type"]>;
} & {
  readonly [K in Exclude<keyof M, RequiredKey<M>>]?: ValueOf<M[K]["type"]>;
};

/**
 * The value `sessionSettings()` returns and `connect({ session })` takes.
 *
 * @typeParam M - The declared settings
 */
export type SessionContext<M extends SettingMap = SettingMap> = {
  /** Type-only. Reads the declaration. */
  readonly "~settings"?: M;
  /** The client hook `connect` installs. */
  readonly hook: SchemaHook;
};

type Entry = {
  readonly key: string;
  readonly name: string;
  readonly type: SettingType;
  readonly required: boolean;
};

type Pairs = readonly Setting[];

const TYPES: readonly string[] = ["text", "uuid", "int", "bool"];
const NAME = /^[a-z_][a-z0-9_$]*(\.[a-z_][a-z0-9_$]*)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWN = ["app.tenant", "app.unscoped"];
/** Prefixes of settings PostgreSQL and its bundled extensions own. */
const BUILT_IN = [
  "plpgsql",
  "pltcl",
  "plperl",
  "pg_stat_statements",
  "auto_explain",
  "pg_trgm",
  "pg_prewarm",
  "sepgsql",
  "pgaudit",
];

function bad(message: string, fix: string): never {
  throw new OkmError("OKM1709", message, { fix: { summary: fix } });
}

/**
 * Declares transaction-local session settings.
 *
 * Each key becomes a key of `db.with()`. The name must have a dot and cannot
 * start with `app.tenant` or `app.unscoped` or be a built-in setting. Read it
 * in SQL as `NULLIF(current_setting('app.user_id', true), '')` before a cast:
 * after the transaction the setting reads as an empty string, not NULL.
 *
 * It does not authenticate. A role that can run SQL can set the same names.
 *
 * @typeParam M - The declared settings
 * @param settings - Key to `{ name, type, required? }`. Types: text, uuid, int, bool
 * @returns The context `connect({ session })` takes
 * @throws OkmError OKM1709 for a name or type that is not accepted
 */
export function sessionSettings<const M extends SettingMap>(settings: M): SessionContext<M> {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    bad("sessionSettings() takes an object of settings.", "Pass { key: { name, type } }.");
  }
  const entries: Entry[] = [];
  const names = new Set<string>();
  for (const key of Object.keys(settings)) {
    const decl = settings[key] as SettingDecl | null;
    if (typeof decl !== "object" || decl === null) {
      bad(`Setting ${key} needs { name, type }.`, "Pass { name: 'app.user_id', type: 'uuid' }.");
    }
    const { name, type, required } = decl;
    if (typeof name !== "string" || !name.includes(".")) {
      bad(
        `Setting ${key} name needs a dot, like app.user_id.`,
        "Prefix the name, as in app.user_id.",
      );
    }
    const lower = name.toLowerCase();
    if (OWN.some((own) => lower.startsWith(own)) || BUILT_IN.includes(lower.split(".")[0] ?? "")) {
      bad(
        `Setting ${key} name ${name} is taken by Postgres or okm.`,
        "Pick another name, such as app.user_id.",
      );
    }
    if (!NAME.test(lower)) {
      bad(
        `Setting ${key} name ${name} is not a setting name.`,
        "Use letters, digits and _ in dotted words.",
      );
    }
    if (!TYPES.includes(type)) {
      bad(`Setting ${key} type ${String(type)} is not accepted.`, "Types: text, uuid, int, bool.");
    }
    if (required !== undefined && required !== true) {
      bad(
        `Setting ${key} required must be true when set.`,
        "Write required: true, or leave it out.",
      );
    }
    if (names.has(lower))
      bad(`Setting name ${name} is declared twice.`, "Give each key its own name.");
    names.add(lower);
    entries.push({ key, name: lower, type, required: required === true });
  }
  return { hook: (target, ctx) => install(target, ctx, entries) };
}

function install(
  target: Record<string, unknown>,
  ctx: Parameters<SchemaHook>[1],
  entries: readonly Entry[],
): void {
  if (ctx.table === undefined) {
    const set = ctx.set;
    if (set !== undefined)
      target.with = (values: unknown) => set((was) => merge(entries, was, values));
    return;
  }
  const held = ctx.session as
    | {
        pool: DriverPool;
        readonly scope?: object;
        readonly settings?: Pairs;
        readonly tx?: object;
        readonly schema: { readonly tenancy?: { readonly strategy?: string } };
      }
    | undefined;
  if (held === undefined) return;
  if (held.settings === undefined) {
    if (entries.some((entry) => entry.required) && !("~refused" in held.pool)) {
      held.pool = refusing(held.pool, entries);
    }
    return;
  }
  // Under rls a scoped client sets the tenant and these in one statement.
  if (held.settings.length === 0 || isWrapped(held.pool)) return;
  if (held.scope !== undefined && held.schema.tenancy?.strategy === "rls") return;
  held.pool = wrapPool(held.pool, undefined, held.settings, held.tx !== undefined);
}

function merge(entries: readonly Entry[], was: Pairs | undefined, values: unknown): Pairs {
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    bad("with() takes an object of values.", "Pass db.with({ userId }).");
  }
  const given = values as Readonly<Record<string, unknown>>;
  const next = new Map<string, string>(was);
  for (const key of Object.keys(given)) {
    if (!entries.some((entry) => entry.key === key)) {
      bad(`with() does not know ${key}.`, `Declared: ${entries.map((e) => e.key).join(", ")}.`);
    }
  }
  for (const entry of entries) {
    const value = given[entry.key];
    if (value !== undefined) next.set(entry.name, wire(entry, value));
  }
  const absent = entries.find((entry) => entry.required && !next.has(entry.name));
  if (absent !== undefined) throw missing(absent);
  return [...next].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function wire(entry: Entry, value: unknown): string {
  switch (entry.type) {
    case "text":
      if (typeof value === "string" && !value.includes("\0")) return value;
      break;
    case "uuid":
      if (typeof value === "string" && UUID.test(value)) return value.toLowerCase();
      break;
    case "int":
      if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
      break;
    default:
      if (typeof value === "boolean") return value ? "true" : "false";
  }
  return bad(
    `with() ${entry.key} is not a ${entry.type}.`,
    `Pass a ${entry.type} for ${entry.key}.`,
  );
}

function missing(entry: Entry): OkmError {
  return new OkmError("OKM1709", `Session setting ${entry.key} is required.`, {
    fix: { summary: `Call db.with({ ${entry.key} }) first.` },
  });
}

/** A pool that fails every statement, for a client that skipped `with()`. */
function refusing(pool: DriverPool, entries: readonly Entry[]): DriverPool {
  const first = entries.find((entry) => entry.required) as Entry;
  const fail = (): Promise<never> => Promise.reject(missing(first));
  const refused: DriverPool & { "~refused": true; [INNER]: DriverPool } = {
    ...pool,
    "~refused": true,
    [INNER]: pool,
    execute: fail,
    batch: fail,
  };
  if (pool.reserve !== undefined) refused.reserve = fail;
  if (pool.stream !== undefined) {
    refused.stream = () =>
      (async function* () {
        await fail();
        yield [];
      })();
  }
  return refused;
}
