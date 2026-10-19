/**
 * `okm ext list`, `check`, `scaffold`, and `test`.
 *
 * All four talk to the selected target and are read-only, including on a
 * protected target. List prints every extension the server can install.
 * Check compares the schema's declarations with what is installed. Scaffold
 * prints a starting definition. Test checks that definition against the server.
 */

import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { open } from "../../adapters/pg/postgresjs.js";
import { OkmError } from "../../contracts/error.js";
import { compareExtensionVersions, isExactVersion } from "../../contracts/catalog/extension.js";
import type { DriverPool, WireValue } from "../../contracts/driver.js";
import type { CatalogObject, ExtensionObject } from "../../contracts/catalog/types.js";
import { assertTargetPolicy, selectTarget, type InvokeFlags } from "./policy.js";
import { driverUrl } from "./driver-url.js";
import { finishQuiet, sessionFailure } from "./lost.js";
import { asProject, type ProjectContext } from "./paths.js";
import { openProject } from "./project.js";
import {
  extensionsFromModule,
  readSurface,
  refuseMismatches,
  renderScaffold,
  surfaceMismatches,
} from "./ext-surface.js";

/**
 * Runs `list` or `check` against the selected target.
 *
 * @param cwd - Project directory
 * @param command - `list` or `check`
 * @param flags - Target and protection flags
 * @returns Text for stdout, including the trailing newline
 */
export async function extProject(
  project: string | ProjectContext,
  command: "list" | "check",
  flags: InvokeFlags,
): Promise<string> {
  const opened = await openProject(project);
  const target = selectTarget(opened.config, flags.target);
  assertTargetPolicy(target, "check", flags.allowProtected);
  const pool = open({ url: driverUrl(target.url), max: 1 });
  try {
    if (command === "list") return formatList(await readExtensions(pool));
    return formatCheck(opened.built.catalog.objects, await readExtensions(pool));
  } catch (error) {
    throw sessionFailure(error) ?? error;
  } finally {
    await finishQuiet(() => pool.close());
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
      throw new OkmError("OKM1812", extensionNeeds(name, want ?? "", have), {
        fix: { summary: "Install a version the declaration accepts, or change the pin." },
      });
    }
    // An omitted pin still names the extension. "-" read as "not declared".
    lines.push([name, want ?? name, have].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Refusal when the installed extension does not meet the pin.
 *
 * A `>=` pin says "or higher". An exact pin names that version.
 *
 * @param name - Extension name
 * @param want - Declared pin
 * @param have - Installed version
 * @returns OKM1812 message
 */
function extensionNeeds(name: string, want: string, have: string): string {
  const floor = /^>=(\d+(?:\.\d+)*)$/.exec(want);
  const need = floor?.[1] ?? want;
  const higher = floor === null ? "" : " or higher";
  return `Extension ${name} needs ${need}${higher}. The server has ${have}. Install a version the declaration accepts, or change the pin.`;
}

/**
 * Prints a starting definition for one installed extension.
 *
 * `--out` writes the file when that path does not exist. An existing file
 * is refused and nothing is written. Without `--out`, the text is returned
 * for stdout.
 *
 * @param cwd - Project directory
 * @param name - Extension name
 * @param flags - Target and protection flags
 * @param out - File to write, when the caller passed `--out`
 * @returns The definition, or a one-line wrote message
 */
export async function extScaffold(
  project: string | ProjectContext,
  name: string,
  flags: InvokeFlags,
  out?: string,
): Promise<string> {
  const { cwd } = asProject(project);
  if (out !== undefined) {
    const path = isAbsolute(out) ? out : join(cwd, out);
    if (existsSync(path)) {
      throw new OkmError(
        "invalid",
        `okm ext scaffold would overwrite ${path}. Nothing was written.`,
        { fix: { summary: "Pass a path that does not exist. The command never overwrites." } },
      );
    }
  }
  const text = await withServer(project, flags, async (pool) =>
    renderScaffold(await readSurface(pool, name)),
  );
  if (out === undefined) return text;
  const path = isAbsolute(out) ? out : join(cwd, out);
  writeFileSync(path, text);
  return `wrote ${path}\n`;
}

/**
 * Checks one definition file against the connected server.
 *
 * Every declared type, operator, function, and index method must exist with
 * the declared signature. `requires` must be met (OKM1812).
 *
 * @param cwd - Project directory
 * @param file - Definition file, relative to `cwd` or absolute
 * @param flags - Target and protection flags
 * @returns `ok <name>` for each definition
 */
export async function extTest(
  project: string | ProjectContext,
  file: string,
  flags: InvokeFlags,
): Promise<string> {
  const { cwd } = asProject(project);
  const path = isAbsolute(file) ? file : join(cwd, file);
  const imported: unknown = await import(pathToFileURL(path).href);
  const declared = extensionsFromModule(imported);
  if (declared.length === 0) {
    throw new OkmError("invalid", `okm ext test found no extension() in ${path}.`, {
      fix: { summary: "Export the value extension() returns." },
    });
  }
  return withServer(project, flags, async (pool) => {
    const lines: string[] = [];
    for (const extension of declared) {
      const server = await readSurface(pool, extension.name);
      refuseMismatches(extension.name, surfaceMismatches(extension, server));
      lines.push(`ok ${extension.name}`);
    }
    return `${lines.join("\n")}\n`;
  });
}

async function withServer(
  project: string | ProjectContext,
  flags: InvokeFlags,
  body: (pool: DriverPool) => Promise<string>,
): Promise<string> {
  const opened = await openProject(project);
  const target = selectTarget(opened.config, flags.target);
  assertTargetPolicy(target, "check", flags.allowProtected);
  const pool = open({ url: driverUrl(target.url), max: 1 });
  try {
    return await body(pool);
  } catch (error) {
    throw sessionFailure(error) ?? error;
  } finally {
    await finishQuiet(() => pool.close());
  }
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
