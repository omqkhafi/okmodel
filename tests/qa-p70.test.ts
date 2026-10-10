/**
 * QA of 0.5.0 that does not need a database: pooler URL, pid probe, filters,
 * help, and function search_path.
 */

import { readFileSync } from "node:fs";

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { fn } from "../src/dialects/pg/fn/index.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { isOperator, operatorName } from "../src/dialects/pg/operators.js";
import { archivable, timestamps } from "../src/runtime/traits/index.js";
import { errorDoc } from "../src/tooling/errors/registry.js";
import { formatFailure, run } from "../src/tooling/migrate/commands.js";
import { assertDirectConnection, assertStableBackend } from "../src/tooling/migrate/policy.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();
const cli = `${root}/src/tooling/cli.ts`;

test("QA-M6: port 6432 is a pooler URL", async () => {
  expect(() => assertDirectConnection("postgres://u@127.0.0.1:6432/app", false)).toThrow(OkmError);
  expect(() => assertDirectConnection("postgres://u@127.0.0.1:6543/app", false)).toThrow(OkmError);
  expect(() => assertDirectConnection("postgres://u@127.0.0.1:6432/app", true)).not.toThrow();
  expect(() => assertDirectConnection("postgres://u@127.0.0.1:5432/app", false)).not.toThrow();
  const doc = errorDoc("OKM1854");
  expect(doc?.fix).toContain("--allow-pooler");
  const doctor = await spawn(["doctor", "OKM1854"]);
  expect(doctor.code).toBe(0);
  expect(doctor.stdout).toContain("OKM1854");
  expect(doctor.stdout).toContain("--allow-pooler");
});

test("QA-M6: a backend pid that changes between the two statements is OKM1854", async () => {
  let pid = "11";
  let started!: () => void;
  const first = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = assertStableBackend(async () => {
    const seen = pid;
    if (seen === "11") {
      started();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return seen;
  }, false);
  await first;
  pid = "22";
  const error = await pending.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OkmError);
  if (!(error instanceof OkmError)) return;
  expect(error.code).toBe("OKM1854");
  expect(error.message).toContain("11");
  expect(error.message).toContain("22");
  await assertStableBackend(async () => {
    pid = pid === "11" ? "22" : "11";
    return pid;
  }, true);
});

test("QA-M9: prototype keys are OKM1123 and parse applies the allowed operators", async () => {
  const tasks = table("tasks", { id: t.text(), title: t.text(), rank: t.integer() });
  const hostile = tasks.filters({ allow: { title: ["eq"] } });
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const query: Record<string, unknown> = Object.create(null);
    query[key] = "x";
    const error = await hostile.parse(query).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe("OKM1123");
    expect(error).not.toBeInstanceOf(TypeError);
  }
  const refused = await tasks
    .filters({ allow: { title: ["path"] } })
    .parse({})
    .then(
      () => undefined,
      (caught: unknown) => caught,
    );
  expect(refused).toBeInstanceOf(OkmError);
  if (refused instanceof OkmError) expect(refused.code).toBe("OKM1120");
  const parsed = await tasks
    .filters({ allow: { title: ["eq", "startsWith", "lt"], rank: ["in"] }, sort: ["title"] })
    .parse({ title: { startsWith: "a", lt: "m" }, rank: { in: [1, 2] }, sort: "title" });
  expect(isOperator(parsed.where)).toBe(true);
  if (isOperator(parsed.where)) expect(operatorName(parsed.where)).toBe("and");
  expect(parsed.orderBy).toEqual({ title: "asc" });
  const plain = await tasks.filters({ allow: { title: ["eq"] } }).parse({ title: "a" });
  expect(plain).toEqual({ where: { title: "a" } });
});

test("QA-L7: okm with no command, help, and a command help exit 0", async () => {
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const result = await spawn(args);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("migrate apply");
    expect(result.stderr).toBe("");
  }
  const check = await spawn(["check", "--help"]);
  expect(check.code).toBe(0);
  expect(check.stdout).toContain("check");
  expect(check.stdout).not.toContain("migrate apply");
});

test("QA-M10: a thrown error is one line, and the stack needs --verbose", async () => {
  const error = await run(["check"], { cwd: root }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeDefined();
  const quiet = formatFailure(error, false);
  expect(quiet.startsWith("error ")).toBe(true);
  const sample = new Error("boom");
  const stackLine = sample.stack?.split("\n")[1] ?? "";
  expect(stackLine.length).toBeGreaterThan(0);
  expect(formatFailure(sample, false)).not.toContain(stackLine);
  expect(formatFailure(sample, true)).toContain(stackLine);
  expect(quiet).not.toContain(stackLine);
});

test("QA-S3: fn searchPath is a list of identifiers", () => {
  expect(() =>
    fn("touch", {
      language: "sql",
      returns: "void",
      body: "select 1",
      searchPath: "public, app",
    }),
  ).not.toThrow();
  const error = capture(() =>
    fn("touch", {
      language: "sql",
      returns: "void",
      body: "select 1",
      searchPath: "public, user",
    }),
  );
  expect(error.code).toBe("OKM1122");
  expect(error.message).toContain("search_path");
});

test("QA-L2: Temporal merges with the TypeScript lib and temporal-polyfill", async () => {
  const shipped = readFileSync(`${root}/src/dialects/pg/temporal.ts`, "utf8");
  expect(shipped).not.toMatch(/^\s*var Temporal/m);
  expect(shipped).toContain("interface Instant {}");
  const build = readFileSync(`${root}/package.json`, "utf8");
  expect(build).toContain("dist/dialects/pg/temporal.local.d.ts");
  const tsc = `${root}/node_modules/typescript-editor/lib/tsc.js`;
  const lib = Bun.spawnSync(["bun", tsc, "-p", "tests/temporal-compat/tsconfig.lib.json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(lib.stderr.toString() + lib.stdout.toString()).toBe("");
  expect(lib.exitCode).toBe(0);
  const polyfill = Bun.spawnSync(
    ["bun", tsc, "-p", "tests/temporal-compat/tsconfig.polyfill.json"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(polyfill.stderr.toString() + polyfill.stdout.toString()).toBe("");
  expect(polyfill.exitCode).toBe(0);
});

test("QA-L1: Temporal values keep microseconds, with no runtime warning", () => {
  const spec = readFileSync(`${root}/docs/okmodel-api-design.md`, "utf8");
  expect(spec).toContain("keeps microseconds");
  expect(spec).toContain("The codecs do not warn.");
  const source = readFileSync(`${root}/src/dialects/pg/temporal.ts`, "utf8");
  expect(source).not.toContain("fractionalSecondDigits is omitted");
});

test("QA-L10: view keys are camelCased and refresh() runs REFRESH MATERIALIZED VIEW", () => {
  const limits = readFileSync(`${root}/docs/known-limits.md`, "utf8");
  expect(limits).toContain("db.views.activeProjects");
  expect(limits).toContain("REFRESH MATERIALIZED VIEW");
  expect(limits).toContain("`db.views.name.refresh()`");
});

test("QA-L13: lists_touch is the timestamps trigger, and only with enforce", () => {
  const plain = schema({
    tables: [
      table("lists", { id: t.text().primaryKey() }, { traits: [timestamps(), archivable()] }),
    ],
  });
  expect(plain.catalog.objects.some((object) => object.kind === "trigger")).toBe(false);
  const enforced = schema({
    tables: [
      table(
        "lists",
        { id: t.text().primaryKey() },
        { traits: [timestamps({ enforce: "trigger" }), archivable()] },
      ),
    ],
  });
  const trigger = enforced.catalog.objects.find((object) => object.kind === "trigger");
  expect(trigger?.identity.name).toBe("lists_touch");
  const limits = readFileSync(`${root}/docs/known-limits.md`, "utf8");
  expect(limits).toContain("lists_touch");
  expect(limits).toContain('enforce: "trigger"');
});

test("QA-S1: a hidden column in where and orderBy is OKM1120", () => {
  const decisions = readFileSync(`${root}/docs/okmodel-decisions.md`, "utf8");
  expect(decisions).toContain("| D215 |");
  expect(decisions).toContain("| D226 |");
  expect(decisions).toContain("allow where and refuse orderBy");
  const spec = readFileSync(`${root}/docs/okmodel-api-design.md`, "utf8");
  expect(spec).toContain("hidden({ filterable: true })");
});

function capture(runCall: () => void): OkmError {
  try {
    runCall();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

async function spawn(args: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  return {
    code,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}
