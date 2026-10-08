/**
 * OKM1104 names each accepted constraint once and omits the tenant key (QA-L11).
 *
 * The table is a stand-in with the two fields `readConflict` reads. The write
 * path that calls it is covered in `pg-write.test.ts`.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { readConflict } from "../src/runtime/conflict.js";

function tenantTable(uniques: readonly (readonly string[])[]): never {
  return { model: { name: "tasks", uniques }, columns: new Map() } as never;
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error.message;
    throw error;
  }
  throw new Error("expected OKM1104");
}

test("the tenant key is left out of the accepted list and named once (QA-L11)", () => {
  const table = tenantTable([
    ["tenant_id", "title"],
    ["tenant_id", "title"],
    ["tenant_id", "id"],
  ]);
  const message = messageOf(() =>
    readConflict(table, { on: "nope", return: true }, undefined, "tenant_id"),
  );
  expect(message).toBe(
    "onConflict on tasks names nope, which is not a unique constraint. Accepted: title, id. The tenant key tenant_id is part of each one and is not named here.",
  );
});

test("a multi-column constraint is in parentheses and a plain table has no tenant sentence (QA-L11)", () => {
  const table = tenantTable([["sku", "warehouse"], ["id"]]);
  const message = messageOf(() => readConflict(table, { on: "nope", return: true }));
  expect(message).toBe(
    "onConflict on tasks names nope, which is not a unique constraint. Accepted: (sku, warehouse), id.",
  );
});
