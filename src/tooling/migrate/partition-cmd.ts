/**
 * `okm partitions` and `okm partitions maintain`.
 *
 * Loaded from the command router only. A featureless `okm` invocation does not.
 */

import { OkmError } from "../../contracts/error.js";
import type { TableObject } from "../../contracts/catalog/types.js";
import type { ParsedCli } from "../cli/parse.js";
import { DEFAULT_LOCK_MS } from "./apply.js";
import { DEFAULT_LOCK_WAIT_MS } from "./lock-wait.js";
import { loadConfig, loadSchema } from "./project.js";
import { assertTargetPolicy, selectTarget } from "./policy.js";
import type { ProjectContext } from "./paths.js";
import { describePartitions, maintainPartitions } from "./partition-maintain.js";

/**
 * Runs the partitions command.
 *
 * @param id - `partitions` or `partitions maintain`
 * @param project - Project directory and config
 * @param parsed - Parsed invocation
 * @param cwd - Working directory
 * @param human - Writes the text line
 * @returns The envelope payload
 */
export async function partitionsCommand(
  id: string,
  project: ProjectContext,
  parsed: ParsedCli,
  cwd: string,
  human: (text: string) => void,
): Promise<{
  readonly text: string;
  readonly data: unknown;
  readonly warnings: readonly never[];
  readonly outFile: null;
}> {
  const config = await loadConfig(project);
  const target = selectTarget(config, parsed.target);
  assertTargetPolicy(
    target,
    id === "partitions maintain" ? "contract" : "status",
    parsed.allowProtected,
  );
  const name = parsed.operands[0] ?? "";
  const schema = await loadSchema(cwd, config.schema);
  const table = findTable(schema.catalog.objects, name);
  if (table === undefined) {
    throw new OkmError("OKM1932", `Table ${name} is not declared.`, {
      fix: { summary: "Pass the table name from schema()." },
    });
  }
  const namespace = config.namespace ?? "public";
  if (id === "partitions maintain") {
    const result = await maintainPartitions({
      url: target.url,
      schema: namespace,
      catalog: schema.catalog,
      table,
      dryRun: parsed.dryRun,
      allowProtected: parsed.allowProtected,
      lockTimeoutMs: parsed.lockTimeoutMs ?? DEFAULT_LOCK_MS,
      lockWaitMs: parsed.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    });
    const data = {
      table: table.identity.name,
      dryRun: parsed.dryRun,
      statements: result.statements,
    };
    const text = `${result.statements.join(";\n")}${result.statements.length > 0 ? ";\n" : "nothing to do\n"}`;
    human(text);
    return { text, data, warnings: [], outFile: null };
  }
  const report = await describePartitions(target.url, namespace, table);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  human(text);
  return { text, data: report, warnings: [], outFile: null };
}

function findTable(objects: readonly unknown[], name: string): TableObject | undefined {
  for (const object of objects) {
    if (typeof object !== "object" || object === null) continue;
    const record = object as TableObject;
    if (record.kind !== "table") continue;
    if (record.identity.name === name || record.provenance.name === name) return record;
  }
  return undefined;
}
