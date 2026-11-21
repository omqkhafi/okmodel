/**
 * The CLI output layer (D330): what decides pretty or plain, how prose wraps,
 * how a failure reads, and `okm help <code>`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { failureText } from "../src/tooling/cli/failure.js";
import { outputMode, styleText, wrap, type OutputMode } from "../src/tooling/cli/output.js";
import { formatFailure, run } from "../src/tooling/migrate/commands.js";
import { hasPty, okm, okmPty, stripAnsi } from "./cli-output-harness.js";

const ESC = "\u001b[";
const tty = { isTTY: true, columns: 120 };
const pretty: OutputMode = { pretty: true, columns: 80 };
const plain: OutputMode = { pretty: false, columns: 80 };

const project = mkdtempSync(join(tmpdir(), "okm-output-"));
afterAll(() => rmSync(project, { recursive: true, force: true }));

describe("mode", () => {
  test("a terminal with nothing set is pretty", () => {
    expect(outputMode(tty, {}).pretty).toBe(true);
  });

  test("a pipe is plain", () => {
    expect(outputMode({ isTTY: false }, {}).pretty).toBe(false);
    expect(outputMode({}, {}).pretty).toBe(false);
  });

  test.each([
    ["NO_COLOR", { NO_COLOR: "1" }],
    ["CI", { CI: "true" }],
    ["TERM=dumb", { TERM: "dumb" }],
  ])("%s makes a terminal plain", (_name, env) => {
    expect(outputMode(tty, env).pretty).toBe(false);
  });

  test("an empty NO_COLOR or CI does not count", () => {
    expect(outputMode(tty, { NO_COLOR: "", CI: "" }).pretty).toBe(true);
  });

  test("FORCE_COLOR forces pretty and wins over NO_COLOR, CI, and a pipe", () => {
    expect(outputMode({}, { FORCE_COLOR: "1" }).pretty).toBe(true);
    expect(outputMode(tty, { FORCE_COLOR: "1", NO_COLOR: "1", CI: "1" }).pretty).toBe(true);
    expect(outputMode(tty, { FORCE_COLOR: "3", TERM: "dumb" }).pretty).toBe(true);
  });

  test("FORCE_COLOR=0 and false force plain", () => {
    expect(outputMode(tty, { FORCE_COLOR: "0" }).pretty).toBe(false);
    expect(outputMode(tty, { FORCE_COLOR: "false" }).pretty).toBe(false);
  });

  test("a terminal's width is its own, or 80", () => {
    expect(outputMode({ isTTY: true, columns: 132 }, {}).columns).toBe(132);
    expect(outputMode({ isTTY: true }, {}).columns).toBe(80);
    expect(outputMode({ isTTY: true, columns: 0 }, {}).columns).toBe(80);
    expect(outputMode({ isTTY: true, columns: 40 }, { CI: "1" }).columns).toBe(40);
  });

  test("a pipe is never wrapped, even when colored", () => {
    expect(outputMode({ isTTY: false, columns: 40 }, {}).columns).toBe(Number.POSITIVE_INFINITY);
    expect(outputMode({}, { FORCE_COLOR: "1" }).columns).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("styling", () => {
  const text = [
    "error OKM1520: I found 1 difference between the schema and the database.",
    'alter table "public"."tasks" add column "extra" text',
    "I changed nothing. Change the schema or the database.",
    "Details: okm help OKM1520",
    "warning OKM1539 step 1: a reason -- fix: a fix",
    "ok 2 migrations",
    "config: /tmp/okmodel.config.ts",
    "note: I could not reach the target.",
    "",
  ].join("\n");

  test("plain text is untouched and has no ANSI", () => {
    expect(styleText(text, plain)).toBe(text);
    expect(styleText(text, plain)).not.toContain(ESC);
  });

  test("pretty colors the severity word and the code, and dims secondary lines", () => {
    const styled = styleText(text, pretty).split("\n");
    expect(styled[0]).toBe(
      `${ESC}31merror${ESC}0m ${ESC}31mOKM1520${ESC}0m: I found 1 difference between the schema and the database.`,
    );
    expect(styled[1]).toBe('alter table "public"."tasks" add column "extra" text');
    expect(styled[2]).toBe("I changed nothing. Change the schema or the database.");
    expect(styled[3]).toBe(`${ESC}2mDetails: okm help OKM1520${ESC}0m`);
    expect(styled[4]?.startsWith(`${ESC}33mwarning${ESC}0m ${ESC}33mOKM1539${ESC}0m step 1`)).toBe(
      true,
    );
    expect(styled[5]).toBe(`${ESC}32mok${ESC}0m 2 migrations`);
    expect(styled[6]).toBe(`${ESC}2mconfig: /tmp/okmodel.config.ts${ESC}0m`);
    expect(styled[7]).toBe(`${ESC}2mnote: I could not reach the target.${ESC}0m`);
  });

  test("pretty differs from plain by ANSI only", () => {
    expect(stripAnsi(styleText(text, pretty))).toBe(text);
  });

  test("a line that only starts like a prefix is not colored", () => {
    const other = "okay then\nerrors: none\nwarnings 3\n";
    expect(styleText(other, pretty)).toBe(other);
  });

  test("the unnumbered kind codes are colored too", () => {
    expect(styleText("error driver: boom\n", pretty)).toBe(
      `${ESC}31merror${ESC}0m ${ESC}31mdriver${ESC}0m: boom\n`,
    );
  });
});

describe("wrapping", () => {
  const prose =
    "I could not reach the target, so this plan has no row estimates and no live comparison.";

  test("a short line is left alone", () => {
    expect(wrap("I changed nothing.", 80)).toBe("I changed nothing.");
  });

  test("wraps at 80", () => {
    const lines = wrap(prose, 80).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines.join(" ")).toBe(prose);
  });

  test("wraps at a narrow width", () => {
    const lines = wrap(prose, 30).split("\n");
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((line) => line.length <= 30)).toBe(true);
    expect(lines.join(" ")).toBe(prose);
  });

  test("never splits a path or a code", () => {
    const path = "/a/very/long/path/that/is/longer/than/the/width/okmodel.config.ts";
    const lines = wrap(`I could not find ${path}.`, 20).split("\n");
    expect(lines).toContain(`${path}.`);
  });

  test("no width leaves prose alone", () => {
    expect(wrap(prose, Number.POSITIVE_INFINITY)).toBe(prose);
  });

  test("a failure wraps its prose and not its SQL", () => {
    const sql =
      'alter table "public"."tasks" add column "an_extremely_long_column_name" text not null';
    const error = new OkmError("OKM1520", `The database differs from the schema.\n${sql}`, {
      fix: { summary: "Change the schema or the database so okm check reports no difference." },
    });
    const text = failureText(error, false, 40);
    expect(text).toContain(`\n${sql}\n`);
    for (const line of text.split("\n")) {
      if (line === sql || line.length === 0) continue;
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });
});

describe("failure text", () => {
  test("drift reads as a count and keeps the statements", () => {
    const statements = ['alter table "public"."t" add column "a" text', 'drop index "t_a_idx"'];
    const error = new OkmError(
      "OKM1520",
      `The database differs from the schema.\n${statements.join("\n")}`,
      { fix: { summary: "Change the schema or the database so okm check reports no difference." } },
    );
    expect(failureText(error)).toBe(
      [
        "error OKM1520: I found 2 differences between the schema and the database.",
        ...statements,
        "I changed nothing. Change the schema or the database so okm check reports no difference.",
        "Details: okm help OKM1520",
        "",
      ].join("\n"),
    );
  });

  test("a rename reads as the user's example", () => {
    const error = new OkmError(
      "OKM1530",
      'Drop title and add name could be a rename. Add .renamedFrom("title") on name.',
      { fix: { summary: 'Add .renamedFrom("title") on name.' } },
    );
    expect(failureText(error)).toBe(
      [
        "error OKM1530: I found a drop of title and an add of name, which could be a rename.",
        'I stopped before changing anything. Add .renamedFrom("title") on name, or drop the column on purpose.',
        "Details: okm help OKM1530",
        "",
      ].join("\n"),
    );
  });

  test("a table rename says table", () => {
    const error = new OkmError(
      "OKM1530",
      'Drop a and add b could be a rename. Add renamedFrom: "a" on b.',
      { fix: { summary: 'Add renamedFrom: "a" on b.' } },
    );
    expect(failureText(error)).toContain("or drop the table on purpose.");
  });

  test("a code with a page names it, and one without does not", () => {
    expect(failureText(new OkmError("OKM1520", "x"))).toContain("Details: okm help OKM1520\n");
    expect(failureText(new OkmError("invalid", "x"))).not.toContain("Details:");
  });

  test("an unexpected error is one line and no stack", () => {
    const error = new TypeError("kaboom");
    const text = failureText(error);
    expect(text).toBe("error driver: kaboom (I did not expect this. OKM_DEBUG=1 shows where.)\n");
  });

  test("the stack only comes with verbose", () => {
    const error = new TypeError("kaboom");
    const text = failureText(error, true);
    expect(text.startsWith("error driver: kaboom\n")).toBe(true);
    expect(text).toContain("TypeError: kaboom");
    expect(text).toContain(" at ");
  });

  test("a missing database has a real fix line", () => {
    const text = failureText(OkmError.from(new Error('database "x" does not exist')));
    expect(text).toContain("I could not find that database, so I changed nothing.");
    expect(text).not.toContain("Read the summary");
  });

  test("a refused connection says what was not done", () => {
    const error = new OkmError("unavailable", "connect ECONNREFUSED 127.0.0.1:1");
    expect(failureText(error)).toContain("I could not reach the target, so I changed nothing.");
  });

  test("formatFailure is failureText", () => {
    const error = new OkmError("OKM1520", "x");
    expect(formatFailure(error)).toBe(failureText(error));
  });

  test("a prefix survives every voice", () => {
    for (const error of [
      new OkmError("OKM1520", "The database differs from the schema.\nx"),
      new OkmError("OKM1895", "Missing /x/okmodel.config.ts."),
      new OkmError("invalid", "Unknown code OKM9999."),
      new TypeError("boom"),
    ]) {
      expect(failureText(error)).toMatch(/^error [A-Za-z0-9_]+: /);
    }
  });
});

describe("okm help <code>", () => {
  async function out(argv: readonly string[]): Promise<string> {
    let text = "";
    await run(argv, {
      cwd: project,
      stdout: (chunk) => {
        text += chunk;
      },
    });
    return text;
  }

  test("prints the page okm doctor <code> prints", async () => {
    const help = await out(["help", "OKM1520"]);
    expect(help).toBe(await out(["doctor", "OKM1520"]));
    expect(help).toContain("# OKM1520");
  });

  test("takes a lower-case code", async () => {
    expect(await out(["help", "okm1520"])).toBe(await out(["doctor", "OKM1520"]));
  });

  test("without a code it still prints the commands", async () => {
    const help = await out(["help"]);
    expect(help.startsWith("okm <command>")).toBe(true);
    expect(await out(["help", "check"])).toBe(help);
  });

  test("an unknown code says so and names the nearest", async () => {
    const error = await run(["help", "OKM9999"], { cwd: project }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const text = failureText(error);
    expect(text).toMatch(/^error invalid: I do not know the code OKM9999\.\n/);
    expect(text).toMatch(/Did you mean OKM\d{4}\? Run okm help OKM\d{4} to read it\./);
  });

  test("--json gives the same data as doctor", async () => {
    const help = JSON.parse(await out(["help", "OKM1520", "--json"])) as { data: unknown };
    const doctor = JSON.parse(await out(["doctor", "OKM1520", "--json"])) as { data: unknown };
    expect(help.data).toEqual(doctor.data);
  });
});

describe("the bin", () => {
  const config = join(project, "okmodel.config.ts");

  test("--json is the same document in both modes and has no ANSI", () => {
    const missing = mkdtempSync(join(tmpdir(), "okm-output-missing-"));
    try {
      const a = okm(missing, ["check", "--json"], {});
      const b = okm(missing, ["check", "--json"], { FORCE_COLOR: "1" });
      const c = okm(missing, ["check", "--json"], { NO_COLOR: "1", CI: "1" });
      expect(a.code).toBe(2);
      expect(b.stdout).toBe(a.stdout);
      expect(c.stdout).toBe(a.stdout);
      expect(a.stdout).not.toContain(ESC);
      expect(a.stderr).toBe("");
      expect(b.stderr).toBe("");
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  });

  test("a piped failure is plain and keeps its prefixes", () => {
    const missing = mkdtempSync(join(tmpdir(), "okm-output-plain-"));
    try {
      const ran = okm(missing, ["check"]);
      expect(ran.code).toBe(2);
      expect(ran.stderr).not.toContain(ESC);
      expect(ran.stderr).toMatch(/^error OKM1895: I could not find .+okmodel\.config\.ts\.\n/);
      expect(ran.stderr).toContain("I did nothing. Create ");
      expect(ran.stderr).toContain("Details: okm help OKM1895\n");
      expect(ran.stderr).toMatch(/config: .+okmodel\.config\.ts\n$/);
      expect(ran.stdout).toBe("");
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  });

  test("FORCE_COLOR colors a pipe, and stripping it gives the plain text", () => {
    const missing = mkdtempSync(join(tmpdir(), "okm-output-force-"));
    try {
      const plainRun = okm(missing, ["check"]);
      const forced = okm(missing, ["check"], { FORCE_COLOR: "1" });
      expect(forced.code).toBe(plainRun.code);
      expect(forced.stderr).toContain(`${ESC}31merror${ESC}0m ${ESC}31mOKM1895${ESC}0m:`);
      expect(stripAnsi(forced.stderr)).toBe(plainRun.stderr);
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  });

  test("an unexpected error prints one line, and a stack only with OKM_DEBUG=1", () => {
    writeFileSync(config, 'throw new TypeError("kaboom in config");\n');
    try {
      const quiet = okm(project, ["check"]);
      expect(quiet.code).toBe(1);
      const lines = quiet.stderr.trimEnd().split("\n");
      expect(lines[0]).toBe(
        "error driver: kaboom in config (I did not expect this. OKM_DEBUG=1 shows where.)",
      );
      expect(quiet.stderr).not.toContain("TypeError");
      expect(quiet.stderr).not.toContain("    at ");
      const loud = okm(project, ["check"], { OKM_DEBUG: "1" });
      expect(loud.code).toBe(1);
      expect(loud.stderr).toContain("error driver: kaboom in config\n");
      expect(loud.stderr).toContain("TypeError: kaboom in config");
      expect(loud.stderr).toContain("    at ");
    } finally {
      rmSync(config, { force: true });
    }
  });

  test("a schema file that throws has a fix line, in text and in --json", () => {
    const dir = mkdtempSync(join(tmpdir(), "okm-output-throws-"));
    try {
      writeFileSync(
        join(dir, "okmodel.config.ts"),
        'export default { schema: "./schema.ts", database: "postgres://okm:okm@127.0.0.1:1/okm" };\n',
      );
      writeFileSync(join(dir, "schema.ts"), 'throw new Error("boom in schema");\n');
      const text = okm(dir, ["check"]);
      expect(text.code).toBe(1);
      expect(text.stderr).toContain("error driver: boom in schema\n");
      expect(text.stderr).toContain("I could not load ./schema.ts, so I changed nothing.");
      expect(text.stderr).not.toContain("Read the summary");
      const json = JSON.parse(okm(dir, ["check", "--json"]).stdout) as {
        errors: { code: string; fix: string; retryable: boolean }[];
      };
      expect(json.errors[0]?.code).toBe("driver");
      expect(json.errors[0]?.fix).toContain("I could not load ./schema.ts, so I changed nothing.");
      expect(json.errors[0]?.retryable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasPty)("a pseudo-terminal", () => {
  const empty = mkdtempSync(join(tmpdir(), "okm-output-pty-"));
  afterAll(() => rmSync(empty, { recursive: true, force: true }));

  test("a terminal with nothing set is pretty", async () => {
    const ran = await okmPty(empty, ["check"]);
    expect(ran.code).toBe(2);
    expect(ran.output).toContain(`${ESC}31merror${ESC}0m ${ESC}31mOKM1895${ESC}0m: `);
    expect(ran.output).toContain(`${ESC}2mDetails: okm help OKM1895${ESC}0m`);
  });

  test.each([
    ["NO_COLOR", { NO_COLOR: "1" }],
    ["CI", { CI: "true" }],
    ["TERM=dumb", { TERM: "dumb" }],
  ])("%s decides plain on a terminal", async (_name, env) => {
    const ran = await okmPty(empty, ["check"], { env });
    expect(ran.code).toBe(2);
    expect(ran.output).not.toContain(ESC);
    expect(ran.output).toContain("error OKM1895: I could not find ");
  });

  test("FORCE_COLOR wins over NO_COLOR on a terminal", async () => {
    const ran = await okmPty(empty, ["check"], { env: { NO_COLOR: "1", FORCE_COLOR: "1" } });
    expect(ran.output).toContain(`${ESC}31merror${ESC}0m`);
  });

  test("prose wraps at the terminal width, and a narrow terminal wraps more", async () => {
    const wide = await okmPty(empty, ["check"], { columns: 200, env: { NO_COLOR: "1" } });
    const narrow = await okmPty(empty, ["check"], { columns: 50, env: { NO_COLOR: "1" } });
    const wideLines = wide.output.split("\n");
    const narrowLines = narrow.output.split("\n");
    expect(narrowLines.length).toBeGreaterThan(wideLines.length);
    const prose = narrowLines.filter(
      (line) => line.startsWith("I did nothing") || line.startsWith("error "),
    );
    expect(prose.length).toBeGreaterThan(0);
    expect(narrow.output.replaceAll("\n", " ").replace(/ +/g, " ")).toContain(
      "I did nothing. Create ",
    );
  });
});
