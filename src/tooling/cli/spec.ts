/**
 * Per-command flag table for `okm`.
 *
 * `parseArgs` reads this table. `--help` prints it. Guard-relaxing flags
 * have no short form.
 */

/** One flag a command accepts. `name` is the long form without leading dashes. */
export type FlagSpec = {
  /** Long name, without `--`. */
  readonly name: string;
  /** Single-character short form, when the flag has one. */
  readonly short?: string;
  /** `parseArgs` type. */
  readonly type: "boolean" | "string";
  /** The flag may be repeated. */
  readonly multiple?: boolean;
  /** Help text after the flag. */
  readonly hint: string;
};

/** One `okm` command. */
export type CommandSpec = {
  /** Stable id, also the envelope `command` value. */
  readonly id: string;
  /** Leading positionals, in order. */
  readonly words: readonly string[];
  /** One-line summary used by `okm` and `okm <command> --help`. */
  readonly summary: string;
  /** Usage line in the command table. */
  readonly usage: string;
  /** Minimum operands after {@link words}. Ignored for `--help` and `--version`. */
  readonly minOperands: number;
  /** Maximum operands after {@link words}. */
  readonly maxOperands: number;
  /** Message when an operand is missing. */
  readonly missing?: string;
  /** The command may connect, so the envelope can carry `target`. */
  readonly usesDatabase: boolean;
  /**
   * `--out` is this command's own path, not a divert of JSON `data`.
   * `pull` and `import drizzle` take a directory. `catalog export` and
   * `ext scaffold` take a file.
   */
  readonly ownOut: "file" | "directory" | false;
  /** Flags besides the globals. */
  readonly flags: readonly FlagSpec[];
};

/** Flags every command accepts. `--out` diverts JSON `data` when the command does not own it. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "help", short: "h", type: "boolean", hint: "Print this help." },
  { name: "version", short: "V", type: "boolean", hint: "Print the package version." },
  { name: "verbose", short: "v", type: "boolean", hint: "Print the stack on a failure." },
  { name: "json", type: "boolean", hint: "Print one okm.cli/1 document on stdout." },
  {
    name: "config",
    short: "c",
    type: "string",
    hint: "<path> loads that file instead of okmodel.config.ts.",
  },
  {
    name: "out",
    short: "o",
    type: "string",
    hint: "<file> writes a large JSON payload. `-` keeps it on stdout.",
  },
];

const target: FlagSpec = {
  name: "target",
  short: "t",
  type: "string",
  hint: "<name>",
};

const allowProtected: FlagSpec = {
  name: "allow-protected",
  type: "boolean",
  hint: "This invocation only. No short form.",
};

const allowPooler: FlagSpec = {
  name: "allow-pooler",
  type: "boolean",
  hint: "This invocation only. No short form.",
};

const replace: FlagSpec = {
  name: "replace",
  type: "string",
  multiple: true,
  hint: "<table>.<column>.<old>=<new>. No short form.",
};

const lockTimeout: FlagSpec = {
  name: "lock-timeout",
  type: "string",
  hint: "<milliseconds>",
};

const statementTimeout: FlagSpec = {
  name: "statement-timeout",
  type: "string",
  hint: "<milliseconds>",
};

/** Every command, longest word list first so `migrate plan` wins over a prefix. */
export const COMMANDS: readonly CommandSpec[] = [
  spec({
    id: "migrate plan",
    words: ["migrate", "plan"],
    summary: "Print the plan and its lock estimates. --json prints a document.",
    usage: "migrate plan <name>",
    minOperands: 1,
    maxOperands: 1,
    missing: "okm migrate plan needs a name.",
    usesDatabase: true,
    ownOut: false,
    flags: [target, allowProtected, replace],
  }),
  spec({
    id: "migrate apply",
    words: ["migrate", "apply"],
    summary: "Apply pending migrations.",
    usage: "migrate apply",
    minOperands: 0,
    maxOperands: 0,
    usesDatabase: true,
    ownOut: false,
    flags: [target, allowProtected, allowPooler, lockTimeout, statementTimeout],
  }),
  spec({
    id: "migrate status",
    words: ["migrate", "status"],
    summary: "Print whether the target is current.",
    usage: "migrate status",
    minOperands: 0,
    maxOperands: 0,
    usesDatabase: true,
    ownOut: false,
    flags: [target],
  }),
  spec({
    id: "migrate check",
    words: ["migrate", "check"],
    summary: "Replay migration history in a scratch schema.",
    usage: "migrate check",
    minOperands: 0,
    maxOperands: 0,
    usesDatabase: true,
    ownOut: false,
    flags: [
      target,
      allowProtected,
      allowPooler,
      {
        name: "provision",
        type: "boolean",
        hint: "Compare a snapshot install with a full replay.",
      },
      lockTimeout,
      statementTimeout,
    ],
  }),
  spec({
    id: "migrate baseline",
    words: ["migrate", "baseline"],
    summary: "Record the head snapshot as applied on an existing database. No schema changes.",
    usage: "migrate baseline",
    minOperands: 0,
    maxOperands: 0,
    usesDatabase: true,
    ownOut: false,
    flags: [
      target,
      allowProtected,
      allowPooler,
      {
        name: "dry-run",
        short: "n",
        type: "boolean",
        hint: "Print what would be recorded and write nothing.",
      },
    ],
  }),
  spec({
    id: "catalog export",
    words: ["catalog", "export"],
    summary: "Write the catalog snapshot.",
    usage: "catalog export",
    minOperands: 0,
    maxOperands: 0,
    usesDatabase: false,
    ownOut: "file",
    flags: [],
  }),
  spec({
    id: "import drizzle",
    words: ["import", "drizzle"],
    summary:
      "Import a Drizzle schema. This runs that file. Writes table files and needs no database.",
    usage: "import drizzle <path>",
    minOperands: 1,
    maxOperands: 1,
    missing: "okm import drizzle needs a path.",
    usesDatabase: false,
    ownOut: "directory",
    flags: [],
  }),
  spec({
    id: "driver test",
    words: ["driver", "test"],
    summary: "Run conformance against one driver.",
    usage: "driver test <driver>",
    minOperands: 1,
    maxOperands: 1,
    missing: "okm driver test needs a driver: pglite, postgresjs, pg, bun, neon, or a module path.",
    usesDatabase: false,
    ownOut: false,
    flags: [{ name: "url", type: "string", hint: "<postgres-url>" }],
  }),
  spec({
    id: "ext scaffold",
    words: ["ext", "scaffold"],
    summary: "Print a starting extension() definition.",
    usage: "ext scaffold <name>",
    minOperands: 1,
    maxOperands: 1,
    missing: "okm ext scaffold <name> needs a name.",
    usesDatabase: true,
    ownOut: "file",
    flags: [target, allowPooler],
  }),
  spec({
    id: "ext check",
    words: ["ext", "check"],
    summary: "Compare declared extensions with the server.",
    usage: "ext check",
    minOperands: 0,
    maxOperands: 0,
    usesDatabase: true,
    ownOut: false,
    flags: [target, allowPooler],
  }),
  spec({
    id: "ext list",
    words: ["ext", "list"],
    summary: "List extensions the server can install.",
    usage: "ext list",
    minOperands: 0,
    maxOperands: 0,
    usesDatabase: true,
    ownOut: false,
    flags: [target, allowPooler],
  }),
  spec({
    id: "ext test",
    words: ["ext", "test"],
    summary: "Check an extension() definition against the server.",
    usage: "ext test <file>",
    minOperands: 1,
    maxOperands: 1,
    missing: "okm ext test <file> needs a name.",
    usesDatabase: true,
    ownOut: false,
    flags: [target, allowPooler],
  }),
  spec({
    id: "build",
    words: ["build"],
    summary: "Write the schema build.",
    usage: "build",
    minOperands: 0,
    maxOperands: 0,
    usesDatabase: false,
    ownOut: false,
    flags: [],
  }),
  spec({
    id: "check",
    words: ["check"],
    summary: "Lint the schema and compare it with one target.",
    usage: "check",
    minOperands: 0,
    maxOperands: 0,
    usesDatabase: true,
    ownOut: false,
    flags: [target, allowPooler, lockTimeout, statementTimeout],
  }),
  spec({
    id: "dev",
    words: ["dev"],
    summary: "Open a PGlite database in .okm/dev-db, or name a target called dev.",
    usage: "dev",
    minOperands: 0,
    maxOperands: 0,
    usesDatabase: true,
    ownOut: false,
    flags: [],
  }),
  spec({
    id: "doctor",
    words: ["doctor"],
    summary: "Print a target report, or one error code.",
    usage: "doctor [code]",
    minOperands: 0,
    maxOperands: 1,
    usesDatabase: true,
    ownOut: false,
    flags: [target],
  }),
  spec({
    id: "generate",
    words: ["generate"],
    summary: "Write the next migration.",
    usage: "generate [name]",
    minOperands: 0,
    maxOperands: 1,
    usesDatabase: false,
    ownOut: false,
    flags: [replace],
  }),
  spec({
    id: "push",
    words: ["push"],
    summary: "Apply the schema diff to one target.",
    usage: "push",
    minOperands: 0,
    maxOperands: 0,
    usesDatabase: true,
    ownOut: false,
    flags: [target, allowProtected, allowPooler],
  }),
  spec({
    id: "pull",
    words: ["pull"],
    summary: "Write table files and a schema from one database.",
    usage: "pull",
    minOperands: 0,
    maxOperands: 0,
    usesDatabase: true,
    ownOut: "directory",
    flags: [
      target,
      allowProtected,
      {
        name: "schema",
        type: "string",
        multiple: true,
        hint: "<name> selects a Postgres schema. Repeat it, or separate names with a comma.",
      },
    ],
  }),
  spec({
    id: "seed",
    words: ["seed"],
    summary: "Run a seed file on one target.",
    usage: "seed <file>",
    minOperands: 1,
    maxOperands: 1,
    missing: "okm seed needs a file.",
    usesDatabase: true,
    ownOut: false,
    flags: [target, allowProtected, allowPooler],
  }),
  spec({
    id: "schema",
    words: ["schema"],
    summary: "Print the JSON Schema for that command's --json data.",
    usage: "schema <command>",
    minOperands: 1,
    maxOperands: 4,
    missing: "okm schema needs a command.",
    usesDatabase: false,
    ownOut: false,
    flags: [],
  }),
];

/** Command ids that have a JSON Schema for `data`. */
export const COMMAND_IDS: readonly string[] = commandOrder();

function commandOrder(): readonly string[] {
  return [...COMMANDS].map((command) => command.id).sort();
}

function spec(command: CommandSpec): CommandSpec {
  return command;
}

/**
 * Flags `parseArgs` should accept for one command, globals included.
 *
 * @param command - Matched command, or `undefined` when the word is unknown
 * @returns Flag specs
 */
export function flagsFor(command: CommandSpec | undefined): readonly FlagSpec[] {
  if (command === undefined) return GLOBAL_FLAGS;
  return [...GLOBAL_FLAGS, ...command.flags];
}

/**
 * Long and short spellings a did-you-mean hint may offer.
 *
 * @param command - Matched command, or `undefined` for the global set
 * @returns Spellings including the leading dashes
 */
export function flagNames(command: CommandSpec | undefined): readonly string[] {
  const names: string[] = [];
  for (const flag of flagsFor(command)) {
    names.push(`--${flag.name}`);
    if (flag.short !== undefined) names.push(`-${flag.short}`);
  }
  return names;
}

/**
 * Help for one command, or the full table when `command` is omitted.
 *
 * @param command - Matched command
 * @returns Text including the trailing newline
 */
export function helpText(command: CommandSpec | undefined): string {
  if (command === undefined) return commandsTable();
  const lines = [command.usage, command.summary, "", "Flags:"];
  for (const flag of flagsFor(command)) lines.push(`  ${flagLine(flag)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The `okm` command table.
 *
 * @returns Text including the trailing newline
 */
export function commandsTable(): string {
  const lines = ["okm <command>", ""];
  const ordered = [...COMMANDS].sort((left, right) => (left.usage < right.usage ? -1 : 1));
  for (const command of ordered) lines.push(`  ${command.usage.padEnd(24)} ${command.summary}`);
  lines.push(
    "",
    "okm <command> --help prints that command.",
    "--config <path> loads that file instead of okmodel.config.ts.",
    "--json prints one okm.cli/1 document.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function flagLine(flag: FlagSpec): string {
  const short = flag.short === undefined ? "" : `-${flag.short}, `;
  const value = flag.type === "string" ? " <value>" : "";
  const repeated = flag.multiple === true ? " (repeatable)" : "";
  return `${short}--${flag.name}${value}${repeated}  ${flag.hint}`;
}
