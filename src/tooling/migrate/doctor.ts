/**
 * `okm doctor`.
 *
 * A code prints the registry entry. With no code, the project is loaded and
 * each table's triggers are listed. When `roles` is set, the command also
 * connects and checks that those roles exist, that a managed role can be
 * created, and that the application role can reach each managed object.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import { OkmError } from "../../contracts/error.js";
import type { CatalogObject } from "../../contracts/catalog/types.js";
import { assertRoleHealth } from "../../dialects/pg/role/check.js";
import { errorDoc } from "../errors/registry.js";
import { selectTarget, type InvokeFlags } from "./policy.js";
import { openProject } from "./project.js";

/**
 * Explains one code, or lists the triggers on each table.
 *
 * @param cwd - Project directory
 * @param code - Spec code, when the caller passed one
 * @returns Text for stdout, including the trailing newline
 */
export async function doctorProject(
  cwd: string,
  code: string | undefined,
  flags?: InvokeFlags,
): Promise<string> {
  if (code !== undefined) {
    const doc = errorDoc(code);
    if (doc === undefined) {
      throw new OkmError("invalid", `Unknown code ${code}.`, {
        fix: { summary: "Pass a code from the registry, or run okm doctor with no argument." },
      });
    }
    return `${doc.code}: ${doc.title}\n${doc.summary}\n${doc.fix}\n`;
  }
  const opened = await openProject(cwd);
  if (opened.config.roles !== undefined) {
    const target = selectTarget(opened.config, flags?.target);
    const pool = open({ url: target.url, max: 1 });
    try {
      await assertRoleHealth(pool, opened.config.roles, opened.built.catalog.objects);
    } finally {
      await pool.close();
    }
  }
  return formatTriggers(opened.built.catalog.objects);
}

/**
 * One line per table that has a trigger.
 *
 * @param objects - Catalog objects
 * @returns The listing, or `no triggers` when none are present
 */
export function formatTriggers(objects: readonly CatalogObject[]): string {
  const tables = new Map<string, string[]>();
  for (const object of objects) {
    if (object.kind !== "trigger") continue;
    const table = object.identity.parent.name;
    const names = tables.get(table) ?? [];
    names.push(object.identity.name);
    tables.set(table, names);
  }
  if (tables.size === 0) return "no triggers\n";
  const lines = [...tables.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([table, names]) => `${table}: ${[...names].sort().join(", ")}`);
  return `${lines.join("\n")}\n`;
}
