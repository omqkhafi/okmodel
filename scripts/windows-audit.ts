/**
 * Windows checklist from `docs/oke-windows-audit.md`.
 *
 * The workflow packs a tarball, installs it into a directory whose path
 * contains a space, and runs one subcommand per checklist step. A step that
 * needs a TCP Postgres URL is `skip`.
 *
 *   bun ./scripts/windows-audit.ts <command> [args]
 */

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

import { nodeSupportsConfigTypes } from "../src/tooling/node-version.js";

const SCHEMA = [
  'import { schema, table, t } from "okmodel/pg";',
  "export const app = schema({",
  '  tables: [table("tasks", { id: t.identity(), title: t.text() })],',
  "});",
  "",
].join("\n");

const CASE_SCHEMA = [
  'import { schema } from "okmodel/pg";',
  'import { tasks } from "./tasks";',
  "export const app = schema({ tables: [tasks] });",
  "",
].join("\n");

const TASKS_MODULE = [
  'import { table, t } from "okmodel/pg";',
  'export const tasks = table("tasks", { id: t.identity(), title: t.text() });',
  "",
].join("\n");

const GIT_ATTRIBUTES =
  "migrations/*.sql text eol=lf\n*.catalog.json text eol=lf\n.okm/** text eol=lf\n";

type Result = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

/**
 * Runs one checklist command.
 *
 * @param argv - Arguments after the script path
 */
async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  if (command === "install") await install(pathArg(argv, 1), pathArg(argv, 2));
  else if (command === "versions") await versions(pathArg(argv, 1));
  else if (command === "init") await init(pathArg(argv, 1));
  else if (command === "lf") await lineEndings(pathArg(argv, 1));
  else if (command === "sources") await sources(pathArg(argv, 1));
  else if (command === "hashes") await writeHashes(pathArg(argv, 1), pathArg(argv, 2));
  else if (command === "compare") await compareHashes(pathArg(argv, 1), pathArg(argv, 2));
  else if (command === "connect") await connectHash(pathArg(argv, 1));
  else if (command === "check") await checkCase(pathArg(argv, 1));
  else if (command === "autocrlf") await autoCrlf(pathArg(argv, 1));
  else if (command === "dev") await devTwice(pathArg(argv, 1));
  else if (command === "driver") await driver(pathArg(argv, 1));
  else if (command === "pipe") await namedPipe(pathArg(argv, 1));
  else if (command === "skip") process.stdout.write(`SKIP: ${argv.slice(1).join(" ")}\n`);
  else throw new Error(`Unknown command ${command ?? ""}.`);
}

/**
 * Installs the packed tarball and the optional drivers into `smoke`.
 *
 * @param tarball - Absolute path of the `.tgz`
 * @param smoke - Project directory. The path contains a space
 */
async function install(tarball: string, smoke: string): Promise<void> {
  mkdirSync(smoke, { recursive: true });
  writeFileSync(
    join(smoke, "package.json"),
    `${JSON.stringify({ name: "okm-windows-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  await demand(
    ["bun", "add", tarball, "@electric-sql/pglite@^0.5.8", "pg@^8.16.0", "postgres@^3.4.9"],
    smoke,
    180_000,
  );
}

/**
 * `bunx okm --version` and `bun --bun okm --version` from the packed install.
 *
 * @param smoke - Directory that depends on the tarball
 */
async function versions(smoke: string): Promise<void> {
  const nodeVersion = await demand(["node", "--version"], smoke, 30_000);
  const shown = nodeVersion.stdout.trim();
  if (!nodeSupportsConfigTypes(shown)) {
    throw new Error(`Node ${shown} is older than 22.18.`);
  }
  process.stdout.write(`node ${shown}\n`);
  const expected = packageVersion(smoke);
  const bunx = await demand(["bunx", "okm", "--version"], smoke, 60_000);
  const bun = await demand(["bun", "--bun", "okm", "--version"], smoke, 60_000);
  if (!bunx.stdout.includes(expected) || !bun.stdout.includes(expected)) {
    throw new Error(`Expected version ${expected} from the packed tarball.`);
  }
}

/**
 * `okm generate init` with a relative schema, a drive-letter schema, and a `..` schema.
 *
 * Each shape runs on Node 22.18+ and on `bun --bun`. The project path contains a space.
 *
 * @param smoke - Directory that depends on the tarball
 */
async function init(smoke: string): Promise<void> {
  for (const runtime of ["node", "bun"] as const) {
    const relative = projectPath(smoke, `relative ${runtime}`);
    await generate(smoke, relative, runtime, "./schema.ts");
    const absolute = projectPath(smoke, `absolute ${runtime}`);
    const schemaFile = join(absolute, "schema.ts");
    await generate(smoke, absolute, runtime, schemaFile);
    const parent = projectPath(smoke, `parent ${runtime}`);
    const parentSchema = join(parent, "schema.ts");
    const spec = `${dirname(parentSchema)}${sep}nested${sep}..${sep}${basename(parentSchema)}`;
    await generate(smoke, parent, runtime, spec);
  }
  process.stdout.write(
    "SKIP: okm seed needs a TCP Postgres URL. This job does not start a service container.\n",
  );
}

/**
 * Asserts generated text is LF, and prints the migration file names.
 *
 * @param smoke - Directory that depends on the tarball
 */
async function lineEndings(smoke: string): Promise<void> {
  const project = projectPath(smoke, "relative node");
  const files = [
    join(project, ".gitattributes"),
    join(project, ".okm", "catalog.json"),
    join(project, ".okm", "catalog.hash"),
    join(project, ".okm", "types.d.ts"),
  ];
  const migrations = readdirSync(join(project, "migrations"));
  process.stdout.write(`migrations ${migrations.join(", ")}\n`);
  const sql = migrations.filter((name) => name.endsWith(".sql"));
  const catalogs = migrations.filter((name) => name.endsWith(".catalog.json"));
  if (sql.length === 0 || catalogs.length === 0) {
    throw new Error("okm generate did not write a .sql file and a .catalog.json sibling.");
  }
  for (const name of migrations) files.push(join(project, "migrations", name));
  for (const file of files) assertLf(file);
  const attributes = readFileSync(join(project, ".gitattributes"), "utf8");
  if (attributes !== GIT_ATTRIBUTES) {
    throw new Error(`.gitattributes was ${JSON.stringify(attributes)}`);
  }
}

/**
 * Prints the recorded `source` of `table()` under Node and Bun.
 *
 * @param smoke - Directory that depends on the tarball
 */
async function sources(smoke: string): Promise<void> {
  const probe = writeProbe(
    smoke,
    "source.mjs",
    [
      'import { pathToFileURL } from "node:url";',
      "const imported = await import(pathToFileURL(process.argv[2]).href);",
      "const objects = imported.app.catalog.objects;",
      "for (const object of objects) {",
      '  if (object.kind === "table") console.log(`source=${object.provenance.source ?? ""}`);',
      "}",
      "",
    ].join("\n"),
  );
  for (const runtime of ["node", "bun"] as const) {
    const schema = join(projectPath(smoke, `relative ${runtime}`), "schema.ts");
    const command = runtime === "node" ? ["node", probe, schema] : ["bun", probe, schema];
    const result = await demand(command, smoke, 60_000);
    const line = result.stdout
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.startsWith("source="));
    const source = line?.slice("source=".length) ?? "";
    if (source.length === 0) throw new Error(`${runtime} recorded no source for table().`);
    process.stdout.write(`recorded ${runtime} ${source}\n`);
  }
}

/**
 * Writes the Node and Bun `catalog.hash` files for the Linux job.
 *
 * @param smoke - Directory that depends on the tarball
 * @param outDir - Directory that receives `node.hash` and `bun.hash`
 */
async function writeHashes(smoke: string, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  for (const runtime of ["node", "bun"] as const) {
    const project = projectPath(smoke, `relative ${runtime}`);
    await generate(smoke, project, runtime, "./schema.ts");
    writeFileSync(join(outDir, `${runtime}.hash`), `${readHash(project)}\n`);
  }
}

/**
 * Compares Windows `catalog.hash` files with the Linux job's copies.
 *
 * @param smoke - Directory that depends on the tarball
 * @param linuxDir - Directory containing `node.hash` and `bun.hash`
 */
async function compareHashes(smoke: string, linuxDir: string): Promise<void> {
  for (const runtime of ["node", "bun"] as const) {
    const local = readHash(projectPath(smoke, `relative ${runtime}`));
    const linux = readFileSync(join(linuxDir, `${runtime}.hash`), "utf8").trim();
    process.stdout.write(`catalogHash ${runtime} windows=${local} linux=${linux}\n`);
    if (local !== linux) {
      throw new Error(`${runtime} catalog.hash differs from the Linux build.`);
    }
  }
}

/**
 * `connect()` reads `.okm/catalog.hash` when `cwd` is a backslash path.
 *
 * The file hash differs from the in-memory catalog. `okm_meta` stores the
 * file hash. A connect that ignores the file does not match.
 *
 * @param smoke - Directory that depends on the tarball
 */
async function connectHash(smoke: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("connect with a backslash cwd runs on Windows.");
  }
  const project = resolve(projectPath(smoke, "relative node")).replaceAll("/", "\\");
  const probe = writeProbe(
    smoke,
    "connect.mjs",
    [
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { chdir } from "node:process";',
      'import { connect, open } from "okmodel/pg/pglite";',
      'import { schema, table, t } from "okmodel/pg";',
      "const cwd = process.argv[2];",
      "chdir(cwd);",
      'const sentinel = "ab".repeat(32);',
      'writeFileSync(join(cwd, ".okm", "catalog.hash"), `${sentinel}\\n`);',
      "const pool = await open();",
      'await pool.execute("create table okm_meta (id text primary key, catalog_hash text not null, migration_id text not null)");',
      "await pool.execute(`insert into okm_meta (id, catalog_hash, migration_id) values ('head', '${sentinel}', 'none')`);",
      'const app = schema({ tables: [table("probe", { id: t.identity() })] });',
      "const db = await connect(pool, { schema: app });",
      "await db.connected;",
      "console.log(`connect-read ${cwd}/.okm`);",
      "await db.close();",
      "",
    ].join("\n"),
  );
  for (const runtime of ["node", "bun"] as const) {
    const command = runtime === "node" ? ["node", probe, project] : ["bun", probe, project];
    await demand(command, smoke, 90_000);
  }
}

/**
 * `okm check` with `tables/Tasks.ts` and a schema that only contains `tasks`.
 *
 * @param smoke - Directory that depends on the tarball
 */
async function checkCase(smoke: string): Promise<void> {
  const project = projectPath(smoke, "case check");
  mkdirSync(join(project, "tables"), { recursive: true });
  writeFileSync(join(project, "schema.ts"), CASE_SCHEMA);
  writeFileSync(join(project, "tasks.ts"), TASKS_MODULE);
  writeFileSync(join(project, "tables", "Tasks.ts"), TASKS_MODULE);
  writeFileSync(
    join(project, "okmodel.config.ts"),
    configSource("./schema.ts", 'tables: "./tables"'),
  );
  for (const runtime of ["node", "bun"] as const) {
    const result = await run(okm(smoke, runtime, ["check"]), project, 60_000);
    process.stdout.write(`$ ${runtime} okm check\n`);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.stderr.includes("OKM1024") || result.stdout.includes("OKM1024")) {
      throw new Error("okm check reported OKM1024 for Tasks.ts.");
    }
    if (result.code === 0) continue;
    const unresolved =
      result.stderr.includes("Cannot find module") && result.stderr.includes("tasks");
    if (runtime === "node" && unresolved) {
      process.stdout.write(
        "Node did not resolve the extensionless ./tasks import. Bun loaded it, and the result was not OKM1024.\n",
      );
      continue;
    }
    throw new Error(`${runtime} okm check exited ${String(result.code)}.`);
  }
}

/**
 * Clones with `core.autocrlf=true` and checks that `eol=lf` kept the bytes LF.
 *
 * @param smoke - Directory that depends on the tarball
 */
async function autoCrlf(smoke: string): Promise<void> {
  const project = projectPath(smoke, "relative bun");
  const origin = projectPath(smoke, "autocrlf origin");
  const clone = projectPath(smoke, "autocrlf clone");
  rmSync(origin, { recursive: true, force: true });
  rmSync(clone, { recursive: true, force: true });
  cpSync(project, origin, { recursive: true });
  const gitEnv = {
    GIT_AUTHOR_NAME: "okm",
    GIT_AUTHOR_EMAIL: "okm@example.com",
    GIT_COMMITTER_NAME: "okm",
    GIT_COMMITTER_EMAIL: "okm@example.com",
  };
  await demand(["git", "init"], origin, 30_000, gitEnv);
  await demand(["git", "add", ".gitattributes", ".okm", "migrations"], origin, 30_000, gitEnv);
  await demand(
    ["git", "-c", "commit.gpgsign=false", "commit", "-m", "init"],
    origin,
    30_000,
    gitEnv,
  );
  await demand(["git", "clone", "-c", "core.autocrlf=true", origin, clone], smoke, 60_000, gitEnv);
  for (const relative of [
    join(".okm", "catalog.json"),
    join(".okm", "catalog.hash"),
    join(".okm", "types.d.ts"),
  ]) {
    assertLf(join(clone, relative));
  }
  for (const name of readdirSync(join(clone, "migrations")))
    assertLf(join(clone, "migrations", name));
  process.stdout.write("autocrlf clone kept LF\n");
  process.stdout.write(
    "SKIP: a pre-existing .gitattributes that omits eol=lf, then okm migrate check and okm migrate apply, needs a TCP Postgres URL. This job does not start a service container.\n",
  );
}

/**
 * `okm dev`, then a second open of `.okm/dev-db`.
 *
 * @param smoke - Directory that depends on the tarball
 */
async function devTwice(smoke: string): Promise<void> {
  for (const runtime of ["node", "bun"] as const) {
    const project = projectPath(smoke, `dev ${runtime}`);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "schema.ts"), SCHEMA);
    writeFileSync(join(project, "okmodel.config.ts"), configSource("./schema.ts"));
    await demand(okm(smoke, runtime, ["dev"]), project, 90_000);
    await demand(okm(smoke, runtime, ["dev"]), project, 90_000);
  }
}

/**
 * `okm driver test pglite` from the packed tarball.
 *
 * @param smoke - Directory that depends on the tarball
 */
async function driver(smoke: string): Promise<void> {
  await demand(okm(smoke, "node", ["driver", "test", "pglite"]), smoke, 12 * 60_000);
}

/**
 * Connects to a Windows named-pipe host and prints the error.
 *
 * @param smoke - Directory that depends on the tarball
 */
async function namedPipe(smoke: string): Promise<void> {
  const probe = writeProbe(
    smoke,
    "pipe.mjs",
    [
      'import { connect } from "okmodel/pg/pg";',
      'import { schema, table, t } from "okmodel/pg";',
      'const app = schema({ tables: [table("tasks", { id: t.identity() })] });',
      'const url = "postgres://postgres@/postgres?host=\\\\\\\\.\\\\pipe\\\\okmodel-audit";',
      "try {",
      "  const db = connect(url, { schema: app, timeout: 3000 });",
      "  await db.connected;",
      '  console.log("named-pipe: connected");',
      "  await db.close();",
      "} catch (error) {",
      "  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);",
      "  console.log(`named-pipe error: ${message}`);",
      "}",
      "",
    ].join("\n"),
  );
  for (const runtime of ["node", "bun"] as const) {
    const command = runtime === "node" ? ["node", probe] : ["bun", probe];
    const result = await run(command, smoke, 20_000);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    const recorded =
      result.stdout.includes("named-pipe error:") ||
      result.stdout.includes("named-pipe: connected");
    if (!recorded) {
      throw new Error(
        `${runtime} named-pipe probe exited ${String(result.code)} without a recorded error.`,
      );
    }
  }
}

/**
 * Writes the schema and config, then runs `okm generate init`.
 *
 * @param smoke - Directory that depends on the tarball
 * @param project - Fresh project directory
 * @param runtime - Node or Bun
 * @param schemaSpec - Value of `schema` in the config
 */
async function generate(
  smoke: string,
  project: string,
  runtime: "node" | "bun",
  schemaSpec: string,
): Promise<void> {
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "schema.ts"), SCHEMA);
  writeFileSync(join(project, "okmodel.config.ts"), configSource(schemaSpec));
  await demand(okm(smoke, runtime, ["generate", "init"]), project, 90_000);
}

/**
 * @param schemaSpec - Config `schema` value
 * @param extra - Extra config fields, already valid TypeScript
 * @returns `okmodel.config.ts` source
 */
function configSource(schemaSpec: string, extra?: string): string {
  const fields = [`schema: ${JSON.stringify(schemaSpec)}`];
  if (extra !== undefined) fields.push(extra);
  return [
    'import { defineConfig } from "okmodel/migrate";',
    `export default defineConfig({ ${fields.join(", ")} });`,
    "",
  ].join("\n");
}

/**
 * @param smoke - Directory that depends on the tarball
 * @param name - Project directory name. It may contain spaces
 * @returns Absolute project path
 */
function projectPath(smoke: string, name: string): string {
  return join(smoke, "projects", name);
}

/**
 * @param smoke - Directory that depends on the tarball
 * @param runtime - Node or `bun --bun`
 * @param args - Arguments after `okm`
 * @returns Command argv
 */
function okm(smoke: string, runtime: "node" | "bun", args: readonly string[]): readonly string[] {
  const bin = join(smoke, "node_modules", "okmodel", "dist", "okm.js");
  if (runtime === "node") return ["node", bin, ...args];
  return ["bun", "--bun", bin, ...args];
}

/**
 * @param smoke - Directory that depends on the tarball
 * @returns `package.json` version of the installed tarball
 */
function packageVersion(smoke: string): string {
  const parsed: unknown = JSON.parse(
    readFileSync(join(smoke, "node_modules", "okmodel", "package.json"), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error("Installed okmodel has no version.");
  }
  const version = parsed.version;
  if (typeof version !== "string") throw new Error("Installed okmodel version is not a string.");
  return version;
}

/**
 * @param project - Project that `okm generate init` wrote
 * @returns Trimmed `catalog.hash`
 */
function readHash(project: string): string {
  return readFileSync(join(project, ".okm", "catalog.hash"), "utf8").trim();
}

/**
 * @param file - File that must not contain CR
 */
function assertLf(file: string): void {
  const bytes = readFileSync(file);
  if (bytes.includes(0x0d)) throw new Error(`${file} contains CR`);
}

/**
 * @param smoke - Directory that depends on the tarball
 * @param name - File name under `probes/`
 * @param source - Probe source
 * @returns Absolute probe path
 */
function writeProbe(smoke: string, name: string, source: string): string {
  const directory = join(smoke, "probes");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, source);
  return path;
}

/**
 * @param argv - Command arguments
 * @param index - Index of a path argument
 * @returns A native absolute path
 */
function pathArg(argv: readonly string[], index: number): string {
  const value = argv[index];
  if (value === undefined || value.length === 0)
    throw new Error(`Missing path argument ${String(index)}.`);
  return nativePath(value);
}

/**
 * Turns a Git Bash `/d/...` path into `D:\...` on Windows.
 *
 * @param input - Path from the workflow shell
 * @returns Absolute native path
 */
function nativePath(input: string): string {
  const slashed = input.replaceAll("\\", "/");
  const msys = /^\/([A-Za-z])\/(.*)$/.exec(slashed);
  if (msys !== null && process.platform === "win32") {
    const drive = (msys[1] ?? "c").toUpperCase();
    const rest = (msys[2] ?? "").replaceAll("/", "\\");
    return resolve(`${drive}:\\${rest}`);
  }
  return resolve(input);
}

/**
 * Runs a command and throws when it exits non-zero.
 *
 * @param args - Command and arguments
 * @param cwd - Working directory
 * @param timeoutMs - Kill the process after this many milliseconds
 * @param extra - Extra environment variables
 * @returns The command result
 */
async function demand(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  extra?: Readonly<Record<string, string>>,
): Promise<Result> {
  const result = await run(args, cwd, timeoutMs, extra);
  process.stdout.write(`$ ${args.join(" ")}\n`);
  process.stdout.write(result.stdout);
  if (result.stdout.length > 0 && !result.stdout.endsWith("\n")) process.stdout.write("\n");
  process.stderr.write(result.stderr);
  if (result.code !== 0) throw new Error(`${args.join(" ")} exited ${String(result.code)}.`);
  return result;
}

/**
 * Runs a command and keeps stdout and stderr.
 *
 * @param args - Command and arguments
 * @param cwd - Working directory
 * @param timeoutMs - Kill the process after this many milliseconds
 * @param extra - Extra environment variables
 * @returns Exit code and captured text
 */
async function run(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  extra?: Readonly<Record<string, string>>,
): Promise<Result> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const bin = join(cwd, "node_modules", ".bin");
  const path = `${bin}${delimiter}${env.PATH ?? env.Path ?? ""}`;
  env.PATH = path;
  env.Path = path;
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) env[key] = value;
  }
  try {
    const proc = Bun.spawn([...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, stdout: "", stderr: message };
  }
}
