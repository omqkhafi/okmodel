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
};

type Handle = Promise<unknown> & {
  sql: () => Promise<unknown>;
  expect: (count: number) => Handle;
  all: (reason: string) => Handle;
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
  const wrapped = guardWrite(insert as Write, "insert", model, source, schema.validation);
  wrapped.validate = (body: unknown) =>
    stand(model, source, schema.validation, "insert", body, "valid");
  wrapped.check = (body: unknown) =>
    stand(model, source, schema.validation, "insert", body, "check");
  wrapped.pick = (...keys: string[]) => ({
    validate: (body: unknown) =>
      stand(model, source, schema.validation, "insert", body, "valid", keys),
    check: (body: unknown) =>
      stand(model, source, schema.validation, "insert", body, "check", keys),
  });
  wrapped.omit = (...keys: string[]) => ({
    validate: (body: unknown) =>
      stand(model, source, schema.validation, "insert", body, "valid", undefined, keys),
    check: (body: unknown) =>
      stand(model, source, schema.validation, "insert", body, "check", undefined, keys),
  });
  wrapped["~standard"] = {
    version: 1,
    vendor: "okmodel",
    async validate(value: unknown) {
      try {
        return {
          value: await stand(model, source, schema.validation, "insert", value, "valid"),
        };
      } catch (error) {
        if (error instanceof OkmError && error.issues !== undefined)
          return { issues: error.issues };
        throw error;
      }
    },
  };
  target.insert = wrapped;
  const wrappedUpdate = guardWrite(update as Write, "update", model, source, schema.validation);
  wrappedUpdate.validate = (body: unknown) =>
    stand(model, source, schema.validation, "update", body, "valid");
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
): Promise<unknown> {
  return loadEngine().then((mod) =>
    mod.stand(model, source, schemaFlag, op, body, mode, pick, omit),
  );
}

type Deliver = (ok: (handle: Handle) => void, fail: (error: unknown) => void) => void;

function guardWrite(
  original: Write,
  op: "insert" | "update",
  model: TableModel,
  source: AnyTable,
  schemaFlag: unknown,
): Write & Record<string, unknown> {
  const wrapped = (data: unknown, options: object = {}): Handle => {
    const rest = dropValidate(options);
    if (skipped(options)) return original(data, rest);
    return chain((ok, fail) => {
      void loadEngine().then((mod) => {
        void mod
          .prepare(model, source, schemaFlag, op, data)
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
 * handle is stored in a slot and never passed to `resolve`.
 *
 * @param start - Delivers the handle after validation
 * @returns A handle with `sql`, `expect`, and `all`
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
    sql: () => ready().then(() => taken().sql()),
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
