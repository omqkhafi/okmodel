/**
 * Temp project + CLI helpers for the migration lifecycle property.
 *
 * Lives in the harness so the property test stays thin. Does not change
 * product code.
 */

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../../../src/contracts/error.js";

/** Result of one in-process `okm` invocation. */
export type LifecycleCliResult = {
  readonly stdout: string;
  readonly code?: string;
  readonly message?: string;
  readonly kind?: OkmError["kind"];
};

/** Where the temp project directory is created. */
export type LifecyclePlace = "plain" | "symlink" | "spaces";

/** A disposable project directory for generate / apply / push / check. */
export type LifecycleProject = {
  readonly cwd: string;
  writeSchema(source: string): void;
  writeConfig(url: string, namespace?: string, replica?: string): void;
  cli(argv: readonly string[]): Promise<string>;
  generateAllowing(): Promise<string>;
  close(): void;
};

/**
 * Creates an empty temp project rooted under `os.tmpdir()`.
 *
 * @param root - Repository root (absolute imports in generated files)
 * @param label - mkdtemp prefix fragment
 * @param place - Plain directory, a symlink to it, or a path that contains a space
 * @returns Project handle
 */
export function openLifecycleProject(
  root: string,
  label = "lifecycle",
  place: LifecyclePlace = "plain",
): LifecycleProject {
  const parent = place === "spaces" ? mkdtempSync(join(tmpdir(), "okm lifecycle ")) : tmpdir();
  const real = mkdtempSync(join(parent, `okm-${label}-`));
  const link = place === "symlink" ? `${real}-link` : undefined;
  if (link !== undefined) symlinkSync(real, link);
  const cwd = link ?? real;
  const source = (path: string): string => JSON.stringify(join(root, path));
  return {
    cwd,
    writeSchema(text: string): void {
      writeFileSync(join(cwd, "schema.ts"), text.endsWith("\n") ? text : `${text}\n`);
    },
    writeConfig(url: string, namespace?: string, replica?: string): void {
      const target =
        replica === undefined
          ? [`  database: ${JSON.stringify(url)},`]
          : [
              "  targets: {",
              `    primary: ${JSON.stringify(url)},`,
              `    replica: ${JSON.stringify(replica)},`,
              "  },",
            ];
      writeFileSync(
        join(cwd, "okmodel.config.ts"),
        [
          `import { defineConfig } from ${source("src/tooling/migrate/index.ts")};`,
          "export default defineConfig({",
          '  schema: "./schema.ts",',
          '  migrations: "./migrations",',
          ...target,
          ...(namespace === undefined ? [] : [`  namespace: ${JSON.stringify(namespace)},`]),
          "});",
          "",
        ].join("\n"),
      );
    },
    async cli(argv: readonly string[]): Promise<string> {
      const result = await invokeLifecycleCli(root, cwd, argv);
      if (result.code !== undefined) {
        throw new OkmError(
          result.code,
          result.message ?? "",
          result.kind === undefined ? undefined : { kind: result.kind },
        );
      }
      return result.stdout;
    },
    async generateAllowing(): Promise<string> {
      try {
        return await this.cli(["generate"]);
      } catch (error) {
        if (OkmError.from(error).code !== "OKM1510") throw error;
      }
      const dir = join(cwd, "migrations");
      const name = readdirSync(dir)
        .filter((file) => file.endsWith(".sql"))
        .sort()
        .at(-1);
      if (name === undefined) throw new Error("generate wrote no migration");
      const text = readFileSync(join(dir, name), "utf8");
      writeFileSync(join(dir, name), allowLifecycleMigration(text));
      return name;
    },
    close(): void {
      if (link !== undefined) rmSync(link, { force: true });
      if (place === "spaces") rmSync(parent, { recursive: true, force: true });
      else rmSync(real, { recursive: true, force: true });
    },
  };
}

const KIND_ALLOW: Readonly<Record<string, string>> = {
  "drop-column": "OKM1512",
  "rename-table": "OKM1523",
  "drop-table": "OKM1511",
  "drop-enum": "OKM1513",
  "drop-domain": "OKM1514",
  "drop-view": "OKM1516",
  "drop-function": "OKM1515",
  "drop-matview": "OKM1518",
  "rename-column": "OKM1519",
};

/**
 * Writes the `-- okm-allow` line the linter requires for one destructive step.
 *
 * The code follows the step kind. A domain drop is OKM1514 and an enum drop
 * is OKM1513. Stamping OKM1511 on those statements does not match.
 * Validating a new foreign key is OKM1532.
 *
 * @param text - Migration file from `okm generate`
 * @returns The same file with allow lines inserted
 */
export function allowLifecycleMigration(text: string): string {
  return text.replace(
    /(-- kind: ([a-z0-9-]+)(?:\n-- [^\n]*)*\n)((?:alter|drop)[^\n]*)/g,
    (full, header: string, kind: string, sql: string) => {
      const code = allowCode(kind, sql);
      if (code === undefined || header.includes("-- okm-allow")) return full;
      return `${header}-- okm-allow ${code}: ${allowReason(code)}\n${sql}`;
    },
  );
}

function allowCode(kind: string, sql: string): string | undefined {
  if (kind === "validate-constraint" && sql.includes("_fkey")) return "OKM1532";
  return KIND_ALLOW[kind];
}

function allowReason(code: string): string {
  switch (code) {
    case "OKM1512":
      return "the column is unused";
    case "OKM1523":
      return "no reader uses the old name";
    case "OKM1532":
      return "the table is empty";
    default:
      return "the object is unused";
  }
}

/**
 * Runs `okm` argv against a project via `bun -e` and the migrate command entry.
 *
 * @param root - Repository root
 * @param cwd - Project directory
 * @param argv - CLI arguments after `okm`
 * @returns Captured stdout / error envelope
 */
export async function invokeLifecycleCli(
  root: string,
  cwd: string,
  argv: readonly string[],
): Promise<LifecycleCliResult> {
  const script = [
    `import { OkmError } from ${JSON.stringify(join(root, "src/contracts/error.ts"))};`,
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    "try {",
    `  await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "  process.stdout.write(JSON.stringify({ stdout: lines.join('') }));",
    "} catch (error) {",
    "  const mapped = OkmError.from(error);",
    "  process.stdout.write(JSON.stringify({ stdout: lines.join(''), code: mapped.code, message: mapped.message, kind: mapped.kind }));",
    "  process.exit(1);",
    "}",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (stdout.startsWith("{")) return JSON.parse(stdout) as LifecycleCliResult;
  throw new Error(stderr.length > 0 ? stderr : `okm exited ${String(code)} with ${stdout}`);
}
