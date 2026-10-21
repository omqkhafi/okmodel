/**
 * `okm` argument parsing.
 *
 * The command word selects a row of {@link COMMANDS}. `node:util` `parseArgs`
 * then parses that row with `strict: true`. A parse error is exit 2.
 */

import { parseArgs, type ParseArgsConfig } from "node:util";

import { nearestName } from "../../contracts/nearest.js";
import { OkmError } from "../../contracts/error.js";
import { tagOutcome } from "./outcome.js";
import { COMMANDS, flagNames, flagsFor, type CommandSpec } from "./spec.js";

/** One parsed invocation. Guard flags are booleans with no environment variable. */
export type ParsedCli = {
  /** Envelope `command`, or `null` for a bare help or version request. */
  readonly command: string | null;
  /** Matched spec. Absent for bare help, version, or an unknown word. */
  readonly spec: CommandSpec | undefined;
  readonly help: boolean;
  readonly version: boolean;
  readonly verbose: boolean;
  readonly json: boolean;
  readonly config: string | undefined;
  readonly target: string | undefined;
  readonly out: string | undefined;
  readonly allowProtected: boolean;
  readonly allowPooler: boolean;
  readonly dryRun: boolean;
  readonly provision: boolean;
  readonly replace: readonly string[];
  readonly schemas: readonly string[];
  readonly url: string | undefined;
  readonly lockTimeoutMs: number | undefined;
  readonly statementTimeoutMs: number | undefined;
  /** `okm migrate resolve --applied`. */
  readonly applied: boolean;
  /** `okm migrate resolve --retry`. */
  readonly retry: boolean;
  /** `okm migrate resolve --accept-unverified`. Long form only. */
  readonly acceptUnverified: boolean;
  /** `okm raw sync --check`. Do not write the lock. */
  readonly check: boolean;
  /** `okm init --yes`. Other commands leave this false. */
  readonly yes: boolean;
  /** `okm init --dialect`. */
  readonly dialect: string | undefined;
  /** `okm init --driver`. */
  readonly driver: string | undefined;
  /** `okm init --dir`. The db directory, not the project operand. */
  readonly dbDir: string | undefined;
  /** `okm init --pm`. */
  readonly pm: string | undefined;
  /** `okm init --tenancy`. */
  readonly tenancy: string | undefined;
  /** `okm init --install`. */
  readonly install: boolean;
  /** `okm init --no-install`. */
  readonly noInstall: boolean;
  /** `okm init --force-file`. */
  readonly forceFile: readonly string[];
  /** `okm init --plan-hash`. */
  readonly planHash: string | undefined;
  /** `okm init --workspace`. Repeatable package name or path. */
  readonly workspace: readonly string[];
  /** `okm init --all-workspaces`. */
  readonly allWorkspaces: boolean;
  /** `okm init --shared`. One database package. */
  readonly shared: boolean;
  /** `okm init --agents`. Targets, repeatable or comma-separated. */
  readonly agents: readonly string[];
  /** `okm init --no-agents`. */
  readonly noAgents: boolean;
  /** `okm agents update --protected`. `yes` or `no`. */
  readonly protectedFlag: string | undefined;
  /** Positionals after the command words. */
  readonly operands: readonly string[];
};

const GROUP_FIX: Readonly<Record<string, string>> = {
  migrate: "Use okm migrate plan, apply, status, resolve, check, or baseline.",
  ext: "Use okm ext list, okm ext check, okm ext scaffold, or okm ext test.",
  catalog: "Use okm catalog export.",
  raw: "Use okm raw sync.",
  agents: "Use okm agents status, okm agents update, or okm agents remove.",
  import: "Use okm import drizzle <path>.",
  driver: "Use okm driver test <driver>.",
};

const VALUE_SHORTS = new Set(["c", "t", "o"]);
const BOOLEAN_SHORTS = new Set(["h", "V", "v", "n", "y"]);

/**
 * Whether `argv` contains `--json` as a flag, not as another flag's value.
 *
 * A usage error still emits an envelope when this is true.
 *
 * @param argv - Arguments after the program name
 * @returns `true` when `--json` was given
 */
export function argvHasJson(argv: readonly string[]): boolean {
  const valueFlags = valueFlagSet();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") return false;
    if (arg === "--json") return true;
    if (!arg.startsWith("-") || arg === "-") continue;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (eq === -1 && consumesNext(arg, valueFlags)) index += 1;
    if (flag === "--json") return true;
  }
  return false;
}

/**
 * Parses one invocation.
 *
 * `--allow-protected`, `--allow-pooler`, and `--replace` are not read from
 * the environment. `-f` is not a short form.
 *
 * @param argv - Arguments after the program name
 * @returns The invocation
 * @throws OkmError tagged `usage` when the arguments are not accepted
 */
export function parseCli(argv: readonly string[]): ParsedCli {
  if (argv.length === 0 || argv[0] === "help") {
    return blank({ help: true, json: argvHasJson(argv) });
  }
  const words = commandWords(argv);
  if (words[0] === "help") return blank({ help: true, json: argvHasJson(argv) });
  const matched = matchCommand(words);
  if (matched === undefined && words.length > 0) {
    const group = GROUP_FIX[words[0] ?? ""];
    if (group !== undefined) throw usage(`Unknown command ${words.join(" ")}.`, group);
    const hint = nearestName(words[0] ?? "", commandHeads());
    const name = words.join(" ");
    throw usage(
      `Unknown command ${name}.`,
      hint === undefined
        ? "Run okm --help for the command list."
        : `Run okm --help for the command list. Did you mean ${hint}?`,
      hint,
    );
  }
  const spec = matched?.spec;
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(parseConfig(argv, spec));
  } catch (error) {
    throw fromParseError(error, spec);
  }
  const values = parsed.values;
  if (repeatedConfig(parsed.tokens) !== undefined) {
    throw usage("--config was passed more than once.", "Pass --config once.");
  }
  const help = values.help === true;
  const version = values.version === true;
  const operands = spec === undefined ? words : words.slice(spec.words.length);
  if (!help && !version && spec !== undefined) {
    if (operands.length < spec.minOperands) {
      throw usage(spec.missing ?? `okm ${spec.id} needs an argument.`, `Pass ${spec.usage}.`);
    }
    if (operands.length > spec.maxOperands) {
      throw usage(
        `Unexpected argument ${operands[spec.maxOperands] ?? ""}.`,
        `Pass ${spec.usage}.`,
      );
    }
  }
  const config = stringValue(values.config);
  const target = stringValue(values.target);
  const out = stringValue(values.out);
  if (
    out !== undefined &&
    spec !== undefined &&
    spec.ownOut === false &&
    values.json !== true &&
    !help &&
    !version
  ) {
    throw usage("--out needs --json for this command.", "Pass --json --out <file>, or drop --out.");
  }
  return {
    command: spec?.id ?? null,
    spec,
    help,
    version,
    verbose: values.verbose === true,
    json: values.json === true,
    ...(config === undefined ? { config: undefined } : { config }),
    ...(target === undefined ? { target: undefined } : { target }),
    ...(out === undefined ? { out: undefined } : { out }),
    allowProtected: values["allow-protected"] === true,
    allowPooler: values["allow-pooler"] === true,
    dryRun: values["dry-run"] === true,
    provision: values.provision === true,
    replace: stringList(values.replace),
    schemas: schemasOf(values.schema),
    url: stringValue(values.url),
    lockTimeoutMs: milliseconds(values["lock-timeout"], "--lock-timeout"),
    statementTimeoutMs: milliseconds(values["statement-timeout"], "--statement-timeout"),
    applied: values.applied === true,
    retry: values.retry === true,
    acceptUnverified: values["accept-unverified"] === true,
    check: values.check === true,
    yes: values.yes === true,
    dialect: stringValue(values.dialect),
    driver: stringValue(values.driver),
    dbDir: stringValue(values.dir),
    pm: stringValue(values.pm),
    tenancy: stringValue(values.tenancy),
    install: values.install === true,
    noInstall: values["no-install"] === true,
    forceFile: stringList(values["force-file"]),
    planHash: stringValue(values["plan-hash"]),
    workspace: stringList(values.workspace),
    allWorkspaces: values["all-workspaces"] === true,
    shared: values.shared === true,
    agents: stringList(values.agents),
    noAgents: values["no-agents"] === true,
    protectedFlag: stringValue(values.protected),
    operands,
  };
}

function blank(flags: { readonly help: boolean; readonly json: boolean }): ParsedCli {
  return {
    command: null,
    spec: undefined,
    help: flags.help,
    version: false,
    verbose: false,
    json: flags.json,
    config: undefined,
    target: undefined,
    out: undefined,
    allowProtected: false,
    allowPooler: false,
    dryRun: false,
    provision: false,
    replace: [],
    schemas: [],
    url: undefined,
    lockTimeoutMs: undefined,
    statementTimeoutMs: undefined,
    applied: false,
    retry: false,
    acceptUnverified: false,
    check: false,
    yes: false,
    dialect: undefined,
    driver: undefined,
    dbDir: undefined,
    pm: undefined,
    tenancy: undefined,
    install: false,
    noInstall: false,
    forceFile: [],
    planHash: undefined,
    workspace: [],
    allWorkspaces: false,
    shared: false,
    agents: [],
    noAgents: false,
    protectedFlag: undefined,
    operands: [],
  };
}

function parseConfig(argv: readonly string[], spec: CommandSpec | undefined): ParseArgsConfig {
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const flag of flagsFor(spec)) {
    options[flag.name] = {
      type: flag.type,
      ...(flag.short === undefined ? {} : { short: flag.short }),
      ...(flag.multiple === true ? { multiple: true } : {}),
    };
  }
  return {
    args: [...argv],
    options,
    strict: true,
    allowPositionals: true,
    tokens: true,
  };
}

function commandHeads(): readonly string[] {
  const heads = new Set<string>();
  for (const command of COMMANDS) {
    const head = command.words[0];
    if (head !== undefined) heads.add(head);
  }
  return [...heads];
}

function matchCommand(words: readonly string[]): { readonly spec: CommandSpec } | undefined {
  let found: CommandSpec | undefined;
  let length = 0;
  for (const command of COMMANDS) {
    if (command.words.length > words.length) continue;
    if (command.words.length <= length) continue;
    if (command.words.every((word, index) => words[index] === word)) {
      found = command;
      length = command.words.length;
    }
  }
  return found === undefined ? undefined : { spec: found };
}

function commandWords(argv: readonly string[]): readonly string[] {
  const valueFlags = valueFlagSet();
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      words.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("-") && arg !== "-") {
      const eq = arg.indexOf("=");
      if (eq === -1 && consumesNext(arg, valueFlags)) index += 1;
      continue;
    }
    words.push(arg);
  }
  return words;
}

function valueFlagSet(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const command of COMMANDS) {
    for (const flag of flagsFor(command)) {
      if (flag.type !== "string") continue;
      names.add(`--${flag.name}`);
      if (flag.short !== undefined) names.add(`-${flag.short}`);
    }
  }
  return names;
}

function consumesNext(arg: string, valueFlags: ReadonlySet<string>): boolean {
  if (arg.startsWith("--")) return valueFlags.has(arg);
  const body = arg.slice(1);
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index] ?? "";
    if (VALUE_SHORTS.has(ch)) return index === body.length - 1;
    if (!BOOLEAN_SHORTS.has(ch)) return false;
  }
  return false;
}

function fromParseError(error: unknown, spec: CommandSpec | undefined): OkmError {
  const message = error instanceof Error ? error.message : String(error);
  const unknown = /Unknown option '([^']+)'/.exec(message);
  if (unknown !== null) {
    const flag = unknown[1] ?? "";
    const bare = flag.replace(/^-+/, "");
    const names = flagNames(spec);
    const hint = nearestName(
      bare,
      names.map((item) => item.replace(/^-+/, "")),
    );
    const spelled =
      hint === undefined ? undefined : names.find((item) => item.replace(/^-+/, "") === hint);
    const fix =
      spelled === undefined
        ? `Use okm ${spec?.id ?? ""} --help for the flags this command accepts.`.replace("  ", " ")
        : `Did you mean ${spelled}?`;
    return usage(`Unknown flag ${flag}.`, fix, spelled);
  }
  const missing = /Option '([^']+)'/.exec(message);
  if (missing !== null && message.includes("argument missing")) {
    const raw = missing[1] ?? "";
    const long = /--([a-z0-9-]+)/.exec(raw);
    const name = long?.[1] ?? raw;
    return missingValue(name);
  }
  return usage(message.split("\n")[0] ?? "Could not parse arguments.", "Run okm --help.");
}

function missingValue(name: string): OkmError {
  if (name === "target") {
    return usageCode("OKM1853", "--target needs a name.", "Pass --target <name>.");
  }
  if (name === "replace") {
    return usageCode(
      "OKM1541",
      "--replace needs table.column.old=new.",
      "Pass --replace <table>.<column>.<old>=<new>.",
    );
  }
  if (name === "config") {
    return usage("--config needs a path.", "Pass --config <path> to okmodel.config.ts.");
  }
  if (name === "out") return usage("--out needs a file.", "Pass --out <file>.");
  if (name === "url")
    return usage("okm driver test --url needs a postgres URL.", "Pass --url <postgres-url>.");
  if (name === "schema") return usage("--schema needs a name.", "Pass --schema <name>.");
  if (name === "lock-timeout" || name === "statement-timeout") {
    return usage(`--${name} needs a number of milliseconds.`, `Pass --${name} <milliseconds>.`);
  }
  if (name === "dialect") return usage("--dialect needs a name.", "Pass --dialect postgres.");
  if (name === "driver") {
    return usage(
      "--driver needs a name.",
      "Pass --driver postgresjs, pg, bun-sql, pglite, or neon.",
    );
  }
  if (name === "dir") return usage("--dir needs a path.", "Pass --dir <path>.");
  if (name === "pm") return usage("--pm needs a name.", "Pass --pm bun, npm, pnpm, or yarn.");
  if (name === "tenancy") {
    return usage("--tenancy needs a mode.", "Pass --tenancy none, column, schema, or database.");
  }
  if (name === "force-file")
    return usage("--force-file needs a path.", "Pass --force-file <path>.");
  if (name === "plan-hash") return usage("--plan-hash needs a hash.", "Pass --plan-hash <hash>.");
  if (name === "workspace") {
    return usage("--workspace needs a name or path.", "Pass --workspace <name>.");
  }
  return usage(`--${name} needs a value.`, `Pass --${name} <value>.`);
}

function repeatedConfig(
  tokens:
    | readonly { readonly kind: string; readonly name?: string; readonly value?: unknown }[]
    | undefined,
): string | undefined {
  if (tokens === undefined) return undefined;
  let seen: string | undefined;
  for (const token of tokens) {
    if (token.kind !== "option" || token.name !== "config") continue;
    const value = typeof token.value === "string" ? token.value : "";
    if (seen === undefined) {
      seen = value;
      continue;
    }
    if (seen !== value) return value;
  }
  return undefined;
}

function milliseconds(value: unknown, flag: string): number | undefined {
  const text = stringValue(value);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw usage(`${flag} needs a number of milliseconds.`, `Pass ${flag} <milliseconds>.`);
  }
  return parsed;
}

function schemasOf(value: unknown): readonly string[] {
  const items = stringList(value);
  const names: string[] = [];
  for (const item of items)
    names.push(
      ...item
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    );
  return names;
}

function stringList(value: unknown): readonly string[] {
  if (typeof value === "string") return value.length === 0 ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    if (typeof last === "string" && last.length > 0) return last;
  }
  return undefined;
}

function usage(message: string, fix: string, suggestion?: string): OkmError {
  return tagOutcome(
    new OkmError("invalid", message, {
      fix: suggestion === undefined ? { summary: fix } : { summary: fix, suggestion },
    }),
    "usage",
  );
}

function usageCode(code: string, message: string, fix: string): OkmError {
  return tagOutcome(new OkmError(code, message, { fix: { summary: fix } }), "usage");
}
