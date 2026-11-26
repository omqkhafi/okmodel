/**
 * Goldens for what `okm` prints against a real database (D330).
 *
 * One project is walked through the same steps twice: plain (a pipe) and
 * pretty (`FORCE_COLOR=1`). Each step has a golden for both. Stripping the
 * ANSI from the pretty text must give the plain text. A pseudo-terminal run
 * covers the question `okm generate` asks before a drop.
 *
 * Rewrite `tests/fixtures/cli-output.snap.json` with `OKM_UPDATE_GOLDENS=1`.
 */

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { hasPty, okm, okmPty, stripAnsi, type Ran } from "./cli-output-harness.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const snapshot = join(root, "tests/fixtures/cli-output.snap.json");
const UNREACHABLE = "postgres://okm:okm@127.0.0.1:1/okm";
const ESC = "\u001b[";
const TERMINAL_KEY = "generate.drop.terminal";

type Golden = { readonly exit: number | null; readonly stdout: string; readonly stderr: string };

function schemaText(columns: readonly string[]): string {
  return [
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    'export const app = schema({ tables: [table("tasks", {',
    "  id: t.integer().primaryKey(),",
    ...columns.map((name) => `  ${name}: t.text().nullable(),`),
    "})] });",
    "",
  ].join("\n");
}

function configText(database: string): string {
  return [
    `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
    "export default defineConfig({",
    '  schema: "./schema.ts",',
    `  database: ${JSON.stringify(database)},`,
    "});",
    "",
  ].join("\n");
}

function normalize(text: string, cwd: string): string {
  return text
    .replaceAll(realpathSync(cwd), "<project>")
    .replaceAll(cwd, "<project>")
    .replace(/\bpid \d+/g, "pid <pid>")
    .replace(/\bover [\d.]+ (?:ms|s)\b/g, "over <time>")
    .replace(/\bfor [\d.]+ (?:ms|s|min)(?: \d+ s)?\b/g, "for <age>");
}

function golden(ran: Ran, cwd: string): Golden {
  return {
    exit: ran.code,
    stdout: normalize(ran.stdout, cwd),
    stderr: normalize(ran.stderr, cwd),
  };
}

function removeMigration(cwd: string, name: string): void {
  for (const file of readdirSync(join(cwd, "migrations"))) {
    if (file.includes(name)) rmSync(join(cwd, "migrations", file));
  }
}

/**
 * Walks one project through every step, in `env`'s mode.
 *
 * @returns What each step printed
 */
async function walk(env: Record<string, string>): Promise<Record<string, Golden>> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-output-pg-"));
  const sql = openPostgres(database.url);
  const seen: Record<string, Golden> = {};
  const step = (name: string, args: readonly string[], more: Record<string, string> = {}): Ran => {
    const ran = okm(cwd, args, { ...env, ...more });
    seen[name] = golden(ran, cwd);
    return ran;
  };
  try {
    writeFileSync(join(cwd, "okmodel.config.ts"), configText(database.url));
    writeFileSync(join(cwd, "schema.ts"), schemaText([]));
    expect(okm(cwd, ["generate", "init"]).code).toBe(0);
    expect(okm(cwd, ["migrate", "apply"]).code).toBe(0);
    step("check.clean", ["check"]);

    writeFileSync(join(cwd, "schema.ts"), schemaText(["note"]));
    step("check.drift", ["check"]);
    step("migrate.plan", ["migrate", "plan", "add_note"]);
    step("generate.write", ["generate", "add_note"]);
    step("migrate.apply.success", ["migrate", "apply"]);
    step("migrate.status", ["migrate", "status"]);
    step("check.clean.after", ["check"]);

    writeFileSync(join(cwd, "schema.ts"), schemaText(["memo"]));
    step("generate.rename", ["generate", "rename_note"]);

    writeFileSync(join(cwd, "schema.ts"), schemaText([]));
    step("generate.drop.noterminal", ["generate", "drop_note"]);
    removeMigration(cwd, "drop_note");

    writeFileSync(join(cwd, "schema.ts"), schemaText(["note", "other"]));
    expect(okm(cwd, ["generate", "add_other"]).code).toBe(0);
    const locker = await sql.reserve();
    try {
      await locker.unsafe("begin");
      await locker.unsafe("lock table tasks in access exclusive mode");
      step("migrate.apply.locktimeout", [
        "migrate",
        "apply",
        "--lock-timeout",
        "300",
        "--lock-wait",
        "0",
      ]);
      const json = okm(
        cwd,
        ["migrate", "apply", "--lock-timeout", "300", "--lock-wait", "0", "--json"],
        env,
      );
      const body = JSON.parse(json.stdout) as {
        errors: { retryable: boolean; fix: string }[];
      };
      expect(body.errors[0]?.retryable).toBe(true);
      expect(body.errors[0]?.fix).toContain("running it again is safe");
    } finally {
      await locker.unsafe("rollback");
      locker.release();
    }
    expect(okm(cwd, ["migrate", "apply"]).code).toBe(0);

    writeFileSync(join(cwd, "okmodel.config.ts"), configText(UNREACHABLE));
    step("url.unreachable", ["check"]);
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      configText(database.url.replace(/\/[^/]+$/, "/okm_no_such_database")),
    );
    step("url.database", ["check"]);
    writeFileSync(join(cwd, "okmodel.config.ts"), configText(database.url));

    writeFileSync(join(cwd, "schema.ts"), 'throw new Error("boom in schema");\n');
    step("schema.throws", ["check"]);
    writeFileSync(join(cwd, "schema.ts"), schemaText(["note", "other"]));

    removeMigration(cwd, "add_other");
    rmSync(join(cwd, "okmodel.config.ts"));
    step("config.missing", ["check"]);
    return seen;
  } finally {
    await sql.end({ timeout: 5 });
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

const walks: Record<string, Promise<Record<string, Golden>>> = {};
function walked(mode: "plain" | "pretty"): Promise<Record<string, Golden>> {
  walks[mode] ??= walk(mode === "plain" ? {} : { FORCE_COLOR: "1" });
  return walks[mode];
}

postgresTest(
  gate,
  "every step prints the same words in plain and pretty, and matches its golden",
  async () => {
    const plain = await walked("plain");
    const pretty = await walked("pretty");
    const actual: Record<string, Golden> = {};
    for (const name of Object.keys(plain)) {
      const flat = plain[name] as Golden;
      const colored = pretty[name] as Golden;
      expect(flat.stdout + flat.stderr, name).not.toContain(ESC);
      expect(stripAnsi(colored.stdout), name).toBe(flat.stdout);
      // The one line that is not the same words: a holder's query text is for a terminal only.
      const queries = /^pid <pid> query: .*\n/gm;
      expect(stripAnsi(colored.stderr).replace(queries, ""), name).toBe(flat.stderr);
      expect(queries.test(flat.stderr), name).toBe(false);
      expect(colored.exit, name).toBe(flat.exit);
      actual[`${name}.plain`] = flat;
      actual[`${name}.pretty`] = colored;
    }
    if (process.env.OKM_UPDATE_GOLDENS === "1") {
      writeFileSync(snapshot, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const saved = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, Golden>;
    const expected = Object.fromEntries(
      Object.entries(saved).filter(([key]) => key !== TERMINAL_KEY),
    );
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    for (const key of Object.keys(actual)) expect(actual[key], key).toEqual(expected[key]);
  },
  300_000,
);

postgresTest(
  gate,
  "a stable prefix opens every failure in both modes",
  async () => {
    const plain = await walked("plain");
    const failures = Object.entries(plain).filter(([, value]) => value.exit !== 0);
    expect(failures.length).toBeGreaterThan(6);
    for (const [name, value] of failures) {
      expect(value.stderr, name).toMatch(/^error [A-Za-z0-9_]+: /);
      expect(value.stderr, name).toMatch(
        /config: <project>\/okmodel\.config\.ts\n$|^error OKM1895/,
      );
    }
    expect(plain["check.clean"]?.stdout).toBe("ok\n");
  },
  300_000,
);

postgresTest(
  gate,
  "a terminal gets the drop question, and a no leaves the migration unwritten",
  async () => {
    if (!hasPty) return;
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-output-drop-"));
    try {
      writeFileSync(join(cwd, "okmodel.config.ts"), configText(database.url));
      writeFileSync(join(cwd, "schema.ts"), schemaText(["note"]));
      expect(okm(cwd, ["generate", "init"]).code).toBe(0);
      expect(okm(cwd, ["migrate", "apply"]).code).toBe(0);
      writeFileSync(join(cwd, "schema.ts"), schemaText([]));
      const ran = await okmPty(cwd, ["generate", "drop_note"], { answers: ["n"] });
      const output = normalize(ran.output, cwd);
      const actual = { exit: ran.code, output };
      const key = TERMINAL_KEY;
      const saved = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      if (process.env.OKM_UPDATE_GOLDENS === "1") {
        writeFileSync(snapshot, `${JSON.stringify({ ...saved, [key]: actual }, null, 2)}\n`);
      } else {
        expect(actual).toEqual(saved[key] as typeof actual);
      }
      expect(ran.code).toBe(1);
      expect(output).toContain("This migration drops data:");
      expect(output).toContain("Drop it? [y/N]");
      expect(readdirSync(join(cwd, "migrations")).some((file) => file.includes("drop_note"))).toBe(
        false,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);
