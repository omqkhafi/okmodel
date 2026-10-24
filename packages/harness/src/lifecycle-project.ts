/**
 * Temp project + CLI helpers for the migration lifecycle property.
 *
 * Lives in the harness so the property test stays thin. Does not change
 * product code.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** A disposable project directory for generate / apply / push / check. */
export type LifecycleProject = {
  readonly cwd: string;
  writeSchema(source: string): void;
  writeConfig(url: string, namespace?: string): void;
  cli(argv: readonly string[]): Promise<string>;
  generateAllowing(): Promise<string>;
  close(): void;
};

/**
 * Creates an empty temp project rooted under `os.tmpdir()`.
 *
 * @param root - Repository root (absolute imports in generated files)
 * @param label - mkdtemp prefix fragment
 * @returns Project handle
 */
export function openLifecycleProject(root: string, label = "lifecycle"): LifecycleProject {
  const cwd = mkdtempSync(join(tmpdir(), `okm-${label}-`));
  const source = (path: string): string => JSON.stringify(join(root, path));
  return {
    cwd,
    writeSchema(text: string): void {
      writeFileSync(join(cwd, "schema.ts"), text.endsWith("\n") ? text : `${text}\n`);
    },
    writeConfig(url: string, namespace?: string): void {
      writeFileSync(
        join(cwd, "okmodel.config.ts"),
        [
          `import { defineConfig } from ${source("src/tooling/migrate/index.ts")};`,
          "export default defineConfig({",
          '  schema: "./schema.ts",',
          '  migrations: "./migrations",',
          `  database: ${JSON.stringify(url)},`,
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
      writeFileSync(
        join(dir, name),
        text
          .replace(
            /^(alter table .* drop column .*)$/gm,
            "-- okm-allow OKM1512: the column is unused\n$1",
          )
          .replace(
            /^(alter table [^\n]* rename to .*)$/gm,
            "-- okm-allow OKM1523: no reader uses the old name\n$1",
          )
          .replace(/^(drop table .*)$/gm, "-- okm-allow OKM1511: the table is unused\n$1")
          .replace(
            /^(drop (?:type|domain|view|function|trigger) .*)$/gim,
            "-- okm-allow OKM1511: unused object\n$1",
          ),
      );
      return name;
    },
    close(): void {
      rmSync(cwd, { recursive: true, force: true });
    },
  };
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
