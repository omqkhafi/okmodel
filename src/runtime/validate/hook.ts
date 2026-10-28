/**
 * Table methods validation adds through the shared client hook.
 *
 * Core does not name `insert.validate`. The engine loads on the first call.
 */

import { OkmError } from "../../contracts/error.js";
import type { TableModel } from "../../dialects/pg/model.js";
import type { SchemaHookCtx } from "../../dialects/pg/model.js";
import type { AnyTable } from "../../dialects/pg/table.js";
import { queryHandle } from "../client.js";
import { loadEngine } from "./load.js";
import { validationGate } from "./places.js";

type Built = {
  readonly validation?: unknown;
  readonly tables: readonly AnyTable[];
  readonly model: Readonly<Record<string, TableModel>>;
  readonly tenancy?: { readonly key: string; readonly keys?: readonly string[] };
};

function tenantKeyList(schema: Built): readonly string[] {
  const tenancy = schema.tenancy;
  if (tenancy === undefined) return [];
  if (tenancy.keys !== undefined && tenancy.keys.length > 0) return tenancy.keys;
  return [tenancy.key];
}

type Handle = Promise<unknown> & {
  sql: () => Promise<unknown>;
  expect: (count: number) => Handle;
  all: (reason: string) => Handle;
  /** Plans the write without running it. `batch` reads this. */
  "~plan": () => Promise<unknown>;
  /** Present when the underlying write exposes it. */
  inspect?: () => unknown;
};

type Write = (data: unknown, options?: object) => Handle;

/** Registration mark the write chunk reads. Absent when this module never loaded. */
const VALIDATION_HOOK = 1;

/**
 * Adds `insert.validate`, `check`, `pick`, `omit`, and the Standard Schema
 * surface when this table's validation is on.
 *
 * A client-level call has no table and does nothing. A table with validation
 * off is left as core built it.
 *
 * @param target - The table handle being built
 * @param ctx - Table name and the session
 */
export function attachValidation(target: Record<string, unknown>, ctx: SchemaHookCtx): void {
  if ((attachValidation as { readonly "~v"?: number })["~v"] !== VALIDATION_HOOK) return;
  const name = ctx.table;
  const session = ctx.session as { readonly schema?: Built } | undefined;
  const schema = session?.schema;
  if (name === undefined || schema === undefined) return;
  const source = schema.tables.find((item) => item.name === name);
  const model = schema.model[name];
  if (
    source === undefined ||
    model === undefined ||
    validationGate(schema.validation, source) === undefined
  ) {
    return;
  }
  const insert = target.insert;
  const update = target.update;
  if (typeof insert !== "function" || typeof update !== "function") return;
  const tenant = tenantKeyList(schema);
  const wrapped = guardWrite(insert as Write, "insert", model, source, schema.validation, tenant);
  wrapped.validate = (body: unknown) =>
    stand(model, source, schema.validation, "insert", body, "valid", undefined, undefined, tenant);
  wrapped.check = (body: unknown) =>
    stand(model, source, schema.validation, "insert", body, "check", undefined, undefined, tenant);
  wrapped.pick = (...keys: string[]) => ({
    validate: (body: unknown) =>
      stand(model, source, schema.validation, "insert", body, "valid", keys, undefined, tenant),
    check: (body: unknown) =>
      stand(model, source, schema.validation, "insert", body, "check", keys, undefined, tenant),
  });
  wrapped.omit = (...keys: string[]) => ({
    validate: (body: unknown) =>
      stand(model, source, schema.validation, "insert", body, "valid", undefined, keys, tenant),
    check: (body: unknown) =>
      stand(model, source, schema.validation, "insert", body, "check", undefined, keys, tenant),
  });
  wrapped["~standard"] = {
    version: 1,
    vendor: "okmodel",
    async validate(value: unknown) {
      try {
        return {
          value: await stand(
            model,
            source,
            schema.validation,
            "insert",
            value,
            "valid",
            undefined,
            undefined,
            tenant,
          ),
        };
      } catch (error) {
        if (error instanceof OkmError && error.issues !== undefined)
          return { issues: error.issues };
        throw error;
      }
    },
  };
  target.insert = wrapped;
  const wrappedUpdate = guardWrite(
    update as Write,
    "update",
    model,
    source,
    schema.validation,
    tenant,
  );
  wrappedUpdate.validate = (body: unknown) =>
    stand(model, source, schema.validation, "update", body, "valid", undefined, undefined, tenant);
  target.update = wrappedUpdate;
}

function stand(
  model: TableModel,
  source: AnyTable,
  schemaFlag: unknown,
  op: "insert" | "update",
  body: unknown,
  mode: "valid" | "check",
  pick?: readonly string[],
  omit?: readonly string[],
  tenant: readonly string[] = [],
): Promise<unknown> {
  return loadEngine().then((mod) =>
    mod.stand(model, source, schemaFlag, op, body, mode, pick, omit, tenant),
  );
}

type Deliver = (ok: (handle: Handle) => void, fail: (error: unknown) => void) => void;

function guardWrite(
  original: Write,
  op: "insert" | "update",
  model: TableModel,
  source: AnyTable,
  schemaFlag: unknown,
  tenant: readonly string[],
): Write & Record<string, unknown> {
  const wrapped = (data: unknown, options: object = {}): Handle => {
    const rest = dropValidate(options);
    if (skipped(options)) return original(data, rest);
    return chain((ok, fail) => {
      void loadEngine().then((mod) => {
        void mod
          .prepare(model, source, schemaFlag, op, data, tenant)
          .then((next) => ok(original(next, rest)), fail);
      }, fail);
    });
  };
  return wrapped as Write & Record<string, unknown>;
}

/**
 * A write handle that waits for validation, then forwards to the real handle.
 *
 * The real handle is a thenable. A native promise would unwrap it, so the
 * handle is stored in a slot and never passed to `resolve`. `batch` plans
 * through `~plan` after the same validation step, before any statement runs.
 *
 * @param start - Delivers the handle after validation
 * @returns A handle with `~plan`, `sql`, `expect`, and `all`
 */
function chain(start: Deliver): Handle {
  let slot: Handle | undefined;
  let pending: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    pending ??= new Promise((resolve, reject) => {
      start((handle) => {
        slot = handle;
        resolve();
      }, reject);
    });
    return pending;
  };
  const taken = (): Handle => {
    if (slot === undefined) throw new Error("Validation did not produce a write.");
    return slot;
  };
  return queryHandle(() => ready().then(() => taken()), {
    "~plan": () => ready().then(() => taken()["~plan"]()),
    sql: () => ready().then(() => taken().sql()),
    inspect() {
      return ready().then(() => {
        const inspect = taken().inspect;
        if (typeof inspect !== "function") {
          return taken().sql();
        }
        return inspect.call(taken());
      });
    },
    expect(count: number) {
      return chain((ok, fail) => {
        void ready().then(() => ok(taken().expect(count)), fail);
      });
    },
    all(reason: string) {
      return chain((ok, fail) => {
        void ready().then(() => ok(taken().all(reason)), fail);
      });
    },
  }) as Handle;
}

(attachValidation as { "~v"?: number })["~v"] = VALIDATION_HOOK;

function skipped(options: object): boolean {
  return (options as { readonly validate?: unknown }).validate === false;
}

function dropValidate(options: object): object {
  if (!("validate" in options)) return options;
  const record = options as { validate?: unknown };
  const { validate: _drop, ...rest } = record;
  return rest;
}
