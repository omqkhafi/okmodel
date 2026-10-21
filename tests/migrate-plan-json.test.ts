/**
 * `okm migrate plan --json` (D279).
 *
 * The document matches the human plan's class and lock lines. An error
 * finding still exits after the document is printed.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { formatPlan, type MigrationPlan, type PlanStep } from "../src/tooling/migrate/plan.js";
import {
  formatPlanJson,
  parsePlanJson,
  type PlanDocument,
} from "../src/tooling/migrate/plan-json.js";
import type { Finding } from "../src/tooling/migrate/lint.js";

const root = repoRoot();

test("json locks and classes match the human plan, including an estimate", () => {
  const step: PlanStep = {
    sql: 'alter table "public"."tasks" add column "title" text',
    class: "expand",
    kind: "add-column",
    action: "ddl",
    lock: "ACCESS EXCLUSIVE",
    transactional: true,
    tables: ["tasks"],
  };
  const plan: MigrationPlan = { name: "review", class: "expand", steps: [step] };
  const findings: readonly Finding[] = [
    {
      severity: "warning",
      code: "OKM1540",
      place: "tasks.title",
      reason: "is varchar",
      fix: "Use text.",
    },
  ];
  const lockText = (): string => "ACCESS EXCLUSIVE on tasks, about 4.2M rows";
  const human = formatPlan(plan, lockText);
  const document = parsePlanJson(formatPlanJson(plan, findings, lockText));
  sameText(document.class, headerClass(human));
  sameText(
    document.steps.map((item) => item.class),
    stepClasses(human),
  );
  sameText(
    document.steps.map((item) => item.lock),
    lockLines(human),
  );
  expect(document.findings[0]?.code).toBe("OKM1540");
  expect(document.steps[0]?.lock).toContain("about 4.2M rows");
  expect(document.steps[0]?.operationClass).toBe("additive");
  expect(document.operationClass).toBe("additive");
  expect(document.requiresAck).toBe(false);
  const reason = document.findings[0]?.reason;
  expect(typeof reason).toBe("object");
  if (typeof reason === "object") expect(reason.text).toBe("is varchar");
});

test("okm migrate plan --json prints a document and matches the human plan", async () => {
  const cwd = writeProject("notes");
  try {
    const human = await capture(cwd, ["migrate", "plan", "review"]);
    const json = await capture(cwd, ["migrate", "plan", "--json", "review"]);
    const envelope = JSON.parse(json) as { schema: string; data: { name: string } };
    expect(envelope.schema).toBe("okm.cli/1");
    expect(envelope.data.name).toBe("review");
    const document = parsePlanJson(json);
    expect(isPlanDocument(document)).toBe(true);
    expect(document.name).toBe("review");
    sameText(document.class, headerClass(human));
    sameText(
      document.steps.map((item) => item.class),
      stepClasses(human),
    );
    sameText(
      document.steps.map((item) => item.lock),
      lockLines(human),
    );
    expect(document.steps.length).toBeGreaterThan(0);
    expect(document.fromCatalogHash).toMatch(/^[0-9a-f]{64}$/);
    expect(document.toCatalogHash).toMatch(/^[0-9a-f]{64}$/);
    expect(document.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(json).not.toContain("-- class:");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an empty plan is expand with no steps in both outputs", async () => {
  const cwd = writeProject("notes");
  try {
    await capture(cwd, ["generate", "init"]);
    const human = await capture(cwd, ["migrate", "plan", "again"]);
    const document = parsePlanJson(await capture(cwd, ["migrate", "plan", "again", "--json"]));
    expect(human).toContain("-- no steps");
    expect(document.class).toBe("expand");
    expect(document.steps).toEqual([]);
    sameText(document.class, headerClass(human));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an error finding exits after the json document", async () => {
  const cwd = writeProject("notes");
  try {
    await capture(cwd, ["generate", "init"]);
    writeSchema(cwd, "title");
    const proc = Bun.spawnSync(
      ["bun", join(root, "src/tooling/cli.ts"), "migrate", "plan", "drop", "--json"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toBe("");
    const envelope = JSON.parse(proc.stdout.toString()) as {
      schema: string;
      exit: number;
      errors: { code: string }[];
    };
    expect(envelope.schema).toBe("okm.cli/1");
    expect(envelope.exit).toBe(1);
    expect(envelope.errors[0]?.code).toBe("OKM1510");
    const document = parsePlanJson(proc.stdout.toString());
    expect(document.findings.some((finding) => finding.code === "OKM1512")).toBe(true);
    expect(document.class).toBe("contract");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function sameText(left: string | readonly string[], right: string | readonly string[]): void {
  const one = typeof left === "string" ? left : left.join("\n");
  const two = typeof right === "string" ? right : right.join("\n");
  expect(one).toBe(two);
}

function headerClass(text: string): string {
  const line = text.split("\n").find((item) => item.startsWith("-- class: "));
  return line?.slice("-- class: ".length) ?? "";
}

function stepClasses(text: string): readonly string[] {
  return text
    .split("\n")
    .filter((item) => item.startsWith("-- class: "))
    .slice(1)
    .map((item) => item.slice("-- class: ".length));
}

function lockLines(text: string): readonly string[] {
  return text
    .split("\n")
    .filter((item) => item.startsWith("-- lock: "))
    .map((item) => item.slice("-- lock: ".length));
}

function isPlanDocument(value: PlanDocument): boolean {
  return (
    typeof value.name === "string" &&
    (value.class === "expand" || value.class === "contract" || value.class === "unclassified") &&
    Array.isArray(value.steps) &&
    Array.isArray(value.findings)
  );
}

async function capture(cwd: string, argv: readonly string[]): Promise<string> {
  const lines: string[] = [];
  await run(argv, { cwd, stdout: (text) => lines.push(text) });
  return lines.join("");
}

function writeProject(column: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-plan-json-"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      '  out: "./.okm",',
      "});",
      "",
    ].join("\n"),
  );
  writeSchema(cwd, column);
  return cwd;
}

function writeSchema(cwd: string, column: string): void {
  const fields =
    column === "notes"
      ? 'id: id({ default: "none" }), title: text(), note: text()'
      : 'id: id({ default: "none" }), title: text()';
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { id, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
      "export const app = schema({",
      `  tables: [table("notes", { ${fields} })],`,
      "});",
      "",
    ].join("\n"),
  );
}
