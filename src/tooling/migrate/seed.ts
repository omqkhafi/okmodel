/**
 * `okm seed <file>` (spec §20, D199).
 *
 * The file's default export receives the testing harness for the selected
 * target. Protection is `assertTargetPolicy`, the same gate as every other
 * command. The target is already migrated: this command does not apply DDL.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  const path = join(cwd, file);
  if (!existsSync(path)) {
    throw new OkmError("invalid", `Seed file ${file} was not found.`, {
      fix: { summary: "Pass okm seed <file> a module in this project." },
    });
  }
  assertDirectConnection(target.url, flags.allowPooler || config.allowPooler === true);
  const schema = await loadSchema(cwd, config.schema);
  const pool = open({ url: target.url, max: 1 });
  const harness = await testing(schema, { driver: pool, migrate: false });
  try {
    const imported: unknown = await import(`${pathToFileURL(path).href}?okm=${Date.now()}`);
    const seed = isRecord(imported) ? imported.default : undefined;
    if (typeof seed !== "function") {
      throw new OkmError("invalid", `${file} must default-export a function.`, {
        fix: { summary: "export default async function seed(t) { ... }." },
      });
    }
    await seed(harness);
    return formatCreated(target.name, createdOf(harness));
  } finally {
    await harness.close();
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
