/**
 * `okm ext list` and `okm ext check`.
 *
 * Both talk to the selected target. List prints every extension the server
 * can install, and the installed version when one is present. Check compares
 * the schema's declarations with what is installed.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import { OkmError } from "../../contracts/error.js";
import { compareExtensionVersions, isExactVersion } from "../../contracts/catalog/extension.js";
import type { DriverPool, WireValue } from "../../contracts/driver.js";
import type { CatalogObject, ExtensionObject } from "../../contracts/catalog/types.js";
import { assertTargetPolicy, selectTarget, type InvokeFlags } from "./policy.js";
import { openProject } from "./project.js";

/**
 * Runs `list` or `check` against the selected target.
 *
 * @param cwd - Project directory
 * @param command - `list` or `check`
 * @param flags - Target and protection flags
 * @returns Text for stdout, including the trailing newline
 */
export async function extProject(
  cwd: string,
  command: "list" | "check",
  flags: InvokeFlags,
): Promise<string> {
  const opened = await openProject(cwd);
  const target = selectTarget(opened.config, flags.target);
  assertTargetPolicy(target, "check", flags.allowProtected);
  const pool = open({ url: target.url, max: 1 });
  try {
    if (command === "list") return formatList(await readExtensions(pool));
    return formatCheck(opened.built.catalog.objects, await readExtensions(pool));
  } finally {
    await pool.close();
  }
}

type ServerExtension = {
  readonly name: string;
  readonly defaultVersion: string;
  readonly installedVersion: string;
  readonly schema: string;
};

const LIST_SQL = `
  select a.name, a.default_version, e.extversion, n.nspname
  from pg_available_extensions a
  left join pg_extension e on e.extname = a.name
  left join pg_namespace n on n.oid = e.extnamespace
  order by a.name
`;

async function readExtensions(pool: DriverPool): Promise<readonly ServerExtension[]> {
  const result = await pool.execute(LIST_SQL);
  return result.rows.map((row) => ({
    name: cell(row[0]),
    defaultVersion: cell(row[1]),
    installedVersion: cell(row[2]),
    schema: cell(row[3]),
  }));
}

function cell(value: WireValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function formatList(rows: readonly ServerExtension[]): string {
  const lines = ["name\tdefault\tinstalled\tschema"];
  for (const row of rows) {
    lines.push([row.name, row.defaultVersion, row.installedVersion, row.schema].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function formatCheck(
  objects: readonly CatalogObject[],
  server: readonly ServerExtension[],
): string {
  const declared = objects.filter(
    (object): object is ExtensionObject => object.kind === "extension",
  );
  if (declared.length === 0) return "no extensions\n";
  const installed = new Map(server.map((row) => [row.name, row.installedVersion]));
  const lines = ["name\tdeclared\tinstalled"];
  for (const object of [...declared].sort((left, right) =>
    left.identity.name < right.identity.name ? -1 : 1,
  )) {
    const name = object.identity.name;
    const have = installed.get(name) ?? "";
    if (have.length === 0) {
      throw new OkmError("OKM1811", `Extension ${name} is not installed on the server.`, {
        fix: { summary: "Install the extension, or remove the declaration." },
      });
    }
    const want = object.definition.version;
    if (!versionAccepted(want, have)) {
      throw new OkmError(
        "OKM1812",
        `Extension ${name} is ${have} on the server. The schema requires ${want ?? ""}.`,
        { fix: { summary: "Install a version the declaration accepts, or change the pin." } },
      );
    }
    lines.push([name, want ?? "-", have].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function versionAccepted(declared: string | undefined, installed: string): boolean {
  if (declared === undefined) return true;
  const floor = /^>=(\d+(?:\.\d+)*)$/.exec(declared);
  const minimum = floor?.[1];
  if (minimum !== undefined) {
    return isExactVersion(installed) && compareExtensionVersions(installed, minimum) >= 0;
  }
  return declared === installed;
}
