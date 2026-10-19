/**
 * `okm` command dispatch.
 *
 * The bin wrapper imports {@link run}. Importing this module does not parse
 * `process.argv`.
 */

import { OkmError } from "../../contracts/error.js";
import { formatFindings, hasError, lintRefusal } from "./lint.js";
import { sessionFailure } from "./lost.js";
import { projectContext, type ProjectContext } from "./paths.js";
import type { InvokeFlags } from "./policy.js";
import { buildProject, checkProject, exportProject, generateProject } from "./project.js";

/** Where a command reads the project and writes its text. */
export type CommandIo = {
  readonly cwd?: string;
  readonly stdout?: (text: string) => void;
};

/**
 * Text `okm` writes for a failure.
 *
 * The message includes a source location when the schema recorded one.
 *
 * @param error - Failure from a command
 * @returns The stderr text, including the trailing newline
 */
export function formatFailure(error: unknown, verbose = false): string {
  const mapped = sessionFailure(error) ?? OkmError.from(error);
  let text = `error ${mapped.code}: ${mapped.message}\n${mapped.fix.summary}\n`;
  if (verbose && error instanceof Error && error.stack !== undefined) {
    text += `${error.stack}\n`;
  }
  return text;
}

/**
 * Runs one `okm` invocation.
 *
 * `--version` stays in the bin. This function handles `build`, `check`,
 * `generate`, `dev`, `push`, `seed`, `ext list`, `ext check`, `ext scaffold`,
 * `ext test`, `doctor`,
 * `driver test`, and `migrate plan`, `apply`, `status`, `check`, and
 * `baseline`.
 *
 * @param argv - Arguments after the program name
 * @param io - Working directory and stdout. Defaults to the process
 */
export async function run(argv: readonly string[], io?: CommandIo): Promise<void> {
  const base = io?.cwd ?? process.cwd();
  const stdout = io?.stdout ?? ((text: string) => process.stdout.write(text));
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    stdout(commandsTable());
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout(
      commandHelp(argv.filter((arg) => arg !== "--help" && arg !== "-h" && !isConfigArg(arg))),
    );
    return;
  }
  const project = projectFrom(base, argv);
  const args = stripConfig(argv);
  const [command, ...rest] = args;
  if (command === "build") {
    const directory = await buildProject(project);
    stdout(`${directory}\n`);
    return;
  }
  if (command === "catalog") {
    const sub = rest[0];
    if (sub !== "export") {
      throw new OkmError("invalid", `Unknown command catalog ${sub ?? ""}.`, {
        fix: { summary: "Use okm catalog export." },
      });
    }
    stdout(await exportProject(project, rest.slice(1)));
    return;
  }
  if (command === "check") {
    const checked = await checkProject(project, invoke(splitFlags(rest, "check")));
    if (checked.notice !== undefined) stdout(checked.notice);
    const warnings = formatFindings(checked.findings);
    if (warnings.length > 0) stdout(warnings);
    stdout("ok\n");
    return;
  }
  if (command === "generate") {
    const parsed = splitFlags(rest, "generate");
    const written = await generateProject(project, parsed.name ?? "migration", parsed.flags);
    stdout(written === undefined ? "no changes\n" : `${written.path}\n`);
    if (written !== undefined) {
      stdout(formatFindings(written.findings));
      if (hasError(written.findings)) {
        throw new OkmError("OKM1510", formatFindings(written.findings).trim(), {
          fix: { summary: "okm migrate apply will refuse until it is fixed." },
        });
      }
    }
    return;
  }
  if (command === "dev") {
    const { devProject } = await import("./dev.js");
    stdout(await devProject(project));
    return;
  }
  if (command === "push") {
    const { pushProject } = await import("./apply.js");
    stdout(await pushProject(project, invoke(splitFlags(rest, "push"))));
    return;
  }
  if (command === "pull") {
    const { pullProject } = await import("./pull.js");
    stdout((await pullProject(project, rest)).text);
    return;
  }
  if (command === "import") {
    const sub = rest[0];
    if (sub !== "drizzle") {
      throw new OkmError("invalid", `Unknown command import ${sub ?? ""}.`, {
        fix: { summary: "Use okm import drizzle <path>." },
      });
    }
    const { importDrizzle } = await import("./import-drizzle.js");
    stdout((await importDrizzle(project.cwd, rest.slice(1))).text);
    return;
  }
  if (command === "migrate") {
    const sub = rest[0];
    const migrateArgs = rest.slice(1);
    const commandKey =
      sub === "plan"
        ? "migrate plan"
        : sub === "apply"
          ? "migrate apply"
          : sub === "status"
            ? "migrate status"
            : sub === "check"
              ? "migrate check"
              : sub === "baseline"
                ? "migrate baseline"
                : undefined;
    if (commandKey === undefined) {
      throw new OkmError("invalid", `Unknown command migrate ${sub ?? ""}.`, {
        fix: { summary: "Use okm migrate plan, apply, status, check, or baseline." },
      });
    }
    const parsed = splitFlags(
      sub === "plan" || sub === "baseline"
        ? migrateArgs.filter((arg) => arg !== "--json")
        : migrateArgs,
      commandKey,
    );
    if (sub === "plan") {
      if (parsed.name === undefined) {
        throw new OkmError("invalid", "okm migrate plan needs a name.");
      }
      const { plan } = await import("./api.js");
      const planned = await plan(parsed.name, {
        cwd: project.cwd,
        config: project.configPath,
        ...invoke(parsed),
        ...(parsed.flags.length > 0 ? { replace: parsed.flags } : {}),
      });
      if (migrateArgs.includes("--json")) stdout(planned.json);
      else {
        stdout(planned.text);
        stdout(formatFindings(planned.lint));
      }
      if (hasError(planned.lint)) throw lintRefusal(planned.lint);
      return;
    }
    if (sub === "apply") {
      const { apply } = await import("./api.js");
      const flags = invoke(parsed);
      const result = await apply({
        cwd: project.cwd,
        config: project.configPath,
        ...flags,
        onProgress: stdout,
      });
      stdout(result.text);
      return;
    }
    if (sub === "status") {
      const { status } = await import("./api.js");
      const rows = await status({
        cwd: project.cwd,
        config: project.configPath,
        ...invoke(parsed),
      });
      stdout(rows[0]?.text ?? "");
      return;
    }
    if (sub === "check") {
      const { checkMigrations } = await import("./check.js");
      stdout(await checkMigrations(project, invoke(parsed), { provision: parsed.provision }));
      return;
    }
    if (sub === "baseline") {
      const { baselineProject } = await import("./baseline.js");
      stdout(
        await baselineProject(project, {
          ...invoke(parsed),
          dryRun: parsed.dryRun,
          json: migrateArgs.includes("--json"),
        }),
      );
      return;
    }
  }
  if (command === "seed") {
    const parsed = splitFlags(rest, "seed");
    if (parsed.name === undefined) {
      throw new OkmError("invalid", "okm seed needs a file.", {
        fix: { summary: "Pass okm seed <file>." },
      });
    }
    const { seedProject } = await import("./seed.js");
    stdout(await seedProject(project, parsed.name, invoke(parsed)));
    return;
  }
  if (command === "doctor") {
    const parsed = splitFlags(rest, "doctor");
    const { doctorProject } = await import("./doctor.js");
    stdout(await doctorProject(project, parsed.name, invoke(parsed)));
    return;
  }
  if (command === "driver") {
    const sub = rest[0];
    if (sub !== "test") {
      const message =
        sub === undefined ? "Unknown command driver." : `Unknown command driver ${sub}.`;
      throw new OkmError("invalid", message, {
        fix: { summary: "Use okm driver test <driver>." },
      });
    }
    const { driverTest } = await import("../driver-test.js");
    await driverTest(rest.slice(1), stdout);
    return;
  }
  if (command === "ext") {
    const sub = rest[0];
    if (sub === "scaffold" || sub === "test") {
      const parsed = extInvocation(rest.slice(1));
      const { extScaffold, extTest } = await import("./ext.js");
      const text =
        sub === "scaffold"
          ? await extScaffold(
              project,
              requireName(parsed, "okm ext scaffold <name>"),
              parsed.flags,
              parsed.out,
            )
          : await extTest(project, requireName(parsed, "okm ext test <file>"), parsed.flags);
      stdout(text);
      return;
    }
    if (sub === "list" || sub === "check") {
      const { extProject } = await import("./ext.js");
      stdout(await extProject(project, sub, invoke(splitFlags(rest.slice(1), "ext"))));
      return;
    }
    throw new OkmError("invalid", `Unknown command ext ${sub ?? ""}.`, {
      fix: { summary: "Use okm ext list, okm ext check, okm ext scaffold, or okm ext test." },
    });
  }
  throw new OkmError("invalid", `Unknown command ${command ?? ""}.`);
}

function requireName(parsed: ExtParsed, usage: string): string {
  if (parsed.name === undefined || parsed.name.length === 0) {
    throw new OkmError("invalid", `${usage} needs a name.`, {
      fix: { summary: `Pass ${usage}.` },
    });
  }
  return parsed.name;
}

type ExtParsed = {
  readonly name: string | undefined;
  readonly out: string | undefined;
  readonly flags: InvokeFlags;
};

function extInvocation(args: readonly string[]): ExtParsed {
  const rest: string[] = [];
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--out" || arg.startsWith("--out=")) {
      const value = arg === "--out" ? args[index + 1] : arg.slice("--out=".length);
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new OkmError("invalid", "--out needs a file.", {
          fix: { summary: "Pass --out <file>. The command never overwrites." },
        });
      }
      out = value;
      if (arg === "--out") index += 1;
      continue;
    }
    rest.push(arg);
  }
  const parsed = splitFlags(rest, "ext");
  return { name: parsed.name, out, flags: invoke(parsed) };
}

function isConfigArg(arg: string): boolean {
  return arg === "--config" || arg.startsWith("--config=");
}

/**
 * Reads a global `--config` and returns the project it names.
 *
 * @param cwd - Working directory of the invocation
 * @param argv - Arguments after the program name
 * @returns Project root and absolute config path
 */
function projectFrom(cwd: string, argv: readonly string[]): ProjectContext {
  let config: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--config" || arg.startsWith("--config=")) {
      const value = arg === "--config" ? argv[index + 1] : arg.slice("--config=".length);
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new OkmError("invalid", "--config needs a path.", {
          fix: { summary: "Pass --config <path> to okmodel.config.ts." },
        });
      }
      if (config !== undefined && config !== value) {
        throw new OkmError("invalid", "--config was passed more than once.", {
          fix: { summary: "Pass --config once." },
        });
      }
      config = value;
    }
  }
  return projectContext(cwd, config);
}

function stripConfig(argv: readonly string[]): readonly string[] {
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--config") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) continue;
    rest.push(arg);
  }
  return rest;
}

function invoke(parsed: Parsed): InvokeFlags {
  return {
    ...(parsed.target !== undefined ? { target: parsed.target } : {}),
    allowProtected: parsed.allowProtected,
    allowPooler: parsed.allowPooler,
    ...(parsed.lockTimeoutMs !== undefined ? { lockTimeoutMs: parsed.lockTimeoutMs } : {}),
    ...(parsed.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: parsed.statementTimeoutMs }
      : {}),
  };
}

type Parsed = {
  readonly name: string | undefined;
  readonly flags: readonly string[];
  readonly target: string | undefined;
  readonly allowProtected: boolean;
  readonly allowPooler: boolean;
  readonly provision: boolean;
  readonly dryRun: boolean;
  readonly lockTimeoutMs: number | undefined;
  readonly statementTimeoutMs: number | undefined;
};

type CommandKey =
  | "check"
  | "generate"
  | "push"
  | "seed"
  | "doctor"
  | "ext"
  | "migrate plan"
  | "migrate apply"
  | "migrate status"
  | "migrate check"
  | "migrate baseline";

const COMMAND_FLAGS: Readonly<Record<CommandKey, readonly string[]>> = {
  check: ["--target", "--allow-pooler", "--lock-timeout", "--statement-timeout"],
  generate: ["--replace"],
  push: ["--target", "--allow-protected", "--allow-pooler"],
  seed: ["--target", "--allow-protected", "--allow-pooler"],
  doctor: ["--target"],
  ext: ["--target", "--allow-pooler", "--out"],
  "migrate plan": ["--target", "--allow-protected", "--replace", "--json"],
  "migrate apply": [
    "--target",
    "--allow-protected",
    "--allow-pooler",
    "--lock-timeout",
    "--statement-timeout",
  ],
  "migrate status": ["--target"],
  "migrate check": [
    "--target",
    "--allow-protected",
    "--allow-pooler",
    "--provision",
    "--lock-timeout",
    "--statement-timeout",
  ],
  "migrate baseline": ["--target", "--allow-protected", "--allow-pooler", "--dry-run", "--json"],
};

function splitFlags(args: readonly string[], command: CommandKey): Parsed {
  const allowed = new Set(COMMAND_FLAGS[command]);
  const flags: string[] = [];
  const positionals: string[] = [];
  let target: string | undefined;
  let allowProtected = false;
  let allowPooler = false;
  let provision = false;
  let dryRun = false;
  let lockTimeoutMs: number | undefined;
  let statementTimeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--replace" || arg.startsWith("--replace=")) {
      refuseUnknown(command, "--replace", allowed);
      const value = arg === "--replace" ? args[index + 1] : arg.slice("--replace=".length);
      if (
        value === undefined ||
        value.length === 0 ||
        (arg === "--replace" && value.startsWith("--"))
      ) {
        throw new OkmError("OKM1541", "--replace needs table.column.old=new.", {
          fix: { summary: "Pass --replace <table>.<column>.<old>=<new>." },
        });
      }
      flags.push(value);
      if (arg === "--replace") index += 1;
      continue;
    }
    if (arg === "--allow-protected") {
      refuseUnknown(command, arg, allowed);
      allowProtected = true;
      continue;
    }
    if (arg === "--allow-pooler") {
      refuseUnknown(command, arg, allowed);
      allowPooler = true;
      continue;
    }
    if (arg === "--provision") {
      refuseUnknown(command, arg, allowed);
      provision = true;
      continue;
    }
    if (arg === "--dry-run") {
      refuseUnknown(command, arg, allowed);
      dryRun = true;
      continue;
    }
    if (arg === "--json") {
      refuseUnknown(command, arg, allowed);
      continue;
    }
    if (arg === "--target" || arg.startsWith("--target=")) {
      refuseUnknown(command, "--target", allowed);
      const value = arg === "--target" ? args[index + 1] : arg.slice("--target=".length);
      if (
        value === undefined ||
        value.length === 0 ||
        (arg === "--target" && value.startsWith("--"))
      ) {
        throw new OkmError("OKM1853", "--target needs a name.", {
          fix: { summary: "Pass --target <name>." },
        });
      }
      target = value;
      if (arg === "--target") index += 1;
      continue;
    }
    if (arg === "--lock-timeout" || arg === "--statement-timeout") {
      refuseUnknown(command, arg, allowed);
      const value = numberFlag(arg, args[index + 1]);
      if (arg === "--lock-timeout") lockTimeoutMs = value;
      else statementTimeoutMs = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new OkmError("invalid", `Unknown flag ${arg}.`, {
        fix: {
          summary: `Use okm ${command} --help for the flags this command accepts.`,
        },
      });
    }
    positionals.push(arg);
  }
  return {
    name: positionals[0],
    flags,
    target,
    allowProtected,
    allowPooler,
    provision,
    dryRun,
    lockTimeoutMs,
    statementTimeoutMs,
  };
}

function refuseUnknown(command: CommandKey, flag: string, allowed: ReadonlySet<string>): void {
  if (allowed.has(flag)) return;
  throw new OkmError("invalid", `Unknown flag ${flag}.`, {
    fix: {
      summary: `Use okm ${command} --help for the flags this command accepts.`,
    },
  });
}

const COMMANDS: readonly (readonly [string, string])[] = [
  ["build", "Write the schema build."],
  ["catalog export", "Write the catalog snapshot."],
  ["check", "Lint the schema and compare it with one target."],
  ["dev", "Open a PGlite database in .okm/dev-db, or name a target called dev."],
  ["doctor [code]", "Print a target report, or one error code."],
  ["driver test <driver>", "Run conformance against one driver."],
  ["ext list", "List extensions the server can install."],
  ["ext check", "Compare declared extensions with the server."],
  ["ext scaffold <name>", "Print a starting extension() definition."],
  ["ext test <file>", "Check an extension() definition against the server."],
  ["generate [name]", "Write the next migration."],
  [
    "import drizzle <path>",
    "Import a Drizzle schema. This runs that file. Writes table files and needs no database.",
  ],
  ["migrate plan <name>", "Print the plan and its lock estimates. --json prints a document."],
  ["migrate apply", "Apply pending migrations."],
  ["migrate status", "Print whether the target is current."],
  ["migrate check", "Replay migration history in a scratch schema."],
  [
    "migrate baseline",
    "Record the head snapshot as applied on an existing database. No schema changes.",
  ],
  ["push", "Apply the schema diff to one target."],
  ["pull", "Write table files and a schema from one database."],
  ["seed <file>", "Run a seed file on one target."],
];

function commandsTable(): string {
  const lines = ["okm <command>", ""];
  for (const [name, summary] of COMMANDS) lines.push(`  ${name.padEnd(24)} ${summary}`);
  lines.push(
    "",
    "okm <command> --help prints that command.",
    "--config <path> loads that file instead of okmodel.config.ts.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function commandHelp(argv: readonly string[]): string {
  const key = argv.join(" ");
  const found = COMMANDS.find(([name]) => name === key || name.startsWith(`${key} `));
  if (found === undefined) {
    return `Unknown command ${key}.\n\n${commandsTable()}`;
  }
  const flags = flagsForHelp(found[0]);
  const lines = [found[0], found[1]];
  lines.push("", "Flags:");
  lines.push("  --config <path>");
  if (flags.length > 0) {
    for (const flag of flags) lines.push(`  ${flag}`);
  }
  return `${lines.join("\n")}\n`;
}

function flagsForHelp(commandLine: string): readonly string[] {
  const key = helpCommandKey(commandLine);
  if (key === undefined) return [];
  return COMMAND_FLAGS[key];
}

function helpCommandKey(commandLine: string): CommandKey | undefined {
  const name = commandLine
    .replace(/\s+\[.*?\]/g, "")
    .replace(/\s+<.*?>/g, "")
    .trim();
  if (name in COMMAND_FLAGS) return name as CommandKey;
  if (name.startsWith("ext ")) return "ext";
  return undefined;
}

function numberFlag(flag: string, value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new OkmError("invalid", `${flag} needs a number of milliseconds.`, {
      fix: { summary: `Pass ${flag} <milliseconds>.` },
    });
  }
  return parsed;
}
