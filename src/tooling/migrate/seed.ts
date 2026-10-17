/**
 * `okm seed <file>` (spec §20, D199).
 *
 * The file's default export receives the testing harness for the selected
 * target. Protection is `assertTargetPolicy`, the same gate as every other
 * command. The target is already migrated: this command does not apply DDL.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { projectPath } from "./paths.js";

import { OkmError } from "../../contracts/error.js";
import { open } from "../../adapters/pg/postgresjs.js";
import { createdOf } from "../testing/factories.js";
import { testing } from "../testing/index.js";
import {
  assertDirectConnection,
  assertTargetPolicy,
  selectTarget,
  type InvokeFlags,
} from "./policy.js";
import { probeStableBackend } from "./pooler-probe.js";
import { driverUrl } from "./driver-url.js";
import { finishQuiet, sessionFailure } from "./lost.js";
import { loadConfig, loadSchema } from "./project.js";

/**
 * Runs a seed file against the selected target.
 *
 * Policy and target selection run before the pool opens, so a protected
 * target is refused without a connection.
 *
 * @param cwd - Project directory
 * @param file - Seed module, relative to `cwd`
 * @param flags - `--target`, `--allow-protected`, and `--allow-pooler`
 * @returns Text for stdout
 */
export async function seedProject(cwd: string, file: string, flags: InvokeFlags): Promise<string> {
  const config = await loadConfig(cwd);
  const target = selectTarget(config, flags.target);
  assertTargetPolicy(target, "seed", flags.allowProtected);
  const path = projectPath(cwd, file);
  if (!existsSync(path)) {
    throw new OkmError("invalid", `Seed file ${file} was not found.`, {
      fix: { summary: "Pass okm seed <file> a module in this project." },
    });
  }
  const allowPooler = flags.allowPooler || config.allowPooler === true;
  assertDirectConnection(target.url, allowPooler);
  const schema = await loadSchema(cwd, config.schema);
  const pool = open({ url: driverUrl(target.url), max: 1 });
  let harness: Awaited<ReturnType<typeof testing>> | undefined;
  try {
    const held = await pool.reserve?.();
    if (held !== undefined) {
      try {
        await probeStableBackend(
          target.url,
          async () => {
            const result = await held.execute("select pg_backend_pid()::text");
            const cell = result.rows[0]?.[0];
            return cell === null || cell === undefined ? "" : String(cell);
          },
          allowPooler,
        );
      } finally {
        await finishQuiet(() => held.release());
      }
    }
    harness = await testing(schema, { driver: pool, migrate: false });
    const imported: unknown = await import(`${pathToFileURL(path).href}?okm=${Date.now()}`);
    const seed = isRecord(imported) ? imported.default : undefined;
    if (typeof seed !== "function") {
      throw new OkmError("invalid", `${file} must default-export a function.`, {
        fix: { summary: "export default async function seed(t) { ... }." },
      });
    }
    await seed(harness);
    return formatCreated(target.name, createdOf(harness));
  } catch (error) {
    throw sessionFailure(error) ?? error;
  } finally {
    const opened = harness;
    if (opened !== undefined) await finishQuiet(() => opened.close());
    else await finishQuiet(() => pool.close());
  }
}

function formatCreated(
  target: string,
  counts: readonly { readonly table: string; readonly count: number }[],
): string {
  const lines = [`target ${target}`];
  if (counts.length === 0) lines.push("created nothing");
  else {
    for (const item of counts) lines.push(`${item.table} ${String(item.count)}`);
  }
  return `${lines.join("\n")}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
