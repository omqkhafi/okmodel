/**
 * Handbook pages for operations and migrations stay aligned with the package
 * docs and with the formatters that print them.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listCompatibilityCaseNames, supportSentence } from "../scripts/compatibility.js";
import { repoRoot } from "../scripts/root.js";
import { compilerRangeNote } from "../scripts/ts-range.js";
import {
  buildReport,
  formatReport,
  type ProductionFacts,
} from "../src/tooling/migrate/doctor-production.js";
import type { MigrateConfig } from "../src/tooling/migrate/config.js";

const root = repoRoot();

function page(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function fence(text: string, lang: string, title: string): string {
  const pattern = new RegExp(
    `\`\`\`${lang} title="${title.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\n([\\s\\S]*?)\`\`\``,
  );
  const body = pattern.exec(text)?.[1];
  if (body === undefined) throw new Error(`missing ${lang} fence ${title}`);
  return body;
}

function markdownTable(text: string, header: string): string {
  const start = text.indexOf(header);
  if (start < 0) throw new Error(`missing table ${header}`);
  const lines = text.slice(start).split("\n");
  const rows: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("|")) break;
    rows.push(line);
  }
  return rows.join("\n");
}

test("the doctor sample is formatReport for the documented database", () => {
  const facts: ProductionFacts = {
    metaPresent: true,
    role: { superuser: false, bypassRls: false },
    ownedTables: 3,
    sessionLockMs: 0,
    sessionStatementMs: 0,
    serverMajor: 17,
    minimum: undefined,
    roleConfig: "not-set",
    extensions: { required: [], versions: new Map(), refusal: undefined },
  };
  const config: MigrateConfig = { schema: "./schema.ts" };
  const report = buildReport(
    {
      target: {
        name: "production",
        protection: "project",
        url: "postgres://app:secret@pooler.example:5432/app",
      },
      config,
      allowPooler: false,
    },
    facts,
  );
  const printed = formatReport(report);
  const handbook = fence(
    page("site/content/docs/operate/production-checklist.mdx"),
    "text",
    "doctor-production.out",
  );
  const packaged = page("docs/production.md");
  const packagedStart = packaged.indexOf("target `production`\n");
  const packagedEnd = packaged.indexOf("0 fail, 3 warn, 6 ok\n");
  if (packagedStart < 0 || packagedEnd < 0) throw new Error("package doctor sample moved");
  const packagedSample = packaged.slice(
    packagedStart,
    packagedEnd + "0 fail, 3 warn, 6 ok\n".length,
  );
  expect(printed).toBe(packagedSample);
  expect(handbook.endsWith("\n") ? handbook : `${handbook}\n`).toBe(printed);
});

test("the site compatibility table matches the generated package table", () => {
  const packaged = page("docs/compatibility.md");
  const site = page("site/content/docs/reference/compatibility.mdx");
  expect(markdownTable(site, "| Case | postgres.js")).toBe(
    markdownTable(packaged, "| Case | postgres.js"),
  );
  expect(site).toContain(supportSentence());
  expect(site).toContain(compilerRangeNote(root));
  const names = listCompatibilityCaseNames();
  for (const name of names) expect(site).toContain(`| ${name} |`);
});

test("the site step table matches the generated package table", () => {
  const header = "| Kind | Transactional | Built-in probe | Resume | Code |";
  expect(markdownTable(page("site/content/docs/migrations/failures.mdx"), header)).toBe(
    markdownTable(page("docs/migration-failure.md"), header),
  );
});

test("the four corrected statements are what the pages say", () => {
  const production = page("docs/production.md");
  const checklist = page("site/content/docs/operate/production-checklist.mdx");
  const backfill = page("docs/backfill.md");
  const backfillPage = page("site/content/docs/migrations/backfill.mdx");
  const database = page("site/content/docs/reference/config-database.mdx");
  const notice = "server checks skipped: N targets, pass --target <name>";
  const connection =
    "A failed connection says ``Could not read target `<name>` `` and exits 5. When the driver message contains `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`, `EHOSTUNREACH`, `28P01`, `28000`, `3D000`, or `57P03`, that token is appended in parentheses.";
  const timeout =
    "The statement timeout is `backfill.statementTimeoutMs`, then the apply statement timeout (`timeouts.statement` or `--statement-timeout`), then 30000.";
  expect(production).toContain(notice);
  expect(checklist).toContain(notice);
  expect(production).toContain(connection);
  expect(checklist).toContain(connection);
  expect(backfill).toContain(timeout);
  expect(backfillPage).toContain(timeout);
  expect(database).toContain("also read `pg_backend_pid()` eight times (`assertStableBackend`)");
  expect(checklist).toContain("eight reads");
  for (const text of [production, checklist, backfill, backfillPage, database]) {
    expect(text).not.toContain("only lints and prints");
    expect(text).not.toContain("no driver text");
    expect(text).not.toContain("pg_backend_pid()` twice");
  }
});

test("the migrate-check workflow parses and uses the repository action pins", () => {
  const body = fence(
    page("site/content/docs/migrations/checks-and-lint.mdx"),
    "yaml",
    "migrate-check.yml",
  );
  const parsed: unknown = Bun.YAML.parse(body);
  expect(parsed).toMatchObject({ name: "migrate" });
  expect(body).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1");
  expect(body).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2");
  expect(body).not.toContain("actions/checkout@v5");
});
