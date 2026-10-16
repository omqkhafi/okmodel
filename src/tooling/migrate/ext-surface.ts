/**
 * Catalog reads shared by `okm ext scaffold` and `okm ext test`.
 *
 * Both are read-only. The queries are `pg_depend`, `pg_type`, `pg_proc`,
 * `pg_operator`, and `pg_settings`. Nothing is created.
 */

import { OkmError } from "../../contracts/error.js";
import { compareExtensionVersions, isExactVersion } from "../../contracts/catalog/extension.js";
import type { DriverPool, WireValue } from "../../contracts/driver.js";
import type {
  Extension,
  ExtensionFunction,
  ExtensionIndexMethod,
  ExtensionOperator,
  ExtensionProvides,
  ExtensionRequires,
  ExtensionType,
} from "../../dialects/pg/ext/index.js";

/** One extension as the connected server describes it. */
export type ServerSurface = {
  readonly name: string;
  readonly version: string;
  readonly schema: string;
  readonly relocatable: boolean;
  readonly serverMajor: number;
  readonly types: readonly ExtensionType[];
  readonly operators: readonly ExtensionOperator[];
  readonly functions: readonly ExtensionFunction[];
  readonly indexMethods: readonly ExtensionIndexMethod[];
  readonly settings: readonly string[];
};

const INSTALLED = `
  select e.extversion, n.nspname, e.extrelocatable::text, current_setting('server_version_num')
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = $1
`;

const TYPES = `
  select t.typname
  from pg_depend d
  join pg_extension e on e.oid = d.refobjid
  join pg_type t on t.oid = d.objid
  where e.extname = $1
    and d.deptype = 'e'
    and d.classid = 'pg_type'::regclass
    and t.typtype in ('b', 'e', 'd')
  order by t.typname
`;

const FUNCTIONS = `
  select p.proname,
         pg_get_function_identity_arguments(p.oid),
         pg_get_function_result(p.oid)
  from pg_depend d
  join pg_extension e on e.oid = d.refobjid
  join pg_proc p on p.oid = d.objid
  where e.extname = $1
    and d.deptype = 'e'
    and d.classid = 'pg_proc'::regclass
  order by p.proname, pg_get_function_identity_arguments(p.oid)
`;

const OPERATORS = `
  select o.oprname,
         coalesce(l.typname, ''),
         coalesce(r.typname, ''),
         res.typname
  from pg_depend d
  join pg_extension e on e.oid = d.refobjid
  join pg_operator o on o.oid = d.objid
  left join pg_type l on l.oid = o.oprleft
  left join pg_type r on r.oid = o.oprright
  join pg_type res on res.oid = o.oprresult
  where e.extname = $1
    and d.deptype = 'e'
    and d.classid = 'pg_operator'::regclass
  order by o.oprname, l.typname, r.typname
`;

const OPCLASSES = `
  select am.amname, oc.opcname
  from pg_depend d
  join pg_extension e on e.oid = d.refobjid
  join pg_opclass oc on oc.oid = d.objid
  join pg_am am on am.oid = oc.opcmethod
  where e.extname = $1
    and d.deptype = 'e'
    and d.classid = 'pg_opclass'::regclass
  order by am.amname, oc.opcname
`;

const SETTINGS = `
  select name from pg_settings where name like $1 order by name
`;

/**
 * Reads one installed extension.
 *
 * A name that is not installed is OKM1811. The connection is not asked to
 * create it.
 *
 * @param pool - Connected server
 * @param name - Extension name
 * @returns The catalog surface
 */
export async function readSurface(pool: DriverPool, name: string): Promise<ServerSurface> {
  const installed = await pool.execute(INSTALLED, [name]);
  const row = installed.rows[0];
  if (row === undefined) {
    throw new OkmError("OKM1811", `Extension ${name} is not installed on the server.`, {
      fix: { summary: "Install the extension, then run okm ext scaffold again." },
    });
  }
  const version = text(row[0]);
  const schema = text(row[1]);
  const relocatable = row[2] === "t" || row[2] === "true";
  const serverMajor = majorOf(text(row[3]));
  const [types, functions, operators, methods, settings] = await Promise.all([
    pool.execute(TYPES, [name]),
    pool.execute(FUNCTIONS, [name]),
    pool.execute(OPERATORS, [name]),
    pool.execute(OPCLASSES, [name]),
    pool.execute(SETTINGS, [`${name}.%`]),
  ]);
  return {
    name,
    version,
    schema,
    relocatable,
    serverMajor,
    types: types.rows.map((item) => ({ name: text(item[0]) })),
    functions: functions.rows.flatMap((item) => callable(item)),
    operators: operators.rows.flatMap((item) => visibleOperator(item)),
    indexMethods: methods.rows.map((item) => ({
      name: text(item[0]),
      opclass: text(item[1]),
    })),
    settings: settings.rows.map((item) => text(item[0])),
  };
}

/**
 * Prints a starting `extension()` definition.
 *
 * The developer owns the file. `requires` and `provides` are the fields
 * `okm ext test` reads. Settings are a comment, because they are not part
 * of the definition.
 *
 * @param surface - Catalog read
 * @returns TypeScript source, including the trailing newline
 */
export function renderScaffold(surface: ServerSurface): string {
  const exportName = `${camel(surface.name)}Ext`;
  const settings = surface.settings.length === 0 ? "none" : surface.settings.join(", ");
  const body = {
    schema: surface.schema,
    relocatable: surface.relocatable,
    requires: {
      postgres: ">=15",
      version: `>=${surface.version}`,
    },
    provides: {
      types: surface.types,
      operators: surface.operators,
      functions: surface.functions,
      indexMethods: surface.indexMethods,
    },
  };
  return [
    'import { extension } from "okmodel/ext";',
    "",
    "/**",
    ` * Starting definition for ${surface.name} ${surface.version} in schema ${surface.schema}.`,
    " * Edit this file. okm ext test checks it against the connected server.",
    ` * Settings: ${settings}.`,
    " */",
    `export const ${exportName} = extension(${JSON.stringify(surface.name)}, ${JSON.stringify(body, null, 2)});`,
    "",
  ].join("\n");
}

/**
 * Lists mismatches between a definition and the server.
 *
 * An empty list means the definition matches. Version failures and signature
 * failures are both lines in that list.
 *
 * @param declared - The loaded `extension()` value
 * @param server - The catalog read for `declared.name`
 * @returns Mismatch lines, stable order
 */
export function surfaceMismatches(declared: Extension, server: ServerSurface): readonly string[] {
  const lines: string[] = [];
  lines.push(...versionMismatches(declared, server));
  const provides = declared.provides;
  if (provides === undefined) return lines;
  for (const type of provides.types ?? []) {
    if (!server.types.some((item) => item.name === type.name)) {
      lines.push(`type ${type.name} is not in ${declared.name}`);
    }
  }
  for (const operator of provides.operators ?? []) {
    if (!operatorMatches(operator, server.operators)) {
      lines.push(operatorLine(operator));
    }
  }
  for (const fn of provides.functions ?? []) {
    if (!functionMatches(fn, server.functions)) {
      lines.push(`function ${fn.name}(${fn.args.join(", ")}) -> ${fn.returns}`);
    }
  }
  for (const method of provides.indexMethods ?? []) {
    if (!methodMatches(method, server.indexMethods)) {
      const opclass = method.opclass === undefined ? "" : ` ${method.opclass}`;
      lines.push(`index method ${method.name}${opclass}`);
    }
  }
  return lines;
}

/**
 * Throws when {@link surfaceMismatches} found any line.
 *
 * Version lines are OKM1812. A signature line is `invalid`. Both are listed
 * in the message.
 *
 * @param name - Extension name
 * @param mismatches - Lines from {@link surfaceMismatches}
 */
export function refuseMismatches(name: string, mismatches: readonly string[]): void {
  if (mismatches.length === 0) return;
  const version = mismatches.some(
    (line) => line.startsWith("version ") || line.startsWith("postgres "),
  );
  const code = version ? "OKM1812" : "invalid";
  throw new OkmError(
    code,
    `Extension ${name} does not match the server.\n${mismatches.join("\n")}`,
    {
      fix: {
        summary:
          "Edit the definition so each signature matches the server, or install the version requires names.",
      },
    },
  );
}

function versionMismatches(declared: Extension, server: ServerSurface): readonly string[] {
  const lines: string[] = [];
  const requires: ExtensionRequires = {
    ...declared.requires,
    ...(declared.version !== undefined ? { version: declared.version } : {}),
  };
  const postgres = requires.postgres;
  if (postgres !== undefined && !majorAllows(postgres, server.serverMajor)) {
    lines.push(
      `postgres ${postgres} is not met. The server is PostgreSQL ${String(server.serverMajor)}. minPostgres: ${floorText(postgres)}.`,
    );
  }
  const version = requires.version;
  if (version !== undefined && !versionAllows(version, server.version)) {
    lines.push(`version ${version} is not met. The server has ${server.version}.`);
  }
  return lines;
}

function majorAllows(declared: string, server: number): boolean {
  const floor = /^>=(\d+)$/.exec(declared);
  const exact = floor?.[1] ?? (/^\d+$/.test(declared) ? declared : undefined);
  if (exact === undefined) return false;
  return server >= Number(exact);
}

function versionAllows(declared: string, installed: string): boolean {
  const floor = /^>=(\d+(?:\.\d+)*)$/.exec(declared);
  const pinned = floor?.[1] ?? declared;
  if (!isExactVersion(pinned) || !isExactVersion(installed)) return declared === installed;
  return compareExtensionVersions(installed, pinned) >= 0;
}

function floorText(declared: string): string {
  return declared.startsWith(">=") ? declared.slice(2) : declared;
}

function operatorMatches(
  declared: ExtensionOperator,
  server: readonly ExtensionOperator[],
): boolean {
  return server.some(
    (item) =>
      item.name === declared.name &&
      (declared.left === undefined || item.left === declared.left) &&
      (declared.right === undefined || item.right === declared.right) &&
      item.result === declared.result,
  );
}

function functionMatches(
  declared: ExtensionFunction,
  server: readonly ExtensionFunction[],
): boolean {
  const args = declared.args.join(", ");
  return server.some(
    (item) =>
      item.name === declared.name &&
      item.args.join(", ") === args &&
      item.returns === declared.returns,
  );
}

function methodMatches(
  declared: ExtensionIndexMethod,
  server: readonly ExtensionIndexMethod[],
): boolean {
  return server.some(
    (item) =>
      item.name === declared.name &&
      (declared.opclass === undefined || item.opclass === declared.opclass),
  );
}

function operatorLine(operator: ExtensionOperator): string {
  const left = operator.left ?? "";
  const right = operator.right ?? "";
  return `operator ${left} ${operator.name} ${right} -> ${operator.result}`
    .replaceAll(/\s+/g, " ")
    .trim();
}

function callable(row: readonly WireValue[]): ExtensionFunction[] {
  const args = text(row[1]);
  const returns = text(row[2]);
  if (args.includes("internal") || returns.includes("internal")) return [];
  return [
    {
      name: text(row[0]),
      args: args.length === 0 ? [] : args.split(", ").filter((part) => part.length > 0),
      returns,
    },
  ];
}

function visibleOperator(row: readonly WireValue[]): ExtensionOperator[] {
  const left = text(row[1]);
  const right = text(row[2]);
  const result = text(row[3]);
  if ([left, right, result].some((part) => part === "internal")) return [];
  return [
    {
      name: text(row[0]),
      ...(left.length > 0 ? { left } : {}),
      ...(right.length > 0 ? { right } : {}),
      result,
    },
  ];
}

function text(value: WireValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function majorOf(versionNum: string): number {
  const parsed = Number(versionNum);
  if (!Number.isFinite(parsed)) return 0;
  return Math.floor(parsed / 10000);
}

function camel(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 0);
  const [first, ...rest] = parts;
  if (first === undefined) return "extension";
  return (
    first.toLowerCase() +
    rest.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase()).join("")
  );
}

/**
 * Reports whether a value is an `extension()` result.
 *
 * @param value - A module export
 * @returns `true` when it has a name and `contribute`
 */
export function isExtension(value: unknown): value is Extension {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || !("contribute" in value) || !("schema" in value)) return false;
  return typeof value.name === "string" && typeof value.contribute === "function";
}

/**
 * Reads `extension()` values exported by a loaded module.
 *
 * @param imported - Module namespace
 * @returns The definitions, in export order
 */
export function extensionsFromModule(imported: unknown): readonly Extension[] {
  if (typeof imported !== "object" || imported === null) return [];
  const found: Extension[] = [];
  for (const value of Object.values(imported)) {
    if (isExtension(value)) found.push(value);
  }
  return found;
}

/** Provides kept on the type so a scaffold round-trip can name them. */
export type { ExtensionProvides };
