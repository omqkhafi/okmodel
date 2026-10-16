/**
 * `okm import drizzle` reads a Drizzle schema and writes table files.
 *
 * The schema is imported with the project's own `drizzle-orm`. That import
 * runs the file. okmodel does not depend on drizzle-orm. The catalog is
 * written by the same emitter as `okm pull`.
 */

import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { catalog } from "../../contracts/catalog/build.js";
import { enumType } from "../../contracts/catalog/enum.js";
import { staticNamespace } from "../../contracts/catalog/identity.js";
import { column, constraint, index, sequence, table } from "../../contracts/catalog/object.js";
import type {
  CatalogObject,
  Namespace,
  ObjectRef,
  Provenance,
  ReferentialAction,
} from "../../contracts/catalog/types.js";
import { referentialAction } from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";
import { quoteLiteral } from "../../dialects/pg/quote.js";
import { commitPullFiles, pullLayout } from "./pull.js";
import { emitPull, formatPullReport, type PullSkip } from "./pull-emit.js";
import { loadConfig } from "./project.js";

/** What `okm import drizzle` prints, and the objects the files leave out. */
export type ImportDrizzleResult = {
  /** Report text, including the trailing newline. */
  readonly text: string;
  /** Objects that were not written. */
  readonly skipped: readonly PullSkip[];
  /** Postgres schema the tables share. `schema()` still compiles `public`. */
  readonly namespace: string;
};

type Loaded = {
  readonly is: (value: unknown, type: object) => boolean;
  readonly PgTable: object;
  readonly PgView: object;
  readonly PgMaterializedView: object;
  readonly PgSequence: object;
  readonly Relations: object;
  readonly getTableConfig: (table: object) => TableConfig;
  readonly getTableColumns: (table: object) => Record<string, object>;
  readonly getViewConfig: (view: object) => { readonly name?: string };
};

type TableConfig = {
  readonly columns: readonly object[];
  readonly indexes: readonly DrizzleIndex[];
  readonly foreignKeys: readonly DrizzleForeignKey[];
  readonly checks: readonly DrizzleCheck[];
  readonly primaryKeys: readonly DrizzlePrimary[];
  readonly uniqueConstraints: readonly DrizzleUnique[];
  readonly name: string;
  readonly schema: string | undefined;
  readonly policies: readonly { readonly name?: string }[];
  readonly enableRLS: boolean;
};

type DrizzleIndex = {
  readonly config: {
    readonly name?: string;
    readonly columns: readonly object[];
    readonly unique: boolean;
    readonly concurrently?: boolean;
    readonly only: boolean;
    readonly where?: unknown;
    readonly with?: unknown;
    readonly method?: string;
  };
};

type DrizzleForeignKey = {
  readonly onUpdate: string | undefined;
  readonly onDelete: string | undefined;
  readonly reference: () => {
    readonly columns: readonly Named[];
    readonly foreignColumns: readonly Named[];
    readonly foreignTable: object;
  };
};

type DrizzleCheck = {
  readonly name: string;
  readonly value: unknown;
};

type DrizzlePrimary = {
  readonly columns: readonly Named[];
  readonly name?: string;
};

type DrizzleUnique = {
  readonly columns: readonly Named[];
  readonly name?: string;
  readonly nullsNotDistinct: boolean;
};

type Named = {
  readonly name: string;
};

type Found = {
  readonly tables: { readonly value: object; readonly exportName: string }[];
  readonly enums: readonly EnumNote[];
  readonly views: readonly string[];
  readonly relations: readonly string[];
  readonly sequences: readonly { readonly name: string; readonly schema: string }[];
};

type EnumNote = {
  readonly name: string;
  readonly labels: readonly string[];
};

const ENUM_SYMBOL = Symbol.for("drizzle:isPgEnum");

/**
 * Imports a Drizzle schema and writes one table file per table, plus the schema file.
 *
 * The path is a module in the project. `--out` is the directory that receives
 * `schema.ts` and `tables/`. Without it, an `okmodel.config.ts` in `cwd`
 * supplies the layout. A project that has no config yet writes `schema.ts`
 * and `tables/` in `cwd`.
 *
 * @param cwd - Project directory the files are written into
 * @param argv - Arguments after `import drizzle`
 * @returns The report and the Postgres schema name
 */
export async function importDrizzle(
  cwd: string,
  argv: readonly string[],
): Promise<ImportDrizzleResult> {
  const flags = parseImportArgs(argv);
  const file = readableFile(cwd, flags.path);
  const drizzle = await loadDrizzle(cwd);
  const imported = await loadSchemaModule(file);
  const found = collect(imported, drizzle);
  if (found.tables.length === 0) {
    throw new OkmError("invalid", `${file} exports no Drizzle tables.`, {
      fix: { summary: "Pass the module that exports pgTable or pgSchema tables." },
    });
  }
  const namespace = chooseNamespace(found.tables, drizzle);
  const extras: PullSkip[] = [];
  const objects = catalogOf(found, drizzle, namespace, extras);
  const built = catalog(objects);
  const layout = await layoutFor(cwd, flags.out);
  const emitted = emitPull(built, layout);
  const tables = emitted.files.filter((item) => item.path !== layout.schemaFile);
  if (tables.length === 0) {
    throw new OkmError("invalid", "The Drizzle schema has no table okmodel can write.", {
      fix: { summary: "See the not-imported list. table() has to be able to say the columns." },
    });
  }
  const skipped = [...emitted.skipped, ...extras].sort((left, right) =>
    compare(`${left.kind}\0${left.label}`, `${right.kind}\0${right.label}`),
  );
  commitPullFiles(emitted.files, "Import");
  const report = formatPullReport(
    { tables: tables.length, functions: 0, triggers: 0, views: 0, materializedViews: 0 },
    skipped,
    [],
    [],
    "imported",
  );
  return {
    text: `namespace ${namespace}\n${report}`,
    skipped,
    namespace,
  };
}

/**
 * Reads the schema path and `--out`.
 *
 * @param argv - Arguments after `import drizzle`
 * @returns The path and the optional output directory
 */
export function parseImportArgs(argv: readonly string[]): {
  readonly path: string;
  readonly out: string | undefined;
} {
  let path: string | undefined;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new OkmError("invalid", "--out needs a value.", {
          fix: { summary: "Pass --out <directory>." },
        });
      }
      out = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new OkmError("invalid", `Unknown flag ${arg}.`, {
        fix: { summary: "okm import drizzle accepts <path> and --out." },
      });
    }
    if (path !== undefined) {
      throw new OkmError("invalid", `Unexpected argument ${arg}.`, {
        fix: { summary: "Pass one schema path." },
      });
    }
    path = arg;
  }
  if (path === undefined || path.length === 0) {
    throw new OkmError("invalid", "okm import drizzle needs a path.", {
      fix: { summary: "Pass the Drizzle schema file." },
    });
  }
  return { path, out };
}

function readableFile(cwd: string, spec: string): string {
  const path = spec.startsWith("/") ? spec : join(cwd, spec);
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unreadable";
    throw new OkmError("invalid", `Cannot read ${path}. ${detail}`, {
      fix: { summary: "Pass a Drizzle schema file the process can read." },
    });
  }
  if (!info.isFile()) {
    throw new OkmError("invalid", `Cannot read ${path}. It is not a file.`, {
      fix: { summary: "Pass a Drizzle schema file." },
    });
  }
  return path;
}

async function loadDrizzle(project: string): Promise<Loaded> {
  let pgEntry: string;
  let ormEntry: string;
  try {
    const require = createRequire(join(resolve(project), "package.json"));
    pgEntry = require.resolve("drizzle-orm/pg-core");
    ormEntry = require.resolve("drizzle-orm");
  } catch (error) {
    throw missingDrizzle(error);
  }
  const pg = (await import(pathToFileURL(pgEntry).href)) as Record<string, unknown>;
  const orm = (await import(pathToFileURL(ormEntry).href)) as Record<string, unknown>;
  const is = orm.is;
  const getTableConfig = pg.getTableConfig;
  const getTableColumns = orm.getTableColumns;
  const PgTable = pg.PgTable;
  const PgView = pg.PgView;
  const PgMaterializedView = pg.PgMaterializedView;
  const PgSequence = pg.PgSequence;
  const Relations = orm.Relations;
  const getViewConfig = pg.getViewConfig;
  if (
    typeof is !== "function" ||
    typeof getTableConfig !== "function" ||
    typeof getTableColumns !== "function" ||
    typeof PgTable !== "function" ||
    typeof PgView !== "function" ||
    typeof PgMaterializedView !== "function" ||
    typeof PgSequence !== "function" ||
    typeof Relations !== "function" ||
    typeof getViewConfig !== "function"
  ) {
    throw new OkmError("OKM1856", "This project's drizzle-orm has no pg table helpers.", {
      fix: { summary: "Install a current drizzle-orm in the project that owns the schema." },
    });
  }
  return {
    is: is as Loaded["is"],
    PgTable,
    PgView,
    PgMaterializedView,
    PgSequence,
    Relations,
    getTableConfig: getTableConfig as Loaded["getTableConfig"],
    getTableColumns: getTableColumns as Loaded["getTableColumns"],
    getViewConfig: getViewConfig as Loaded["getViewConfig"],
  };
}

function missingDrizzle(error: unknown): OkmError {
  const detail = error instanceof Error && error.message.length > 0 ? ` ${error.message}` : "";
  return new OkmError("OKM1856", `drizzle-orm is not installed in this project.${detail}`, {
    cause: error,
    fix: { summary: "Install drizzle-orm in the project that owns the schema." },
  });
}

async function loadSchemaModule(file: string): Promise<Record<string, unknown>> {
  try {
    const imported: unknown = await import(pathToFileURL(file).href);
    if (typeof imported !== "object" || imported === null) return {};
    return imported as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OkmError) throw error;
    const detail = error instanceof Error && error.message.length > 0 ? error.message : "failed";
    throw new OkmError("invalid", `Importing ${file} failed. ${detail}`, {
      cause: error,
      fix: { summary: "The schema file is executed. Fix the error it raised." },
    });
  }
}

function collect(module: Record<string, unknown>, drizzle: Loaded): Found {
  const tables: { value: object; exportName: string }[] = [];
  const enums: EnumNote[] = [];
  const views: string[] = [];
  const relations: string[] = [];
  const sequences: { name: string; schema: string }[] = [];
  const seen = new Set<unknown>();
  const knownTables = new Set<object>();
  const visit = (value: unknown, exportName: string): void => {
    if (typeof value === "function") {
      const note = enumNote(value);
      if (note !== undefined && !enums.some((item) => item.name === note.name)) enums.push(note);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (drizzle.is(value, drizzle.PgTable)) {
      if (!knownTables.has(value)) {
        knownTables.add(value);
        tables.push({ value, exportName });
      }
      return;
    }
    if (drizzle.is(value, drizzle.Relations)) {
      relations.push(exportName);
      return;
    }
    if (drizzle.is(value, drizzle.PgView) || drizzle.is(value, drizzle.PgMaterializedView)) {
      views.push(viewName(value, drizzle, exportName));
      return;
    }
    if (drizzle.is(value, drizzle.PgSequence)) {
      const name = stringField(value, "seqName");
      if (name !== undefined) {
        sequences.push({ name, schema: stringField(value, "schema") ?? "public" });
      }
      return;
    }
    for (const child of Object.values(value)) visit(child, exportName);
  };
  for (const key of Object.keys(module).sort()) visit(module[key], key);
  tables.sort((left, right) => compare(left.exportName, right.exportName));
  return { tables, enums, views, relations, sequences };
}

function chooseNamespace(tables: readonly { readonly value: object }[], drizzle: Loaded): string {
  const names = new Set(
    tables.map((item) => drizzle.getTableConfig(item.value).schema ?? "public"),
  );
  if (names.size === 1) return [...names][0] ?? "public";
  if (names.has("public")) return "public";
  return [...names].sort()[0] ?? "public";
}

function catalogOf(
  found: Found,
  drizzle: Loaded,
  namespaceName: string,
  extras: PullSkip[],
): CatalogObject[] {
  const namespace = staticNamespace(namespaceName);
  const objects: CatalogObject[] = [];
  const enums = new Map<string, readonly string[]>();
  for (const note of found.enums) enums.set(note.name, note.labels);
  for (const item of found.relations) {
    extras.push(extra("relation", item, "relations() is not a foreign key"));
  }
  for (const item of found.views) {
    extras.push(extra("view", item, "a later step writes views"));
  }
  for (const item of found.sequences) {
    if (item.schema !== namespaceName) {
      extras.push(
        extra(
          "sequence",
          item.name,
          "table() has no standalone sequence. An identity column writes its own",
        ),
      );
      continue;
    }
    objects.push(
      sequence({
        namespace,
        name: item.name,
        provenance: provenanceOf(),
      }),
    );
  }
  for (const item of found.tables) {
    const config = drizzle.getTableConfig(item.value);
    const schemaName = config.schema ?? "public";
    if (schemaName !== namespaceName) {
      extras.push(
        extra(
          "table",
          config.name,
          "schema() has one namespace. Import that schema on its own and set namespace",
        ),
      );
      continue;
    }
    const parent: ObjectRef = { namespace, name: config.name };
    objects.push(
      table({
        namespace,
        name: config.name,
        provenance: provenanceOf(`export:${item.exportName}`),
      }),
    );
    if (config.enableRLS) {
      extras.push(
        extra("policy", `${config.name}.row level security`, "a later step writes policies"),
      );
    }
    for (const policy of config.policies) {
      const name = policy.name ?? "policy";
      extras.push(extra("policy", `${config.name}.${name}`, "a later step writes policies"));
    }
    const columns = drizzle.getTableColumns(item.value);
    const primaryColumns = primaryColumnsOf(config, columns);
    for (const [property, value] of Object.entries(columns)) {
      const built = columnOf(
        parent,
        property,
        value,
        primaryColumns,
        enums,
        objects,
        namespace,
        extras,
        config.name,
      );
      if (built !== undefined) objects.push(built);
    }
    for (const key of config.primaryKeys) {
      const names = key.columns.map((entry) => entry.name);
      if (names.length === 0) continue;
      if (sameColumns(names, primaryColumns)) continue;
      objects.push(
        constraint({
          parent,
          constraintKind: "primaryKey",
          columns: names,
          nameKey: keyName(key.name, names),
          provenance: provenanceOf(),
        }),
      );
    }
    if (primaryColumns.length > 0) {
      objects.push(
        constraint({
          parent,
          constraintKind: "primaryKey",
          columns: primaryColumns,
          nameKey: "pkey",
          provenance: provenanceOf(),
        }),
      );
    }
    const uniqueSets = new Set<string>();
    for (const unique of config.uniqueConstraints) {
      const names = unique.columns.map((entry) => entry.name);
      uniqueSets.add(names.join("\0"));
      objects.push(
        constraint({
          parent,
          constraintKind: "unique",
          columns: names,
          nameKey: keyName(unique.name, names),
          nullsNotDistinct: unique.nullsNotDistinct,
          provenance: provenanceOf(),
        }),
      );
    }
    for (const [property, value] of Object.entries(columns)) {
      if (!flag(value, "isUnique")) continue;
      const name = stringField(value, "name") ?? property;
      if (uniqueSets.has(name)) continue;
      objects.push(
        constraint({
          parent,
          constraintKind: "unique",
          columns: [name],
          nameKey: keyName(stringField(value, "uniqueName"), [name]),
          provenance: provenanceOf(),
        }),
      );
    }
    for (const key of config.foreignKeys) {
      const ref = key.reference();
      const local = ref.columns.map((entry) => entry.name);
      const remote = ref.foreignColumns.map((entry) => entry.name);
      const target = drizzle.getTableConfig(ref.foreignTable);
      if ((target.schema ?? "public") !== namespaceName) {
        extras.push(
          extra(
            "constraint",
            `${config.name}.${local.join("_")}`,
            "the referenced table is in another schema",
          ),
        );
        continue;
      }
      const onDelete = action(key.onDelete);
      const onUpdate = action(key.onUpdate);
      objects.push(
        constraint({
          parent,
          constraintKind: "foreignKey",
          columns: local,
          nameKey: keyName(undefined, local),
          provenance: provenanceOf(),
          references: {
            parent: { namespace, name: target.name },
            columns: remote,
            ...(onDelete !== undefined ? { onDelete } : {}),
            ...(onUpdate !== undefined ? { onUpdate } : {}),
          },
        }),
      );
    }
    for (const check of config.checks) {
      const rendered = sqlText(check.value);
      if (rendered === undefined) {
        extras.push(
          extra(
            "constraint",
            `${config.name}.${check.name}`,
            "the check expression could not be read",
          ),
        );
        continue;
      }
      objects.push(
        constraint({
          parent,
          constraintKind: "check",
          columns: namesIn(check.value),
          nameKey: keyName(check.name, [check.name]),
          expression: rendered,
          provenance: provenanceOf(),
        }),
      );
    }
    for (const item of config.indexes) {
      const unsupported =
        item.config.concurrently === true ||
        item.config.only === true ||
        (item.config.method !== undefined && item.config.method !== "btree") ||
        item.config.with !== undefined;
      const label = `${config.name}.${item.config.name ?? "index"}`;
      if (unsupported) {
        extras.push(
          extra(
            "index",
            label,
            "index() cannot store concurrently, only, a non-btree method, or storage parameters",
          ),
        );
        continue;
      }
      const names = item.config.columns
        .map((entry) => stringField(entry, "name"))
        .filter((name): name is string => name !== undefined);
      const expression = item.config.columns
        .filter((entry) => stringField(entry, "name") === undefined)
        .map((entry) => sqlText(entry))
        .find((text): text is string => text !== undefined);
      const predicate = item.config.where === undefined ? undefined : sqlText(item.config.where);
      if (names.length === 0 && expression === undefined) {
        extras.push(extra("index", label, "index() needs a column. This index is an expression"));
        continue;
      }
      if (predicate === undefined && item.config.where !== undefined) {
        extras.push(extra("index", label, "the index predicate could not be read"));
        continue;
      }
      objects.push(
        index({
          parent,
          columns: names,
          unique: item.config.unique,
          nameKey: keyName(item.config.name, names.length > 0 ? names : ["expr"]),
          ...(predicate !== undefined ? { predicate } : {}),
          ...(expression !== undefined ? { expression } : {}),
          provenance: provenanceOf(),
        }),
      );
    }
  }
  for (const [name, labels] of enums) {
    objects.push(
      enumType({
        namespace,
        name,
        labels,
        provenance: provenanceOf(),
      }),
    );
  }
  return objects;
}

function columnOf(
  parent: ObjectRef,
  property: string,
  value: object,
  primaryColumns: readonly string[],
  enums: Map<string, readonly string[]>,
  objects: CatalogObject[],
  namespace: Namespace,
  extras: PullSkip[],
  tableName: string,
): CatalogObject | undefined {
  const sqlName = stringField(value, "name") ?? property;
  const rawType = sqlType(value);
  if (rawType === undefined) return undefined;
  const mapped = catalogType(rawType);
  const note = enumNote(recordField(value, "enum"));
  if (note !== undefined) enums.set(note.name, note.labels);
  const identity = identityOf(value);
  const generated = generatedOf(value);
  const serial = mapped.serial;
  if (serial) {
    const dataType: "smallint" | "integer" | "bigint" =
      mapped.dataType === "smallint" || mapped.dataType === "bigint" ? mapped.dataType : "integer";
    objects.push(
      sequence({
        namespace,
        name: `${parent.name}_${sqlName}_seq`,
        dataType,
        provenance: provenanceOf(),
        dependencies: [{ kind: "table", namespace, name: parent.name }],
      }),
    );
  }
  const defaultExpression =
    serial || identity !== undefined || generated !== undefined
      ? undefined
      : readDefault(value, extras, `${tableName}.${sqlName}`);
  const nullable = flag(value, "notNull") ? false : true;
  const dataType = note !== undefined ? note.name : mapped.dataType;
  const solePrimary =
    identity?.always === true &&
    dataType === "bigint" &&
    !nullable &&
    primaryColumns.length === 1 &&
    primaryColumns[0] === sqlName;
  return column({
    parent,
    name: sqlName,
    dataType,
    nullable: solePrimary ? false : nullable,
    provenance: provenanceOf(`field:${property}`),
    ...(defaultExpression !== undefined ? { defaultExpression } : {}),
    ...(identity !== undefined ? { identity } : {}),
    ...(generated !== undefined ? { generated } : {}),
    ...(note !== undefined
      ? { dependencies: [{ kind: "type" as const, namespace, name: note.name }] }
      : {}),
  });
}

function primaryColumnsOf(config: TableConfig, columns: Record<string, object>): readonly string[] {
  const declared = config.primaryKeys[0];
  if (declared !== undefined && declared.columns.length > 0) {
    return declared.columns.map((entry) => entry.name);
  }
  const names: string[] = [];
  for (const value of Object.values(columns)) {
    if (flag(value, "primary")) {
      const name = stringField(value, "name");
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

function catalogType(sqlType: string): { readonly dataType: string; readonly serial: boolean } {
  if (sqlType === "serial") return { dataType: "integer", serial: true };
  if (sqlType === "bigserial") return { dataType: "bigint", serial: true };
  if (sqlType === "smallserial") return { dataType: "smallint", serial: true };
  if (sqlType === "timestamp") return { dataType: "timestamp without time zone", serial: false };
  if (sqlType === "time") return { dataType: "time without time zone", serial: false };
  return { dataType: sqlType, serial: false };
}

function identityOf(value: object): { readonly always: boolean } | undefined {
  const identity = recordField(value, "generatedIdentity");
  if (typeof identity !== "object" || identity === null) return undefined;
  const type = stringField(identity, "type");
  if (type === "always") return { always: true };
  if (type === "byDefault") return { always: false };
  return undefined;
}

function generatedOf(
  value: object,
): { readonly stored: boolean; readonly expression: string } | undefined {
  const generated = recordField(value, "generated");
  if (typeof generated !== "object" || generated === null) return undefined;
  const expression = sqlText(recordField(generated, "as"));
  if (expression === undefined || expression.length === 0) return undefined;
  const mode = stringField(generated, "mode");
  return { stored: mode !== "virtual", expression };
}

function readDefault(value: object, extras: PullSkip[], label: string): string | undefined {
  const hasFn = typeof recordField(value, "defaultFn") === "function";
  const raw = recordField(value, "default");
  if (raw === undefined) {
    if (hasFn) extras.push(extra("column", label, "a client default is not a SQL default"));
    return undefined;
  }
  const rendered = sqlText(raw);
  if (rendered === undefined || rendered.length === 0) {
    extras.push(extra("column", label, "the default expression could not be read"));
    return undefined;
  }
  return rendered;
}

function sqlType(value: object): string | undefined {
  if (!("getSQLType" in value) || typeof value.getSQLType !== "function") return undefined;
  const type = (value.getSQLType as () => unknown).call(value);
  return typeof type === "string" && type.length > 0 ? type : undefined;
}

function sqlText(value: unknown): string | undefined {
  if (typeof value === "string") return quoteLiteral(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === null) return "null";
  if (typeof value !== "object") return undefined;
  const chunks = recordField(value, "queryChunks");
  if (!Array.isArray(chunks)) return undefined;
  let text = "";
  for (const chunk of chunks) {
    if (typeof chunk !== "object" || chunk === null) return undefined;
    const literal = recordField(chunk, "value");
    if (Array.isArray(literal) && typeof literal[0] === "string") {
      text += literal[0];
      continue;
    }
    const name = stringField(chunk, "name");
    if (name !== undefined) {
      text += `"${name.replaceAll('"', '""')}"`;
      continue;
    }
    return undefined;
  }
  return text;
}

function namesIn(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const chunks = recordField(value, "queryChunks");
  if (!Array.isArray(chunks)) return [];
  const names: string[] = [];
  for (const chunk of chunks) {
    const name =
      typeof chunk === "object" && chunk !== null ? stringField(chunk, "name") : undefined;
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

function enumNote(value: unknown): EnumNote | undefined {
  if (typeof value !== "function" && (typeof value !== "object" || value === null))
    return undefined;
  if (typeof value === "function" && (!(ENUM_SYMBOL in value) || value[ENUM_SYMBOL] !== true)) {
    return undefined;
  }
  if (typeof value === "object" && value !== null && !("enumName" in value)) return undefined;
  const name = stringField(value, "enumName");
  const labels = recordField(value, "enumValues");
  if (name === undefined || !Array.isArray(labels)) return undefined;
  const strings = labels.filter((label): label is string => typeof label === "string");
  if (strings.length === 0) return undefined;
  return { name, labels: strings };
}

function action(value: string | undefined): ReferentialAction | undefined {
  if (value === undefined || value === "no action") return undefined;
  return referentialAction(value);
}

function keyName(name: string | undefined, columns: readonly string[]): string {
  if (name !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  const joined = columns.join("_");
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(joined)) return joined;
  return "key";
}

function sameColumns(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}

function provenanceOf(source?: string): Provenance {
  return source === undefined
    ? { origin: "file", name: "drizzle" }
    : { origin: "file", name: "drizzle", source };
}

function extra(kind: string, label: string, reason: string): PullSkip {
  return { key: `import:${kind}:${label}`, kind, label, reason, sql: "" };
}

function viewName(value: object, drizzle: Loaded, fallback: string): string {
  try {
    const config = drizzle.getViewConfig(value);
    return config.name ?? fallback;
  } catch {
    return fallback;
  }
}

function flag(value: object, key: string): boolean {
  return recordField(value, key) === true;
}

function stringField(value: object, key: string): string | undefined {
  const field = recordField(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function recordField(value: object, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return (value as Record<string, unknown>)[key];
}

async function layoutFor(cwd: string, out: string | undefined) {
  if (out !== undefined) return pullLayout(cwd, "schema.ts", "tables", out);
  const configPath = join(cwd, "okmodel.config.ts");
  if (!existsSync(configPath)) return pullLayout(cwd, "schema.ts", "tables", undefined);
  const config = await loadConfig(cwd);
  return pullLayout(cwd, config.schema, config.tables, undefined);
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
