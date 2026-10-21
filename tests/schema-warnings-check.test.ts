/**
 * `okm check` runs the schema rules (OKM2101, OKM2102, OKM2103) offline.
 *
 * Warnings print and exit 0. Level `error` exits non-zero. An ignore that
 * matched is listed with its reason, and one that matched nothing is stale.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";

const root = repoRoot();
const cli = join(root, "src/tooling/cli.ts");
const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));

type Envelope = {
  readonly ok: boolean;
  readonly data: {
    readonly ignores?: readonly {
      readonly rule: string;
      readonly target?: string;
      readonly status?: string;
      readonly reason: { readonly text: string };
    }[];
  };
  readonly warnings: readonly {
    readonly code?: string;
    readonly place?: string;
    readonly level?: string;
    readonly severity?: string;
    readonly summary: string;
    readonly docs?: string;
    readonly location?: { readonly file: string; readonly line: number };
  }[];
  readonly errors: readonly { readonly code: string; readonly docs?: string }[];
};

function project(warnings: string, tables: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-schema-warn-"));
  mkdirSync(join(cwd, "migrations"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [`import { index, schema, table, t } from ${pg};`, tables, ""].join("\n"),
  );
  writeFileSync(
    join(cwd, "src/routes.ts"),
    [
      `import { table, t } from ${pg};`,
      'const notes = table("notes", { id: t.identity(), title: t.text(), rank: t.text() });',
      "export const noteFilters = notes.filters({",
      '  allow: { title: ["eq"] },',
      '  sort: ["rank"],',
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      warnings,
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}

function run(cwd: string, json: boolean): { code: number; stdout: string; stderr: string } {
  const proc = spawnSync("bun", json ? [cli, "check", "--json"] : [cli, "check"], {
    cwd,
    encoding: "utf8",
  });
  return { code: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr };
}

const BAD = `
const users = table("users", { id: t.identity() });
const posts = table("posts", { id: t.identity(), authorId: t.bigint().references("users") });
const events = table("events", { name: t.text() });
const notes = table("notes", { id: t.identity(), title: t.text(), rank: t.text() });
export const app = schema({ tables: [users, posts, events, notes] });
`;

const FIXED = `
const users = table("users", { id: t.identity() });
const posts = table(
  "posts",
  { id: t.identity(), authorId: t.bigint().references("users") },
  { indexes: (columns) => [index(columns.authorId)] },
);
const events = table("events", { id: t.identity(), name: t.text() });
const notes = table(
  "notes",
  { id: t.identity(), title: t.text(), rank: t.text() },
  { indexes: (columns) => [index(columns.title), index(columns.rank)] },
);
export const app = schema({ tables: [users, posts, events, notes] });
`;

function parse(stdout: string): Envelope {
  return JSON.parse(stdout) as Envelope;
}

test("okm check prints the three schema warnings and exits 0", () => {
  const cwd = project("", BAD);
  const human = run(cwd, false);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain("warn OKM2101 posts.authorId:");
  expect(human.stdout).toContain("warn OKM2102 events:");
  expect(human.stdout).toContain("warn OKM2103 notes.title:");
  expect(human.stdout).toContain("warn OKM2103 notes.rank:");
  expect(human.stdout.trimEnd().endsWith("ok")).toBe(true);

  const json = run(cwd, true);
  expect(json.code).toBe(0);
  const envelope = parse(json.stdout);
  const found = envelope.warnings.filter((item) => item.code?.startsWith("OKM21"));
  expect(found.map((item) => `${item.code} ${item.place}`)).toEqual([
    "OKM2101 posts.authorId",
    "OKM2102 events",
    "OKM2103 notes.rank",
    "OKM2103 notes.title",
  ]);
  for (const item of found) {
    expect(item.level).toBe("warn");
    expect(item.severity).toBe("medium");
    expect(item.docs).toBe(`docs/errors/${item.code}.md`);
  }
  expect(found[2]?.location).toEqual({ file: "src/routes.ts", line: 3 });
});

test("okm check stays silent on a schema where every key and filter is indexed", () => {
  const cwd = project("", FIXED);
  const json = run(cwd, true);
  expect(json.code).toBe(0);
  expect(parse(json.stdout).warnings.filter((item) => item.code?.startsWith("OKM21"))).toEqual([]);
  expect(run(cwd, false).stdout).not.toContain("OKM21");
});

test("a level of error exits non-zero with the rule code, off hides, hint downgrades", () => {
  const strict = project('  warnings: { levels: { "table-without-primary-key": "error" } },', BAD);
  const failed = run(strict, true);
  expect(failed.code).not.toBe(0);
  const envelope = parse(failed.stdout);
  expect(envelope.ok).toBe(false);
  expect(envelope.errors[0]?.code).toBe("OKM2102");
  expect(envelope.errors[0]?.docs).toBe("docs/errors/OKM2102.md");

  const quiet = project(
    '  warnings: { levels: { "unindexed-foreign-key": "off", "table-without-primary-key": "hint" } },',
    BAD,
  );
  const result = run(quiet, true);
  expect(result.code).toBe(0);
  const items = parse(result.stdout).warnings.filter((item) => item.code?.startsWith("OKM21"));
  expect(items.some((item) => item.code === "OKM2101")).toBe(false);
  expect(items.find((item) => item.code === "OKM2102")?.level).toBe("hint");
  expect(items.find((item) => item.code === "OKM2102")?.severity).toBe("medium");
});

test("an ignore silences its target, is listed with the reason, and a stale one is reported", () => {
  const cwd = project(
    [
      "  warnings: {",
      "    ignore: [",
      '      { rule: "table-without-primary-key", target: "events", reason: "append-only log" },',
      '      { rule: "unindexed-foreign-key", target: "posts.authorId", reason: "tiny table" },',
      '      { rule: "unindexed-filter-column", target: "notes.gone", reason: "removed column" },',
      "    ],",
      "  },",
    ].join("\n"),
    BAD,
  );
  const human = run(cwd, false);
  expect(human.code).toBe(0);
  expect(human.stdout).not.toContain("OKM2102");
  expect(human.stdout).not.toContain("OKM2101");
  expect(human.stdout).toContain("ignore table-without-primary-key events");
  expect(human.stdout).toContain("append-only log");
  expect(human.stdout).toContain(
    "ignore unindexed-filter-column notes.gone (stale: matched nothing)",
  );

  const envelope = parse(run(cwd, true).stdout);
  expect(
    envelope.data.ignores?.map((item) => `${item.rule} ${item.target} ${item.status}`),
  ).toEqual([
    "table-without-primary-key events applied",
    "unindexed-foreign-key posts.authorId applied",
    "unindexed-filter-column notes.gone stale",
  ]);
  expect(envelope.data.ignores?.[0]?.reason.text).toBe("append-only log");
  expect(
    envelope.warnings.some(
      (item) => item.summary === "A project ignore matched nothing." && item.level === "warn",
    ),
  ).toBe(true);
  expect(envelope.warnings.filter((item) => item.code === "OKM2103")).toHaveLength(2);
});

test("a project ignore without a reason or with a blank target is refused", () => {
  const noReason = run(
    project(
      '  warnings: { ignore: [{ rule: "table-without-primary-key", target: "events" }] },',
      BAD,
    ),
    true,
  );
  expect(noReason.code).toBe(2);
  const blank = run(
    project(
      '  warnings: { ignore: [{ rule: "table-without-primary-key", target: " ", reason: "x" }] },',
      BAD,
    ),
    true,
  );
  expect(blank.code).toBe(2);
  expect(blank.stdout).toContain("target");
});
