/**
 * `okm` command dispatch.
 *
 * The bin wrapper imports {@link run}. Importing this module does not parse
 * `process.argv`.
 */

import { OkmError } from "../../contracts/error.js";
import { formatPlan } from "./plan.js";
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
 * `generate`, and `migrate plan`.
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
  if (command === "migrate" && rest[0] === "plan") {
    const parsed = splitFlags(rest.slice(1));
    if (parsed.name === undefined) {
      throw new OkmError("invalid", "okm migrate plan needs a name.");
    }
    stdout(formatPlan(await planProject(cwd, parsed.name, parsed.flags)));
    return;
  }
  throw new OkmError("invalid", `Unknown command ${command ?? ""}.`);
}

function splitFlags(args: readonly string[]): {
  readonly name: string | undefined;
  readonly flags: readonly string[];
} {
  const flags: string[] = [];
  const positionals: string[] = [];
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
    positionals.push(arg);
  }
  return { name: positionals[0], flags };
}
