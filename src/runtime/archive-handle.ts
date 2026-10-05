/**
 * Table methods `archivable()` adds through the shared client hook.
 *
 * Core does not name `archive` or `restore`. A failed import of the statement
 * chunk rejects the call. The active-set predicate stays in the planner.
 */

import type { DriverPool } from "../contracts/driver.js";
import { OkmError, type ErrorStatuses } from "../contracts/error.js";
import type { PresetUse, QuerySchema, SchemaHookCtx } from "../dialects/pg/model.js";
import { attachHttp, queryHandle, settleCall } from "./client.js";
import type { CallScope } from "./plan.js";
import type { Hookm, Timeouts } from "./types.js";

type Host = {
  readonly schema: QuerySchema;
  readonly pool: DriverPool;
  readonly timeouts?: Timeouts | undefined;
  readonly hookm?: readonly Hookm[] | undefined;
  readonly tx?: object | undefined;
  readonly scope?: CallScope;
  readonly http?: ErrorStatuses;
  readonly includeValues: boolean;
  readonly connected: Promise<void>;
  readonly logger?: { error?(entry: { readonly code: string; readonly summary: string }): void };
};

type Op = "archive" | "restore";

type Mods = {
  readonly all?: string;
  readonly expect?: number;
  /** Presets chained on the handle. They narrow the rows archived or restored. */
  readonly uses?: PresetUse | undefined;
  /** Filters the presets added. Set by `settle` just before the statement is planned. */
  readonly presets?: readonly unknown[];
};

/**
 * Adds `archive`, `restore`, `withArchived`, and `onlyArchived` to one table.
 *
 * A table that is not archivable still receives the methods when the schema
 * imported the trait, and a call throws OKM1052. The throw for a missing model
 * is repeated by the statement chunk if execution reaches it.
 *
 * @param target - The table handle being built
 * @param ctx - Table name, visibility, and the session
 */
export function attachArchive(target: Record<string, unknown>, ctx: SchemaHookCtx): void {
  const table = ctx.table;
  const reopen = ctx.reopen;
  const session = ctx.session;
  if (table === undefined || reopen === undefined || session === undefined) return;
  const host = session as Host;
  const mods: Mods = { uses: ctx.uses };
  target.archive = (input: unknown, options: object = {}) =>
    lifecycle(host, "archive", table, input, options, mods);
  target.restore = (input: unknown, options: object = {}) =>
    lifecycle(host, "restore", table, input, options, mods);
  target.withArchived = () => {
    refuse(host, table);
    return reopen("with");
  };
  target.onlyArchived = () => {
    refuse(host, table);
    return reopen("only");
  };
}

function lifecycle(
  host: Host,
  op: Op,
  table: string,
  input: unknown,
  options: object,
  mods: Mods,
): Promise<unknown> & Record<string, unknown> {
  refuse(host, table);
  return queryHandle(() => run(host, op, table, input, options, mods), {
    // `batch` plans each operation and runs the statements of all of them as one unit.
    "~plan": async () => {
      await host.connected;
      const [mod, planned] = await Promise.all([loadArchive(), settle(host, table, mods)]);
      try {
        return mod.prepareArchive(host.schema, op, table, input, options, planned, host.scope);
      } catch (error) {
        return settleCall(host as unknown as Parameters<typeof settleCall>[0], error);
      }
    },
    sql() {
      return Promise.all([loadArchive(), settle(host, table, mods)]).then(([mod, planned]) =>
        mod.explainArchive(host.schema, op, table, input, options, planned, host.scope),
      );
    },
    expect(count: number) {
      return lifecycle(host, op, table, input, options, { ...mods, expect: count });
    },
    all(reason: string) {
      return lifecycle(host, op, table, input, options, { ...mods, all: reason });
    },
  }) as unknown as Promise<unknown> & Record<string, unknown>;
}

function refuse(host: Host, table: string): void {
  if (host.schema.model[table]?.archive !== undefined) return;
  throw attachHttp(
    host.http,
    new OkmError("OKM1052", `Table ${table} is not archivable.`, {
      fix: { summary: "Call archive and restore only on an archivable table." },
    }),
  );
}

let archiveMod: Promise<typeof import("./archive.js")> | undefined;

function loadArchive(): Promise<typeof import("./archive.js")> {
  archiveMod ??= import("./archive.js");
  return archiveMod;
}

/** Runs the chained presets, when there are any, so the statement can hold their filters. */
async function settle(host: Host, table: string, mods: Mods): Promise<Mods> {
  if (mods.uses === undefined) return mods;
  const { resolve } = await import("./presets.js");
  return { ...mods, presets: resolve(host.schema, table, mods.uses).wheres };
}

async function run(
  host: Host,
  op: Op,
  table: string,
  input: unknown,
  options: object,
  mods: Mods,
): Promise<unknown> {
  await host.connected;
  const mod = await loadArchive();
  try {
    return await mod.executeArchive(
      host,
      op,
      table,
      input,
      options,
      await settle(host, table, mods),
      host.scope,
    );
  } catch (error) {
    return settleCall(host as unknown as Parameters<typeof settleCall>[0], error);
  }
}
