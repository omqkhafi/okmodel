/**
 * `okm.cli/1`: envelope, exit codes, schemas, stdin, and parseArgs.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../src/contracts/sha256.js";
import { OkmError } from "../src/contracts/error.js";
import { COMMANDS, flagNames, flagsFor } from "../src/tooling/cli/spec.js";
import { parseCli } from "../src/tooling/cli/parse.js";
import { exitCodeFor, exitCodeForCode, tagOutcome } from "../src/tooling/cli/outcome.js";
import {
  schemaCommands,
  schemaCoverageProblems,
  schemaFileName,
  schemaFor,
  schemaProblems,
  errorsSchemaText,
  schemaText,
} from "../src/tooling/cli/schema.js";
import { readPackageVersion } from "../src/tooling/cli/version.js";
import { ERROR_DOCS } from "../src/tooling/errors/registry.js";
import { bypassTokensIn } from "../src/tooling/errors/shape.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();
const cli = join(root, "src/tooling/cli.ts");
const probe = join(root, "tests/cli-parse-probe.ts");

const EXIT_BY_CODE: Readonly<Record<string, 0 | 1 | 2 | 3 | 4 | 5>> = {
  OKM1201: 2,
  OKM1530: 3,
  OKM1553: 3,
  OKM1555: 3,
  OKM1802: 5,
  OKM1803: 5,
  OKM1811: 5,
  OKM1812: 5,
  OKM1843: 5,
  OKM1844: 5,
  OKM1845: 2,
  OKM1846: 5,
  OKM1850: 4,
  OKM1852: 4,
  OKM1853: 2,
  OKM1854: 5,
  OKM1855: 4,
  OKM1856: 2,
  OKM1859: 4,
  OKM1860: 5,
  OKM1862: 4,
  OKM1863: 3,
  OKM1864: 4,
  OKM1865: 5,
  OKM1866: 4,
  OKM1867: 3,
  OKM1890: 3,
  OKM1891: 3,
  OKM1892: 4,
};

test("every registry code maps to one exit, and the rest stay 1", () => {
  const seen = new Set<string>();
  for (const doc of ERROR_DOCS) {
    seen.add(doc.code);
    expect(exitCodeForCode(doc.code)).toBe(EXIT_BY_CODE[doc.code] ?? 1);
  }
  for (const code of Object.keys(EXIT_BY_CODE)) expect(seen.has(code)).toBe(true);
  expect(exitCodeForCode("unavailable")).toBe(5);
  expect(exitCodeForCode("invalid")).toBe(1);
  expect(exitCodeForCode("OKM1401")).toBe(1);
  expect(exitCodeForCode("OKM1541")).toBe(1);
  expect(exitCodeForCode("OKM1851")).toBe(1);
  expect(exitCodeForCode("OKM1857")).toBe(1);
  expect(exitCodeForCode("OKM1858")).toBe(1);
  expect(exitCodeFor(tagOutcome(new OkmError("invalid", "pooler"), "unreachable"))).toBe(5);
  expect(exitCodeFor(tagOutcome(new OkmError("OKM1541", "missing"), "usage"))).toBe(2);
  expect(exitCodeFor(tagOutcome(new OkmError("invalid", "overwrite"), "guard"))).toBe(4);
  expect(exitCodeFor(new OkmError("OKM1530", "rename"))).toBe(3);
});

test("schema files match the generator and cover every command", () => {
  expect(schemaCoverageProblems()).toEqual([]);
  const directory = join(root, "schemas/cli-1");
  const files = readdirSync(directory).sort();
  expect(files).toEqual(
    [...schemaCommands().map((command) => schemaFileName(command)), "errors.json"].sort(),
  );
  expect(readFileSync(join(directory, "errors.json"), "utf8")).toBe(errorsSchemaText());
  for (const command of schemaCommands()) {
    expect(readFileSync(join(directory, schemaFileName(command)), "utf8")).toBe(
      schemaText(command),
    );
    expect(schemaProblems(schemaFor("schema"), schemaFor(command))).toEqual([]);
  }
});

test("okm schema prints the file, and --json data is that schema", () => {
  const printed = spawnOkm(["schema", "migrate", "plan"], root);
  expect(printed.code).toBe(0);
  expect(printed.stdout).toBe(schemaText("migrate plan"));
  expect(printed.stderr).toBe("");
  const json = spawnOkm(["schema", "build", "--json"], root);
  expect(json.code).toBe(0);
  const envelope = parseEnvelope(json.stdout);
  expect(envelope.command).toBe("schema");
  expect(schemaProblems(schemaFor("schema"), envelope.data)).toEqual([]);
  const unknown = spawnOkm(["schema", "buil", "--json"], root);
  expect(unknown.code).toBe(2);
  const failed = parseEnvelope(unknown.stdout);
  expect(failed.command).toBe("schema");
  expect(failed.exit).toBe(2);
  expect(failed.errors[0]?.fix).toContain("Did you mean build");
});

test("offline --json data matches its schema", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-cli-data-"));
  try {
    writeProject(cwd, 'table("notes", { id: identity(), title: text() })');
    const build = parseEnvelope(spawnOkm(["build", "--json"], cwd).stdout);
    expect(schemaProblems(schemaFor("build"), build.data)).toEqual([]);
    const exported = parseEnvelope(spawnOkm(["catalog", "export", "--json"], cwd).stdout);
    expect(schemaProblems(schemaFor("catalog export"), exported.data)).toEqual([]);
    const checked = parseEnvelope(spawnOkm(["check", "--json"], cwd).stdout);
    expect(schemaProblems(schemaFor("check"), checked.data)).toEqual([]);
    const generated = parseEnvelope(spawnOkm(["generate", "init", "--json"], cwd).stdout);
    expect(schemaProblems(schemaFor("generate"), generated.data)).toEqual([]);
    const planned = parseEnvelope(spawnOkm(["migrate", "plan", "review", "--json"], cwd).stdout);
    expect(schemaProblems(schemaFor("migrate plan"), planned.data)).toEqual([]);
    expect(planned.data).toMatchObject({ name: "review" });
    const doctor = parseEnvelope(spawnOkm(["doctor", "OKM1020", "--json"], cwd).stdout);
    expect(schemaProblems(schemaFor("doctor"), doctor.data)).toEqual([]);
    const dev = spawnOkm(["dev", "--json"], cwd);
    expect(dev.code).toBe(0);
    expect(schemaProblems(schemaFor("dev"), parseEnvelope(dev.stdout).data)).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a target fingerprint is a hash and the envelope key order is fixed", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-cli-fp-"));
  try {
    writeProject(cwd, 'table("notes", { id: identity(), title: text() })', {
      url: "postgres://user:secret@DB.Example:1/AppDB",
    });
    const result = spawnOkm(["migrate", "plan", "review", "--json"], cwd);
    expect(result.code).toBe(0);
    const text = result.stdout;
    expect(text).not.toContain("secret");
    expect(text).not.toContain("postgres://");
    expect(text.toLowerCase()).not.toContain("db.example");
    const envelope = parseEnvelope(text);
    expect(Object.keys(envelope)).toEqual([
      "schema",
      "command",
      "okmVersion",
      "capabilities",
      "ok",
      "exit",
      "target",
      "data",
      "errors",
      "warnings",
      "truncated",
      "outFile",
    ]);
    expect(envelope.schema).toBe("okm.cli/1");
    expect(envelope.ok).toBe(true);
    expect(envelope.exit).toBe(0);
    expect(envelope.okmVersion).toBe(readPackageVersion());
    expect(envelope.capabilities).toEqual([]);
    expect(envelope.truncated).toBe(false);
    expect(envelope.outFile).toBeNull();
    expect(envelope.target).toEqual({
      name: "default",
      protected: false,
      fingerprint: { hostDb: sha256("db.example:1/appdb"), identity: null },
    });
    const diverted = spawnOkm(["migrate", "plan", "review", "--json", "--out", "plan.json"], cwd);
    const placed = parseEnvelope(diverted.stdout);
    expect(placed.data).toEqual({});
    expect(placed.outFile).toEqual({
      path: "plan.json",
      bytes: Buffer.byteLength(readFileSync(join(cwd, "plan.json"))),
    });
    expect(
      schemaProblems(
        schemaFor("migrate plan"),
        JSON.parse(readFileSync(join(cwd, "plan.json"), "utf8")),
      ),
    ).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

test("exit 0 is a finished command", () => {
  const result = spawnOkm(["doctor", "OKM1020", "--json"], root);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const envelope = parseEnvelope(result.stdout);
  expect(envelope.ok).toBe(true);
  expect(envelope.exit).toBe(0);
  expect(envelope.errors).toEqual([]);
});

test("exit 1 is a command that ran and failed", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-cli-exit1-"));
  try {
    writeConfig(cwd);
    writeFileSync(join(cwd, "schema.ts"), "export const nope = 1;\n");
    const result = spawnOkm(["build", "--json"], cwd);
    expect(result.code).toBe(1);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.exit).toBe(1);
    expect(envelope.command).toBe("build");
    expect(envelope.errors[0]?.code).toBe("invalid");
    expect(envelope.errors[0]?.summary).toContain("must export a schema()");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("exit 2 is usage, including when the command was not parsed", () => {
  const missing = spawnOkm(["build", "--json"], mkdtempSync(join(tmpdir(), "okm-cli-exit2-")));
  expect(missing.code).toBe(2);
  const config = parseEnvelope(missing.stdout);
  expect(config.command).toBe("build");
  expect(config.exit).toBe(2);
  expect(config.ok).toBe(false);
  const flag = spawnOkm(["build", "--nope", "--json"], root);
  expect(flag.code).toBe(2);
  expect(flag.stderr).toBe("");
  const usage = parseEnvelope(flag.stdout);
  expect(usage.command).toBeNull();
  expect(usage.exit).toBe(2);
  expect(usage.errors[0]?.summary).toContain("Unknown flag --nope");
  expect(JSON.parse(`${flag.stdout}${flag.stderr}`)).toEqual(usage);
});

test("exit 3 is a decision the planner will not ask", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-cli-exit3-"));
  try {
    writeProject(cwd, 'table("notes", { id: identity(), title: text() })');
    expect(spawnOkm(["generate", "init"], cwd).code).toBe(0);
    writeSchema(cwd, 'table("notes", { id: identity(), name: text() })');
    const result = spawnOkm(["generate", "again", "--json"], cwd);
    expect(result.code).toBe(3);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope.exit).toBe(3);
    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]?.code).toBe("OKM1530");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("exit 4 is a guard on a protected target", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-cli-exit4-"));
  try {
    writeProject(cwd, 'table("notes", { id: identity(), title: text() })', {
      url: "postgres://127.0.0.1:1/db",
      protected: true,
    });
    const result = spawnOkm(["push", "--json"], cwd);
    expect(result.code).toBe(4);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope.exit).toBe(4);
    expect(envelope.errors[0]?.code).toBe("OKM1850");
    expect(result.stdout).not.toContain("127.0.0.1");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("exit 5 is a target that cannot be reached", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-cli-exit5-"));
  try {
    writeProject(cwd, 'table("notes", { id: identity(), title: text() })', {
      url: "postgres://127.0.0.1:1/db",
    });
    const result = spawnOkm(["doctor", "--json"], cwd);
    expect(result.code).toBe(5);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope.exit).toBe(5);
    expect(envelope.errors[0]?.code).toBe("unavailable");
    expect(envelope.target?.fingerprint.identity).toBeNull();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

test("no command waits on a closed stdin or an idle pipe", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-cli-stdin-"));
  try {
    const runs: Promise<void>[] = [];
    for (const command of COMMANDS) {
      runs.push(expectExit(command.words, "ignore", cwd));
      runs.push(expectExit(command.words, "pipe", cwd));
    }
    await Promise.all(runs);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("parseArgs agrees under Bun and Node", () => {
  const bun = spawnSync("bun", [probe], { cwd: root, encoding: "utf8" });
  expect(bun.stderr).toBe("");
  expect(bun.stdout).toBe("ok\n");
  expect(bun.status).toBe(0);
  const outfile = join(mkdtempSync(join(tmpdir(), "okm-cli-node-")), "probe.mjs");
  const built = spawnSync("bun", ["build", probe, "--target", "node", "--outfile", outfile], {
    cwd: root,
    encoding: "utf8",
  });
  expect(built.status).toBe(0);
  const node = spawnSync("node", [outfile], { cwd: root, encoding: "utf8" });
  expect(node.stderr).toBe("");
  expect(node.stdout).toBe("ok\n");
  expect(node.status).toBe(0);
});

test("short flags and guard flags stay inside the spec", () => {
  for (const command of COMMANDS) {
    for (const flag of flagsFor(command)) {
      expect(flag.short).not.toBe("f");
      if (
        flag.name === "allow-protected" ||
        flag.name === "allow-pooler" ||
        flag.name === "replace"
      ) {
        expect(flag.short).toBeUndefined();
      }
    }
  }
  expect(flagNames(undefined)).toContain("-h");
  expect(flagNames(undefined)).toContain("-V");
  expect(flagNames(undefined)).toContain("-v");
  expect(flagNames(undefined)).toContain("-c");
  expect(flagNames(undefined)).toContain("-o");
  const previous = process.env.OKM_ALLOW_PROTECTED;
  process.env.OKM_ALLOW_PROTECTED = "1";
  try {
    expect(parseCli(["push"]).allowProtected).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.OKM_ALLOW_PROTECTED;
    else process.env.OKM_ALLOW_PROTECTED = previous;
  }
});

test("success and failure --json stay one document on a merged stream", () => {
  const ok = spawnOkm(["doctor", "OKM1020", "--json"], root);
  expect(ok.stderr).toBe("");
  const success = JSON.parse(`${ok.stdout}${ok.stderr}`) as { ok: boolean };
  expect(success.ok).toBe(true);
  const bad = spawnOkm(["build", "--jsn", "--json"], root);
  expect(bad.code).toBe(2);
  const failure = JSON.parse(`${bad.stdout}${bad.stderr}`) as {
    exit: number;
    errors: { summary: string; fix: string }[];
  };
  expect(failure.exit).toBe(2);
  expect(failure.errors[0]?.summary).toContain("Unknown flag --jsn");
  expect(failure.errors[0]?.fix).toContain("Did you mean --json");
});

type Envelope = {
  readonly schema: string;
  readonly command: string | null;
  readonly okmVersion: string;
  readonly capabilities: readonly string[];
  readonly ok: boolean;
  readonly exit: number;
  readonly target?: {
    readonly name: string;
    readonly protected: boolean;
    readonly fingerprint: { readonly hostDb: string; readonly identity: string | null };
  };
  readonly data: unknown;
  readonly errors: readonly {
    readonly code: string;
    readonly summary: string;
    readonly fix: string;
  }[];
  readonly warnings: readonly unknown[];
  readonly truncated: boolean;
  readonly outFile: { readonly path: string; readonly bytes: number } | null;
};

function parseEnvelope(text: string): Envelope {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an envelope");
  const envelope = parsed as Envelope;
  for (const error of envelope.errors) {
    const hits = [...bypassTokensIn(error.summary), ...bypassTokensIn(error.fix)];
    expect(hits, error.code).toEqual([]);
  }
  return envelope;
}

function spawnOkm(
  args: readonly string[],
  cwd: string,
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const proc = spawnSync("bun", [cli, ...args], { cwd, encoding: "utf8" });
  return { code: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr };
}

async function expectExit(
  args: readonly string[],
  stdin: "ignore" | "pipe",
  cwd: string,
): Promise<void> {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd,
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, 8_000);
  const code = await proc.exited;
  clearTimeout(timer);
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  expect(timedOut, `${args.join(" ")} stdin=${stdin}`).toBe(false);
  expect(code, `${args.join(" ")} stdin=${stdin}`).not.toBeNull();
}

function writeProject(
  cwd: string,
  tables: string,
  database?: { readonly url: string; readonly protected?: boolean },
): void {
  writeSchema(cwd, tables);
  writeConfig(cwd, database);
  mkdirSync(join(cwd, "migrations"));
}

function writeSchema(cwd: string, tables: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { identity, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
      "export const app = schema({",
      `  tables: [${tables}],`,
      "});",
      "",
    ].join("\n"),
  );
}

function writeConfig(
  cwd: string,
  database?: { readonly url: string; readonly protected?: boolean },
): void {
  const target =
    database === undefined
      ? ""
      : `  database: { url: ${JSON.stringify(database.url)}, protected: ${database.protected === true} },`;
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      target,
      "});",
      "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}
