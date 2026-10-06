/**
 * `okm` command dispatch.
 *
 * The bin wrapper imports {@link run}. Importing this module does not parse
 * `process.argv`.
 */

import { OkmError } from "../../contracts/error.js";
import { formatFindings, hasError, lintRefusal } from "./lint.js";
import type { InvokeFlags } from "./policy.js";
import { buildProject, checkProject, generateProject, planProject } from "./project.js";

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
export function formatFailure(error: OkmError): string {
  return `${error.code}: ${error.message}\n${error.fix.summary}\n`;
}

/**
 * Runs one `okm` invocation.
 *
 * `--version` stays in the bin. This function handles `build`, `check`,
 * `generate`, `dev`, `push`, `ext list`, `ext check`, `doctor`, and `migrate plan`,
 * `apply`, and `status`.
 *
 * @param argv - Arguments after the program name
 * @param io - Working directory and stdout. Defaults to the process
 */
export async function run(argv: readonly string[], io?: CommandIo): Promise<void> {
  const cwd = io?.cwd ?? process.cwd();
  const stdout = io?.stdout ?? ((text: string) => process.stdout.write(text));
  const [command, ...rest] = argv;
  if (command === "build") {
    const directory = await buildProject(cwd);
    stdout(`${directory}\n`);
    return;
  }
  if (command === "check") {
    const findings = await checkProject(cwd, invoke(splitFlags(rest)));
    const warnings = formatFindings(findings);
    if (warnings.length > 0) stdout(warnings);
    stdout("ok\n");
    return;
  }
  if (command === "generate") {
    const parsed = splitFlags(rest);
    const written = await generateProject(cwd, parsed.name ?? "migration", parsed.flags);
    stdout(written === undefined ? "no changes\n" : `${written.path}\n`);
    if (written !== undefined) stdout(formatFindings(written.findings));
    return;
  }
  if (command === "dev") {
    const { devProject } = await import("./dev.js");
    stdout(await devProject(cwd));
    return;
  }
  if (command === "push") {
    const { pushProject } = await import("./apply.js");
    stdout(await pushProject(cwd, invoke(splitFlags(rest))));
    return;
  }
  if (command === "migrate") {
    const sub = rest[0];
    const parsed = splitFlags(rest.slice(1));
    if (sub === "plan") {
      if (parsed.name === undefined) {
        throw new OkmError("invalid", "okm migrate plan needs a name.");
      }
      const planned = await planProject(cwd, parsed.name, parsed.flags, invoke(parsed));
      stdout(planned.text);
      stdout(formatFindings(planned.findings));
      if (hasError(planned.findings)) throw lintRefusal(planned.findings);
      return;
    }
    if (sub === "apply") {
      const { applyProject } = await import("./apply.js");
      stdout(await applyProject(cwd, invoke(parsed), stdout));
      return;
    }
    if (sub === "status") {
      const { statusProject } = await import("./status.js");
      stdout(await statusProject(cwd, invoke(parsed)));
      return;
    }
  }
  if (command === "doctor") {
    const parsed = splitFlags(rest);
    const { doctorProject } = await import("./doctor.js");
    stdout(await doctorProject(cwd, parsed.name, invoke(parsed)));
    return;
  }
  if (command === "ext") {
    const sub = rest[0];
    if (sub === "test" || sub === "scaffold") {
      throw new OkmError("invalid", `okm ext ${sub} is not available yet.`, {
        fix: { summary: "okm ext list and okm ext check are the commands in this version." },
      });
    }
    if (sub === "list" || sub === "check") {
      const { extProject } = await import("./ext.js");
      stdout(await extProject(cwd, sub, invoke(splitFlags(rest.slice(1)))));
      return;
    }
    throw new OkmError("invalid", `Unknown command ext ${sub ?? ""}.`, {
      fix: { summary: "Use okm ext list or okm ext check." },
    });
  }
  throw new OkmError("invalid", `Unknown command ${command ?? ""}.`);
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
  readonly lockTimeoutMs: number | undefined;
  readonly statementTimeoutMs: number | undefined;
};

function splitFlags(args: readonly string[]): Parsed {
  const flags: string[] = [];
  const positionals: string[] = [];
  let target: string | undefined;
  let allowProtected = false;
  let allowPooler = false;
  let lockTimeoutMs: number | undefined;
  let statementTimeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--replace") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new OkmError("OKM1541", "--replace needs table.column.old=new.", {
          fix: { summary: "Pass --replace <table>.<column>.<old>=<new>." },
        });
      }
      flags.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--replace=")) {
      flags.push(arg.slice("--replace=".length));
      continue;
    }
    if (arg === "--allow-protected") {
      allowProtected = true;
      continue;
    }
    if (arg === "--allow-pooler") {
      allowPooler = true;
      continue;
    }
    if (arg === "--target") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new OkmError("OKM1853", "--target needs a name.", {
          fix: { summary: "Pass --target <name>." },
        });
      }
      target = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
      continue;
    }
    if (arg === "--lock-timeout" || arg === "--statement-timeout") {
      const value = numberFlag(arg, args[index + 1]);
      if (arg === "--lock-timeout") lockTimeoutMs = value;
      else statementTimeoutMs = value;
      index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return {
    name: positionals[0],
    flags,
    target,
    allowProtected,
    allowPooler,
    lockTimeoutMs,
    statementTimeoutMs,
  };
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
