/**
 * The `-- okm-allow` audit: the listing, the weak-reason warning, and `okm.cli/1` data.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";
import {
  allowFindings,
  allowRecords,
  formatAllows,
  listAllows,
  weakAllowReason,
} from "../src/tooling/migrate/allows.js";
import { schemaFor, schemaProblems } from "../src/tooling/cli/schema.js";
import { errorDoc } from "../src/tooling/errors/registry.js";
import { bypassTokensIn } from "../src/tooling/errors/shape.js";

const root = repoRoot();

const DROP = (reason: string): string =>
  [
    "-- class: contract",
    "-- name: drop",
    "",
    "-- class: contract",
    "-- kind: drop-table",
    "-- action: ddl",
    "-- lock: ACCESS EXCLUSIVE",
    `-- okm-allow OKM1511${reason}`,
    'drop table "public"."notes"',
    "",
  ].join("\n");

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-allows-"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { identity, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
      'export const app = schema({ tables: [table("notes", { id: identity(), title: text() })] });',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      'export default defineConfig({ schema: "./schema.ts", migrations: "./migrations" });',
      "",
    ].join("\n"),
  );
  mkdirSync(join(cwd, "migrations"));
  return cwd;
}

function okm(args: readonly string[], cwd: string) {
  const proc = spawnSync("bun", [join(root, "src/tooling/cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
  });
  return { code: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr };
}

test("a reason is weak when short, stop-list only, or the code repeated", () => {
  for (const reason of ["", "ok", "fix", "TODO", "tmp.", "na", "needed", "too brief"]) {
    expect(weakAllowReason(reason, "OKM1511")).toBeDefined();
  }
  expect(weakAllowReason("OKM1511", "OKM1511")).toBe("only repeats the code");
  expect(weakAllowReason("okm1511: OKM1511", "OKM1511")).toBe("only repeats the code");
  expect(weakAllowReason("todo todo temp temp", "OKM1511")).toBe("is only stop-list words");
  expect(weakAllowReason("............", "OKM1511")).toBe("has no words");
  expect(weakAllowReason("12345678901", "OKM1511")).toBe("is shorter than 12 characters");
  expect(weakAllowReason("123456789012", "OKM1511")).toBeUndefined();
  expect(weakAllowReason("the table is empty and unread", "OKM1511")).toBeUndefined();
  expect(weakAllowReason("todo: move rows to the archive first", "OKM1511")).toBeUndefined();
});

test("the registry entry exists and never names a bypass", () => {
  const doc = errorDoc("OKM2300");
  expect(doc?.title).toBe("Weak override reason");
  expect(bypassTokensIn(`${doc?.summary ?? ""} ${doc?.fix ?? ""}`)).toEqual([]);
});

test("the listing names migration, step, code, class, and flags destructive rules", () => {
  const cwd = project();
  try {
    const migrations = join(cwd, "migrations");
    writeFileSync(join(migrations, "0002_drop.sql"), DROP(": ok"));
    writeFileSync(
      join(migrations, "0003_other.sql"),
      [
        "-- class: contract",
        "-- name: other",
        "",
        "-- class: contract",
        "-- kind: raw-sql",
        "-- action: ddl",
        "-- lock: ACCESS EXCLUSIVE",
        "create index on notes (title)",
        "",
        "-- class: expand",
        "-- kind: raw-sql",
        "-- action: ddl",
        "-- lock: ACCESS EXCLUSIVE",
        "-- okm-allow OKM1533: values were checked against the new range on 2026-01-05",
        "-- okm-allow OKM1534: the table is empty at this point in the rollout",
        "-- okm-allow OKM1552: the stored form is the same expression, reprinted",
        "-- okm-allow OKM9999: unknown rule but a long enough reason",
        "alter table notes alter column title type text",
        "",
      ].join("\n"),
    );
    const entries = listAllows(migrations);
    expect(
      entries.map((item) => [
        item.migration,
        item.step,
        item.code,
        item.ruleClass,
        item.destructive,
      ]),
    ).toEqual([
      ["0002_drop", 1, "OKM1511", "destructive", true],
      ["0003_other", 2, "OKM1533", "data-dependent", true],
      ["0003_other", 2, "OKM1534", "locking", false],
      ["0003_other", 2, "OKM1552", "reprint", false],
      ["0003_other", 2, "OKM9999", "unknown", false],
    ]);
    const text = formatAllows(entries);
    expect(text).toContain("allow 0002_drop step 1 OKM1511 destructive DESTRUCTIVE: ");
    expect(text).toContain("allow 0003_other step 2 OKM1534 locking: ");
    const findings = allowFindings(entries);
    expect(findings.map((item) => [item.severity, item.code, item.place])).toEqual([
      ["warning", "OKM2300", "0002_drop step 1"],
    ]);
    expect(findings[0]?.reason).toBe(
      "override OKM1511 (destructive) reason is only stop-list words",
    );
    expect(allowRecords(entries)[0]?.reason).toMatchObject({
      untrusted: true,
      origin: "migration.comment",
      text: "ok",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a missing directory and an unreadable file list nothing and throw nothing", () => {
  const cwd = project();
  try {
    expect(listAllows(join(cwd, "nowhere"))).toEqual([]);
    writeFileSync(join(cwd, "migrations", "0001_empty.sql"), "");
    expect(listAllows(join(cwd, "migrations"))).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("okm check lists the overrides, warns on a weak reason, and still exits 0", () => {
  const cwd = project();
  try {
    expect(okm(["generate", "init"], cwd).code).toBe(0);
    const migrations = join(cwd, "migrations");
    copyFileSync(
      join(migrations, "0001_init.catalog.json"),
      join(migrations, "0002_drop.catalog.json"),
    );
    writeFileSync(join(migrations, "0002_drop.sql"), DROP(": ok"));
    writeFileSync(
      join(migrations, "0003_drop.sql"),
      DROP(": the table was archived and the export verified"),
    );
    copyFileSync(
      join(migrations, "0001_init.catalog.json"),
      join(migrations, "0003_drop.catalog.json"),
    );

    const human = okm(["check"], cwd);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(
      "warning OKM2300 0002_drop step 1: override OKM1511 (destructive) reason is only stop-list words",
    );
    expect(human.stdout).not.toContain("0003_drop step 1: override");
    expect(human.stdout).toContain("allow 0002_drop step 1 OKM1511 destructive DESTRUCTIVE: ");
    expect(human.stdout).toContain("allow 0003_drop step 1 OKM1511 destructive DESTRUCTIVE: ");
    expect(human.stdout.trimEnd().endsWith("ok")).toBe(true);

    const json = okm(["check", "--json"], cwd);
    expect(json.code).toBe(0);
    const envelope = JSON.parse(json.stdout) as {
      data: {
        allows: { migration: string; step: number; code: string; reason: { text: string } }[];
      };
      warnings: { code?: string }[];
    };
    expect(schemaProblems(schemaFor("check"), envelope.data)).toEqual([]);
    expect(envelope.data.allows.map((item) => [item.migration, item.step, item.code])).toEqual([
      ["0002_drop", 1, "OKM1511"],
      ["0003_drop", 1, "OKM1511"],
    ]);
    expect(envelope.data.allows[0]?.reason.text).toBe("ok");
    expect(envelope.warnings.filter((item) => item.code === "OKM2300")).toHaveLength(1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("okm check without overrides prints an empty allows array", () => {
  const cwd = project();
  try {
    expect(okm(["generate", "init"], cwd).code).toBe(0);
    const json = okm(["check", "--json"], cwd);
    const envelope = JSON.parse(json.stdout) as { data: unknown };
    expect(envelope.data).toEqual({ status: "ok", allows: [] });
    expect(readFileSync(join(cwd, "migrations", "0001_init.sql"), "utf8")).not.toContain("allow");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the migrate check data schema accepts allows and keeps text required", () => {
  const schema = schemaFor("migrate check");
  const allows = allowRecords(
    listAllows(join(root, "tests/fixtures/does-not-exist")).concat([
      {
        migration: "0002_drop",
        step: 1,
        code: "OKM1511",
        ruleClass: "destructive",
        destructive: true,
        reason: "ok",
      },
    ]),
  );
  expect(schemaProblems(schema, { text: "ok 1 migrations\n", allows })).toEqual([]);
  expect(schemaProblems(schema, { text: "ok 1 migrations\n" })).toEqual([]);
  expect(schemaProblems(schema, { allows })).not.toEqual([]);
  expect(schemaProblems(schema, { text: "x", allows: [{ migration: "0002" }] })).not.toEqual([]);
});
