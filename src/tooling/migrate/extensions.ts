/**
 * Extension alters and the apply preflight.
 *
 * Create and drop SQL come from the dialect. An upgrade is `ALTER EXTENSION
 * … UPDATE`, marked `path-unverified` until apply checks
 * `pg_extension_update_paths`. A move is `SET SCHEMA` and only when the
 * declaration is relocatable.
 */

import { OkmError } from "../../contracts/error.js";
import {
  compareExtensionVersions,
  isExactVersion,
  sameExtensionDefinition,
} from "../../contracts/catalog/extension.js";
import { identityKey } from "../../contracts/catalog/identity.js";
import type { CatalogObject, ExtensionObject } from "../../contracts/catalog/types.js";
import type { DriverConnection } from "../../contracts/driver.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { quoteLiteral } from "../../dialects/pg/quote.js";

/** One extension alter. The planner stores it as a plan step. */
export type ExtensionStep = {
  readonly sql: string;
  readonly class: "expand" | "contract";
  readonly action: "ddl";
  readonly lock: string;
  readonly transactional: boolean;
  readonly path?: "unverified";
};

/** Migrations the preflight reads. Only the statement text is used. */
type MigrationSql = {
  readonly steps: readonly { readonly sql: string }[];
};

const CREATE_EXTENSION = /^\s*create\s+extension\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))/i;
const UPDATE_EXTENSION =
  /^\s*alter\s+extension\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))\s+update\s+to\s+'([^']*)'/i;

/**
 * Upgrade and move steps for extensions whose definition changed.
 *
 * Exact downgrades and moves of a non-relocatable extension are OKM1814.
 * Dropping an extension that an object in the next catalog still uses is
 * OKM1814. `DROP` is never `CASCADE`.
 *
 * @param beforeBy - Previous objects, keyed by identity
 * @param afterBy - Next objects, keyed by identity
 * @param dropKeys - Identities the plan drops
 * @returns Alter steps. Creates and drops stay in the main planner
 */
export function extensionAlterSteps(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  dropKeys: ReadonlySet<string>,
): ExtensionStep[] {
  refuseDrops(beforeBy, afterBy, dropKeys);
  const steps: ExtensionStep[] = [];
  for (const after of afterBy.values()) {
    if (after.kind !== "extension") continue;
    const before = beforeBy.get(identityKey(after.identity));
    if (before === undefined || before.kind !== "extension") continue;
    if (sameExtensionDefinition(before, after)) continue;
    steps.push(...alterExtension(before, after));
  }
  return steps;
}

/**
 * Refuses a migration that names an extension the server cannot install,
 * or an upgrade with no path.
 *
 * The server is asked only when a step creates or upgrades an extension.
 * The check runs before any statement.
 *
 * @param connection - The reserved apply connection
 * @param migrations - Migrations in apply order
 * @throws OkmError OKM1811 when the extension is not available, OKM1814 when the update path is missing
 */
export async function assertExtensionsAvailable(
  connection: DriverConnection,
  migrations: readonly MigrationSql[],
): Promise<void> {
  const creates = new Set<string>();
  const updates: { readonly name: string; readonly version: string }[] = [];
  for (const migration of migrations) {
    for (const step of migration.steps) {
      const created = CREATE_EXTENSION.exec(step.sql);
      const name = created?.[1] ?? created?.[2];
      if (name !== undefined) creates.add(name.replaceAll('""', '"'));
      const updated = UPDATE_EXTENSION.exec(step.sql);
      const updateName = updated?.[1] ?? updated?.[2];
      const version = updated?.[3];
      if (updateName !== undefined && version !== undefined) {
        updates.push({ name: updateName.replaceAll('""', '"'), version });
      }
    }
  }
  if (creates.size === 0 && updates.length === 0) return;
  const names = [...creates, ...updates.map((item) => item.name)];
  const available = await availableExtensions(connection, names);
  for (const name of creates) {
    if (!available.has(name)) {
      throw new OkmError(
        "OKM1811",
        `Extension ${name} is not available on the server. Nothing was changed.`,
        { fix: { summary: "Install the extension, or remove the declaration." } },
      );
    }
  }
  for (const update of updates) {
    if (!available.has(update.name)) {
      throw new OkmError(
        "OKM1811",
        `Extension ${update.name} is not available on the server. Nothing was changed.`,
        { fix: { summary: "Install the extension, or remove the declaration." } },
      );
    }
    const installed = await installedVersion(connection, update.name);
    if (installed === undefined) {
      throw new OkmError(
        "OKM1811",
        `Extension ${update.name} is not installed, so it cannot be updated. Nothing was changed.`,
        { fix: { summary: "Create the extension before updating it." } },
      );
    }
    const path = await updatePath(connection, update.name, installed, update.version);
    if (!path) {
      throw new OkmError(
        "OKM1814",
        `Extension ${update.name} has no update path from ${installed} to ${update.version}. Nothing was changed.`,
        {
          fix: {
            summary:
              "Drop or move the dependents first. Postgres cannot lower an extension version.",
          },
        },
      );
    }
  }
}

function refuseDrops(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  dropKeys: ReadonlySet<string>,
): void {
  for (const key of dropKeys) {
    const object = beforeBy.get(key);
    if (object?.kind !== "extension") continue;
    for (const after of afterBy.values()) {
      const used = after.dependencies.some(
        (edge) => edge.target.kind === "extension" && edge.target.name === object.identity.name,
      );
      if (!used) continue;
      throw new OkmError(
        "OKM1814",
        `Extension ${object.identity.name} still has dependents. Nothing was dropped.`,
        {
          fix: {
            summary:
              "Drop or move the dependents first. Postgres cannot lower an extension version.",
          },
        },
      );
    }
  }
}

function alterExtension(before: ExtensionObject, after: ExtensionObject): ExtensionStep[] {
  const steps: ExtensionStep[] = [];
  const name = quoteIdent(after.identity.name);
  if (before.definition.schema !== after.definition.schema) {
    if (!after.definition.relocatable) {
      throw new OkmError(
        "OKM1814",
        `Extension ${after.identity.name} is not relocatable, so it cannot move to ${after.definition.schema}.`,
        {
          fix: {
            summary:
              "Drop or move the dependents first. Postgres cannot lower an extension version.",
          },
        },
      );
    }
    steps.push({
      sql: `alter extension ${name} set schema ${quoteIdent(after.definition.schema)}`,
      class: "contract",
      action: "ddl",
      lock: "ACCESS EXCLUSIVE",
      transactional: true,
    });
  }
  const previous = before.definition.version;
  const next = after.definition.version;
  if (!isExactVersion(previous) || !isExactVersion(next) || previous === next) return steps;
  if (compareExtensionVersions(next, previous) < 0) {
    throw new OkmError(
      "OKM1814",
      `Extension ${after.identity.name} cannot move from ${previous} to ${next}. Postgres cannot lower an extension version.`,
      {
        fix: {
          summary: "Drop or move the dependents first. Postgres cannot lower an extension version.",
        },
      },
    );
  }
  steps.push({
    sql: `alter extension ${name} update to ${quoteLiteral(next)}`,
    class: "expand",
    action: "ddl",
    lock: "ACCESS EXCLUSIVE",
    transactional: true,
    path: "unverified",
  });
  return steps;
}

async function availableExtensions(
  connection: DriverConnection,
  names: readonly string[],
): Promise<Set<string>> {
  const listed = await connection.execute(
    `select name from pg_available_extensions where name in (${names.map((_, index) => `$${String(index + 1)}`).join(", ")})`,
    names,
  );
  const found = new Set<string>();
  for (const row of listed.rows) {
    const name = row[0];
    if (typeof name === "string") found.add(name);
  }
  return found;
}

async function installedVersion(
  connection: DriverConnection,
  name: string,
): Promise<string | undefined> {
  const result = await connection.execute(
    "select extversion from pg_extension where extname = $1",
    [name],
  );
  const version = result.rows[0]?.[0];
  return typeof version === "string" ? version : undefined;
}

async function updatePath(
  connection: DriverConnection,
  name: string,
  source: string,
  target: string,
): Promise<boolean> {
  const result = await connection.execute(
    "select path from pg_extension_update_paths($1) where source = $2 and target = $3",
    [name, source, target],
  );
  const path = result.rows[0]?.[0];
  return typeof path === "string" && path.length > 0;
}
