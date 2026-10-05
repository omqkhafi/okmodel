/**
 * The apply-time `uuidv7()` check (D184): what it finds, when it asks the
 * server, and what it says. The real-server cases are in `uuidv7-apply-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import type { DriverConnection } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { assertUuidV7Available, findUuidV7Default } from "../src/tooling/migrate/engine.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";
import type { PlanStep } from "../src/tooling/migrate/plan.js";

const CREATE = `create table "public"."users" (
  "id" uuid not null default uuidv7(),
  "name" text not null,
  primary key ("id")
)`;

test("a create table, an added column and a changed default are all found, with their names", () => {
  expect(findUuidV7Default([migration("0001_init", [step("select 1"), step(CREATE)])])).toEqual({
    migrationId: "0001_init",
    stepIndex: 1,
    column: "users.id",
  });
  expect(
    findUuidV7Default([
      migration("0002_add", [
        step(`alter table "public"."posts" add column "key" uuid not null default uuidv7()`),
      ]),
    ])?.column,
  ).toBe("posts.key");
  expect(
    findUuidV7Default([
      migration("0003_set", [
        step(`alter table "public"."posts" alter column "id" set default uuidv7()`),
      ]),
    ])?.column,
  ).toBe("posts.id");
});

test("other defaults and a string that mentions uuidv7() are not hits", () => {
  expect(
    findUuidV7Default([
      migration("0001", [
        step(`create table "t" ("id" uuid not null default gen_random_uuid())`),
        step(`insert into "notes" ("body") values ('default uuidv7 is slow')`),
        step(`alter table "t" alter column "id" drop default`),
      ]),
    ]),
  ).toBeUndefined();
});

test("a schema without the default does not ask the server", async () => {
  const sent: string[] = [];
  await assertUuidV7Available(connection(sent, ["170000", null]), [
    migration("0001", [step(`create table "t" ("id" integer)`)]),
  ]);
  expect(sent).toEqual([]);
});

test("a server older than 18 is refused with OKM1812 and both fixes", async () => {
  const error = await caught(() =>
    assertUuidV7Available(connection([], ["170004", null]), [
      migration("0001_init", [step(CREATE)]),
    ]),
  );
  expect(error.code).toBe("OKM1812");
  expect(error.message).toContain("users.id");
  expect(error.message).toContain("PostgreSQL 17");
  expect(error.message).toContain("0001_init");
  expect(error.fix.summary).toContain("schema({ requires");
  expect(error.fix.summary).toContain('t.id({ default: "uuidv4" })');
});

test("PostgreSQL 18, or a uuidv7() function the server already has, is accepted", async () => {
  const migrations = [migration("0001_init", [step(CREATE)])];
  await assertUuidV7Available(connection([], ["180000", null]), migrations);
  await assertUuidV7Available(connection([], ["150000", "uuidv7()"]), migrations);
});

function migration(id: string, steps: readonly PlanStep[]): StoredMigration {
  return { id, catalogHash: `hash-${id}`, steps };
}

function step(sql: string): PlanStep {
  return { sql, class: "expand", action: "ddl", lock: "ACCESS EXCLUSIVE", transactional: true };
}

function connection(sent: string[], row: readonly (string | null)[]): DriverConnection {
  return {
    execute(sql: string) {
      sent.push(sql);
      return Promise.resolve({ rows: [row], count: 1, notices: [] });
    },
  } as unknown as DriverConnection;
}

async function caught(run: () => Promise<unknown>): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OKM1812");
}
