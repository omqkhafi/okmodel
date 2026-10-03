/**
 * `okm` command dispatch.
 *
 * The bin wrapper imports {@link run}. Importing this module does not parse
 * `process.argv`.
 */

import { OkmError } from "../../contracts/error.js";
import { formatPlan } from "./plan.js";
import type { InvokeFlags } from "./policy.js";
import { buildProject, checkProject, generateProject, planProject } from "./project.js";

/** Where a command reads the project and writes its text. */
export type CommandIo = {
  readonly cwd?: string;
  readonly stdout?: (text: string) => void;
};

/**
 * Runs one `okm` invocation.
 *
 * `--version` stays in the bin. This function handles `build`, `check`,
 * `generate`, `dev`, `push`, and `migrate plan`, `apply`, and `status`.
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
    await checkProject(cwd);
    stdout("ok\n");
    return;
  }
  if (command === "generate") {
    const parsed = splitFlags(rest);
    const path = await generateProject(cwd, parsed.name ?? "migration", parsed.flags);
    stdout(path === undefined ? "no changes\n" : `${path}\n`);
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
      stdout(formatPlan(await planProject(cwd, parsed.name, parsed.flags)));
      return;
    }
    if (sub === "apply") {
      const { applyProject } = await import("./apply.js");
      stdout(await applyProject(cwd, invoke(parsed)));
      return;
    }
    if (sub === "status") {
      const { statusProject } = await import("./status.js");
      stdout(await statusProject(cwd, invoke(parsed)));
      return;
    }
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
