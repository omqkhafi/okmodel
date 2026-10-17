/**
 * Offline coverage for the 0.9.1 migrate push/check board (B-26, B-36).
 */

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { run } from "../src/tooling/migrate/commands.js";
import { lintMigrationDirectory, lintPlan } from "../src/tooling/migrate/lint.js";
import { parsePlan } from "../src/tooling/migrate/plan.js";
import { serializeCatalog } from "../src/contracts/catalog/document.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

test("an unknown flag is refused and --help lists flags", async () => {
  const unknown = await capture(["push", "--not-a-flag"]);
  expect(unknown.error?.code).toBe("invalid");
  expect(unknown.error?.message).toContain("Unknown flag --not-a-flag");
  const help = await capture(["migrate", "check", "--help"]);
  expect(help.stdout).toContain("Flags:");
  expect(help.stdout).toContain("--provision");
  expect(help.stdout).toContain("--target");
});

test("the type-change switch-reads recipe is clean under the CLI linter", () => {
  const before = schema({
    tables: [
      table("prices", {
        id: t.integer().primaryKey(),
        cents: t.integer(),
        amount: t.numeric(12, 2).nullable(),
      }),
    ],
  }).catalog;
  const after = schema({
    tables: [
      table("prices", {
        id: t.integer().primaryKey(),
        cents: t.integer(),
        amount: t.numeric(12, 2),
      }),
    ],
  }).catalog;
  const sql = `-- class: expand

alter table "public"."prices" add constraint "prices_amount_not_null" check ("amount" is not null) not valid;

alter table "public"."prices" validate constraint "prices_amount_not_null";

alter table "public"."prices" alter column "amount" set not null;

alter table "public"."prices" drop constraint "prices_amount_not_null";
`;
  expect(lintPlan(parsePlan(sql), before, after).map((item) => item.code)).toEqual([]);

  const cwd = mkdtempSync(join(tmpdir(), "okm-type-change-lint-"));
  const migrations = join(cwd, "migrations");
  mkdirSync(migrations);
  try {
    writeFileSync(join(migrations, "0001_base.sql"), "-- class: expand\n-- no steps\n");
    writeFileSync(join(migrations, "0001_base.catalog.json"), serializeCatalog(before));
    writeFileSync(join(migrations, "0002_switch.sql"), sql);
    writeFileSync(join(migrations, "0002_switch.catalog.json"), serializeCatalog(after));
    expect(
      lintMigrationDirectory(migrations, new Set(["0002_switch"])).map((item) => item.code),
    ).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the type-change drop recipe allows OKM1515 on the dual-write function", () => {
  const before = schema({
    tables: [
      table("prices", {
        id: t.integer().primaryKey(),
        cents: t.integer(),
        amount: t.numeric(12, 2),
      }),
    ],
  }).catalog;
  const after = schema({
    tables: [table("prices", { id: t.integer().primaryKey(), amount: t.numeric(12, 2) })],
  }).catalog;
  const sql = `-- class: contract
-- okm-allow OKM1512: readers and writers use amount
drop trigger "prices_amount_sync" on "public"."prices";

-- class: contract
-- okm-allow OKM1515: dual-write trigger removed
drop function "public"."prices_amount_sync"();

-- class: contract
-- okm-allow OKM1512: readers and writers use amount
alter table "public"."prices" drop column "cents";
`;
  expect(lintPlan(parsePlan(sql), before, after).map((item) => item.code)).toEqual([]);
});

async function capture(
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly error?: OkmError }> {
  const lines: string[] = [];
  try {
    await run(argv, {
      cwd: root,
      stdout: (text) => {
        lines.push(text);
      },
    });
    return { stdout: lines.join("") };
  } catch (error) {
    return { stdout: lines.join(""), error: OkmError.from(error) };
  }
}
