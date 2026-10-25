/**
 * Turns an introspected catalog into table files and a schema file.
 *
 * `schema()` is the only writer. Functions, triggers, and views are written
 * beside the tables. A kind it cannot store is returned, with the SQL the
 * catalog already holds, and is not guessed.
 */

import { relative, dirname } from "node:path";

import { isDomain } from "../../contracts/catalog/enum.js";
import { identityKey } from "../../contracts/catalog/identity.js";
import { deterministicName } from "../../contracts/catalog/identifier.js";
import { qualify, renderCatalog } from "../../dialects/pg/ddl.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ConstraintObject,
  IndexObject,
  SequenceObject,
  TableObject,
} from "../../contracts/catalog/types.js";
import {
  avoidImportBinding,
  planRoutines,
  renderRoutines,
  type RoutinePlan,
  type RoutineVerdict,
} from "./pull-routines.js";

/** One file `okm pull` writes. */
export type PullFile = {
  /** Absolute path. */
  readonly path: string;
  /** Source text, before the project formatter runs. */
  readonly text: string;
};

/** One object the schema file does not declare. */
export type PullSkip = {
  /** {@link identityKey} of the catalog object. */
  readonly key: string;
  /** Catalog kind, or `column` for a type `table()` cannot build. */
  readonly kind: string;
  /** `table.column`, or the object name. */
  readonly label: string;
  /** Why this step left it out. */
  readonly reason: string;
  /** SQL from the catalog. Empty when the kind has no statement of its own. */
  readonly sql: string;
};

/** Extension written on relative imports. Files on disk stay `.ts`. */
export type PullImportExt = "ts" | "js" | "none";

/** Where the schema file and the table files go. */
export type PullLayout = {
  /** Absolute path of the schema module. */
  readonly schemaFile: string;
  /** Absolute directory of one file per table. */
  readonly tablesDir: string;
};

/** Files to write, and the objects those files leave out. */
export type PullEmission = {
  readonly files: readonly PullFile[];
  readonly skipped: readonly PullSkip[];
  /** Scratch results for the routines the files declare. */
  readonly verdicts: readonly RoutineVerdict[];
  /**
   * `table.column (constraint)` for each column the database holds as
   * `NOT NULL … NOT VALID` (PostgreSQL 18). The files declare it nullable.
   */
  readonly unvalidated: readonly string[];
  readonly counts: {
    readonly tables: number;
    readonly functions: number;
    readonly triggers: number;
    readonly views: number;
    readonly materializedViews: number;
  };
};

const DEFERRED: readonly { readonly kind: string; readonly reason: string }[] = [
  { kind: "policy", reason: "a later step writes policies" },
  { kind: "role", reason: "a later step writes roles and grants" },
  { kind: "grant", reason: "a later step writes roles and grants" },
  { kind: "defaultPrivilege", reason: "a later step writes roles and grants" },
];

/** A kind the catalog cannot store, counted for the report. */
export type PullCount = {
  readonly kind: string;
  readonly count: number;
  readonly reason: string;
};

/** Scratch verdicts and the kinds the catalog has no object for. */
export type PullReview = {
  readonly plan: RoutinePlan;
  readonly verdicts: readonly RoutineVerdict[];
  readonly unexpressed: readonly PullCount[];
};

const RESERVED = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/**
 * Writes one table module per table and the schema module that imports them.
 *
 * Column order, import order, and option keys are sorted, so the same catalog
 * produces the same text.
 *
 * @param source - Catalog from introspection, logical namespace `public`
 * @param layout - Schema file and tables directory
 * @param review - Scratch verdicts. Omitted marks every function candidate-only
 * @param options - `importExt` defaults to `ts`
 * @returns The files and the objects they do not declare
 */
export function emitPull(
  source: Catalog,
  layout: PullLayout,
  review?: PullReview,
  options?: { readonly importExt?: PullImportExt },
): PullEmission {
  const importExt = options?.importExt ?? "ts";
  const statements = rendered(source);
  const skipped: PullSkip[] = [];
  const enums = enumLabels(source);
  const domains = domainDefs(source);
  const byParent = groupByParent(source);
  const tables = source.objects
    .filter((object): object is TableObject => object.kind === "table")
    .sort((left, right) => compare(left.identity.name, right.identity.name));
  const files: PullFile[] = [];
  const imports: { readonly name: string; readonly file: string }[] = [];
  const usedFiles = new Set<string>();
  const usedExports = new Set<string>();
  const identitySequences = new Set<string>();
  const tableExports = new Map<string, string>();

  for (const table of tables) {
    if (table.definition.partition !== undefined) continue;
    const exportName = freshIdent(
      declaredIdent(table.provenance.source, table.identity.name),
      usedExports,
    );
    tableExports.set(table.identity.name, exportName);
  }

  const pulledColumns = pulledColumnNames(tables, byParent, enums, domains);
  for (const table of tables) {
    if (table.definition.partition !== undefined) {
      skipped.push(
        skip(
          table,
          "table",
          table.identity.name,
          "table() has no partition option",
          statementFor(statements, table.identity.name),
        ),
      );
      skipChildren(table.identity.name, byParent, statements, skipped);
      continue;
    }
    const exportName = tableExports.get(table.identity.name);
    if (exportName === undefined) continue;
    const planned = planTable(
      table,
      byParent,
      enums,
      domains,
      statements,
      skipped,
      exportName,
      tableExports,
      pulledColumns,
    );
    if (planned === undefined) continue;
    if (planned.identitySequence !== undefined) identitySequences.add(planned.identitySequence);
    const fileName = uniqueFile(planned.exportName, usedFiles);
    const path = `${layout.tablesDir}/${fileName}.ts`;
    files.push({ path, text: planned.text });
    imports.push({ name: planned.exportName, file: path });
  }

  const skippedKeys = new Set(skipped.map((item) => item.key));
  for (const object of source.objects) {
    if (object.kind !== "sequence" || skippedKeys.has(identityKey(object.identity))) continue;
    if (identitySequences.has(object.identity.name)) continue;
    const parent = object.dependencies.find((edge) => edge.target.kind === "table");
    const parentName =
      parent !== undefined && parent.target.kind === "table" ? parent.target.name : "";
    const kept =
      parentName.length > 0 &&
      tables.some(
        (table) => table.identity.name === parentName && table.definition.partition === undefined,
      );
    if (kept) continue;
    skipped.push(
      skip(
        object,
        "sequence",
        object.identity.name,
        "table() has no standalone sequence. An identity column writes its own",
        statementFor(statements, object.identity.name),
      ),
    );
  }

  const plan = review?.plan ?? planRoutines(source, tableExports);
  for (const item of plan.skipped) skipped.push(item);
  for (const object of source.objects) {
    if (!isDeferred(object.kind)) continue;
    skipped.push(
      skip(
        object,
        object.kind,
        objectLabel(object),
        deferredReason(object.kind),
        statementFor(statements, objectName(object)),
      ),
    );
  }
  for (const object of source.objects) {
    if (object.kind !== "type") continue;
    if (typeIsUsed(object.identity.name, source, skipped)) continue;
    const label = object.identity.name;
    skipped.push(
      skip(
        object,
        "type",
        label,
        "no pulled column uses this type",
        statementFor(statements, label),
      ),
    );
  }
  appendRowLevelSecurity(source, skipped);

  const verdictList = review?.verdicts ?? [];
  const routines = renderRoutines(plan, new Map(verdictList.map((item) => [item.key, item])));
  files.push({
    path: layout.schemaFile,
    text: schemaText(layout.schemaFile, imports, extensionCalls(source), routines, importExt),
  });
  files.sort((left, right) => compare(left.path, right.path));
  skipped.sort((left, right) =>
    compare(`${left.kind}\0${left.label}`, `${right.kind}\0${right.label}`),
  );
  const viewCount = plan.views.filter((item) => item.object.kind === "view").length;
  return {
    files,
    skipped,
    verdicts: verdictList,
    unvalidated: unvalidatedColumns(source, skippedKeys),
    counts: {
      tables: tables.length - skippedTables(source, skipped),
      functions: plan.functions.length,
      triggers: plan.triggers.length,
      views: viewCount,
      materializedViews: plan.views.length - viewCount,
    },
  };
}

function unvalidatedColumns(source: Catalog, skippedKeys: ReadonlySet<string>): readonly string[] {
  const labels: string[] = [];
  for (const object of source.objects) {
    if (object.kind !== "column" || object.definition.unvalidatedNotNull === undefined) continue;
    if (skippedKeys.has(identityKey(object.identity))) continue;
    labels.push(
      `${object.identity.parent.name}.${object.identity.name} (${object.definition.unvalidatedNotNull})`,
    );
  }
  return labels.sort(compare);
}

function skippedTables(source: Catalog, skipped: readonly PullSkip[]): number {
  let count = 0;
  for (const object of source.objects) {
    if (object.kind !== "table") continue;
    if (skipped.some((item) => item.key === identityKey(object.identity))) count += 1;
  }
  return count;
}

/**
 * Text `okm pull` prints.
 *
 * Deferred kinds and kinds the catalog cannot store are always listed,
 * including a count of zero, so a kind is not dropped without a line.
 * Each pulled function is `verified`, `candidate-only`, or `unverified`.
 *
 * @param counts - Objects the files declare
 * @param skipped - Objects the files leave out
 * @param verdicts - Scratch results. Empty when no routine was pulled
 * @param unexpressed - Aggregates, procedures, event triggers, and rules
 * @param verb - `imported` for `okm import drizzle`. `pulled` is `okm pull`
 * @param unvalidated - Columns the database holds as `NOT NULL … NOT VALID`
 * @returns The report, with a trailing newline
 */
export function formatPullReport(
  counts: PullEmission["counts"],
  skipped: readonly PullSkip[],
  verdicts: readonly RoutineVerdict[] = [],
  unexpressed: readonly PullCount[] = [],
  verb: "pulled" | "imported" = "pulled",
  unvalidated: readonly string[] = [],
): string {
  const lines = [
    verb === "imported"
      ? `imported ${counted(counts.tables, "table", "tables")}`
      : `pulled ${counted(counts.tables, "table", "tables")}, ${counted(counts.functions, "function", "functions")}, ${counted(counts.triggers, "trigger", "triggers")}, ${counted(counts.views, "view", "views")}, ${counted(counts.materializedViews, "materialized view", "materialized views")}`,
  ];
  const marked = [...verdicts].sort((left, right) => compare(left.label, right.label));
  for (const item of marked) {
    const detail = item.detail.length > 0 ? ` — ${item.detail}` : "";
    lines.push(`  ${item.label}: ${item.status}${detail}`);
  }
  lines.push(verb === "imported" ? "not imported" : "not pulled yet");
  const deferredKinds = ["policy", "role", "grant", "defaultPrivilege"];
  for (const kind of deferredKinds) {
    const rows = skipped.filter((item) => item.kind === kind);
    const reason = deferredReason(kind);
    lines.push(`  ${kindLabel(kind)}: ${String(rows.length)} — ${reason}`);
    for (const row of rows) lines.push(`    ${row.label}`);
  }
  for (const item of unexpressed) {
    lines.push(`  ${kindLabel(item.kind)}: ${String(item.count)} — ${item.reason}`);
  }
  const rest = skipped.filter((item) => !deferredKinds.includes(item.kind));
  const groups = new Map<string, PullSkip[]>();
  for (const item of rest) {
    const group = groups.get(item.kind) ?? [];
    group.push(item);
    groups.set(item.kind, group);
  }
  for (const kind of [...groups.keys()].sort()) {
    const rows = groups.get(kind) ?? [];
    const header = rows[0]?.reason ?? "";
    lines.push(`  ${kindLabel(kind)}: ${String(rows.length)} — ${header}`);
    for (const row of rows) {
      const note = row.reason === header ? "" : ` — ${row.reason}`;
      lines.push(`    ${row.label}${note}`);
      if (row.sql.length > 0) lines.push(`      ${row.sql}`);
    }
  }
  if (unvalidated.length > 0) {
    lines.push(
      `  not validated: ${String(unvalidated.length)} — NOT NULL NOT VALID in the database, so the column is declared nullable until the constraint is validated`,
    );
    for (const label of unvalidated) lines.push(`    ${label}`);
  }
  return `${lines.join("\n")}\n`;
}

type PlannedTable = {
  readonly exportName: string;
  readonly text: string;
  /** Sequence `t.identity()` writes, when this table has one. */
  readonly identitySequence?: string;
};

type ParentBag = {
  columns: ColumnObject[];
  constraints: ConstraintObject[];
  indexes: IndexObject[];
  sequences: SequenceObject[];
};

function planTable(
  table: TableObject,
  byParent: ReadonlyMap<string, ParentBag>,
  enums: ReadonlyMap<string, readonly string[]>,
  domains: ReadonlyMap<string, { readonly base: string; readonly check: string }>,
  statements: readonly string[],
  skipped: PullSkip[],
  exportName: string,
  tableExports: ReadonlyMap<string, string>,
  pulledColumns: ReadonlyMap<string, ReadonlySet<string>>,
): PlannedTable | undefined {
  const bag = byParent.get(table.identity.name) ?? {
    columns: [],
    constraints: [],
    indexes: [],
    sequences: [],
  };
  const names = new Set<string>();
  const fields = new Map<string, string>();
  const columnLines: string[] = [];
  const emitted = new Set<string>();
  const primary = bag.constraints.find((item) => item.definition.constraintKind === "primaryKey");
  const primaryColumns = primary?.definition.columns ?? [];
  const identityColumn = identityPrimary(bag.columns, primaryColumns);

  for (const column of [...bag.columns].sort((left, right) =>
    compare(left.identity.name, right.identity.name),
  )) {
    const field = freshIdent(declaredIdent(column.provenance.source, column.identity.name), names);
    fields.set(column.identity.name, field);
    if (column === identityColumn) {
      const renamed =
        field !== column.identity.name ? `.sqlName(${JSON.stringify(column.identity.name)})` : "";
      columnLines.push(`    ${jsKey(field)}: t.identity()${renamed},`);
      emitted.add(column.identity.name);
      continue;
    }
    const built = columnSource(column, field, enums, domains);
    if (built === undefined) {
      skipped.push(
        skip(
          column,
          "column",
          `${table.identity.name}.${column.identity.name}`,
          columnReason(column),
          "",
        ),
      );
      continue;
    }
    if (column.definition.unvalidatedNotNull !== undefined) {
      columnLines.push(
        `    // NOT NULL NOT VALID (${column.definition.unvalidatedNotNull}) in the database: rows with NULL may exist.`,
        `    // Validate the constraint, then remove .nullable().`,
      );
    }
    columnLines.push(`    ${jsKey(field)}: ${built},`);
    emitted.add(column.identity.name);
  }

  const options: string[] = [];
  if (exportName !== table.identity.name) {
    options.push(`    sqlName: ${JSON.stringify(table.identity.name)},`);
  }
  if (primary !== undefined && identityColumn === undefined && primaryColumns.length > 0) {
    if (primaryColumns.every((name) => emitted.has(name)) && plainConstraint(primary)) {
      const list = primaryColumns
        .map((name) => JSON.stringify(fields.get(name) ?? name))
        .join(", ");
      options.push(`    primaryKey: [${list}],`);
    } else {
      skipped.push(
        skip(
          primary,
          "constraint",
          `${table.identity.name}.${primary.identity.name}`,
          "primary key uses a column this step did not pull",
          statementFor(statements, primary.identity.name),
        ),
      );
    }
  }

  const uniques: string[] = [];
  const checks: string[] = [];
  const foreign: Map<string, string> = new Map();
  for (const constraint of [...bag.constraints].sort((left, right) =>
    compare(left.identity.name, right.identity.name),
  )) {
    const kind = constraint.definition.constraintKind;
    if (kind === "primaryKey") continue;
    const label = `${table.identity.name}.${constraint.identity.name}`;
    if (!constraint.definition.columns.every((name) => emitted.has(name))) {
      skipped.push(
        skip(
          constraint,
          "constraint",
          label,
          "a column of this constraint was not pulled",
          statementFor(statements, constraint.identity.name),
        ),
      );
      continue;
    }
    if (!plainConstraint(constraint)) {
      skipped.push(
        skip(
          constraint,
          "constraint",
          label,
          "deferrable, initially deferred, and nulls not distinct are not table() options",
          statementFor(statements, constraint.identity.name),
        ),
      );
      continue;
    }
    if (kind === "unique") {
      const cols = constraint.definition.columns
        .map((name) => JSON.stringify(fields.get(name) ?? name))
        .join(", ");
      uniques.push(`      ${jsKey(constraint.definition.nameKey)}: [${cols}],`);
      continue;
    }
    if (kind === "check" && constraint.definition.expression !== undefined) {
      const touches = constraint.definition.columns
        .map((name) => `void columns.${fields.get(name) ?? name}`)
        .join("; ");
      const touch = touches.length > 0 ? `${touches}; ` : "";
      checks.push(
        `      ${jsKey(constraint.definition.nameKey)}: (columns) => { ${touch}return ${sqlTemplate(constraint.definition.expression)}; },`,
      );
      continue;
    }
    if (kind === "foreignKey") {
      const local = constraint.definition.columns;
      const references = constraint.definition.references;
      const field = local[0] === undefined ? undefined : fields.get(local[0]);
      if (field !== undefined && foreign.has(field)) {
        skipped.push(
          skip(
            constraint,
            "constraint",
            label,
            "references() is one foreign key on a column",
            statementFor(statements, constraint.identity.name),
          ),
        );
        continue;
      }
      if (local.length !== 1 || local[0] === undefined || references === undefined) {
        skipped.push(
          skip(
            constraint,
            "constraint",
            label,
            "references() takes one local column",
            statementFor(statements, constraint.identity.name),
          ),
        );
        continue;
      }
      if (field === undefined || !referencedColumnsPulled(references, pulledColumns)) {
        skipped.push(
          skip(
            constraint,
            "constraint",
            label,
            "references a column that was not pulled",
            statementFor(statements, constraint.identity.name),
          ),
        );
        continue;
      }
      foreign.set(field, referenceCall(references, tableExports));
      continue;
    }
    skipped.push(
      skip(
        constraint,
        "constraint",
        label,
        "table() cannot store this constraint",
        statementFor(statements, constraint.identity.name),
      ),
    );
  }

  if (uniques.length > 0) {
    options.push("    unique: {");
    options.push(...uniques);
    options.push("    },");
  }
  if (checks.length > 0) {
    options.push("    checks: {");
    options.push(...checks);
    options.push("    },");
  }

  const indexLines: string[] = [];
  let needsIndex = false;
  let needsSql = checks.length > 0;
  for (const index of [...bag.indexes].sort((left, right) =>
    compare(left.identity.name, right.identity.name),
  )) {
    const label = `${table.identity.name}.${index.identity.name}`;
    if (!index.definition.columns.every((name) => emitted.has(name))) {
      skipped.push(
        skip(
          index,
          "index",
          label,
          "a column of this index was not pulled",
          statementFor(statements, index.identity.name),
        ),
      );
      continue;
    }
    if (index.definition.columns.length === 0) {
      skipped.push(
        skip(
          index,
          "index",
          label,
          "index() needs a column. This index is an expression",
          statementFor(statements, index.identity.name),
        ),
      );
      continue;
    }
    indexLines.push(`      ${indexCall(index, fields)},`);
    needsIndex = true;
  }
  if (indexLines.length > 0) {
    options.push("    indexes: (columns) => [");
    options.push(...indexLines);
    options.push("    ],");
  }

  for (const sequence of bag.sequences) {
    const owned =
      identityColumn !== undefined &&
      sequence.identity.name ===
        identitySequence(table.identity.name, identityColumn.identity.name) &&
      sequence.definition.dataType === "bigint" &&
      sequence.definition.start === "1" &&
      sequence.definition.increment === "1" &&
      sequence.definition.cycle === false;
    if (owned) continue;
    skipped.push(
      skip(
        sequence,
        "sequence",
        sequence.identity.name,
        "table() has no standalone sequence. An identity column writes its own",
        statementFor(statements, sequence.identity.name),
      ),
    );
  }

  const columnText = rewriteForeign(columnLines, foreign);
  const needsTable = true;
  const imports = importLine(needsTable, needsIndex, needsSql);
  const optionBlock =
    options.length === 0
      ? ""
      : `,
  {
${options.join("\n")}
  }`;
  const text = `${imports}

export const ${exportName} = table(
  ${JSON.stringify(exportName === table.identity.name ? table.identity.name : exportName)},
  {
${columnText.join("\n")}
  }${optionBlock},
);
`;
  return {
    exportName,
    text,
    ...(identityColumn === undefined
      ? {}
      : { identitySequence: identitySequence(table.identity.name, identityColumn.identity.name) }),
  };
}

function identityPrimary(
  columns: readonly ColumnObject[],
  primaryColumns: readonly string[],
): ColumnObject | undefined {
  return columns.find(
    (column) =>
      column.definition.identity?.always === true &&
      !column.definition.nullable &&
      primaryColumns.length === 1 &&
      primaryColumns[0] === column.identity.name &&
      column.definition.dataType === "bigint",
  );
}

/**
 * SQL column names `planTable` will write, keyed by table name.
 *
 * A foreign key to a name outside this set is not emitted. `t.identity()` is
 * only the bigint generated-always primary key, so an integer identity key
 * is absent and the key that points at it is listed instead of built.
 */
function pulledColumnNames(
  tables: readonly TableObject[],
  byParent: ReadonlyMap<string, ParentBag>,
  enums: ReadonlyMap<string, readonly string[]>,
  domains: ReadonlyMap<string, { readonly base: string; readonly check: string }>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const pulled = new Map<string, ReadonlySet<string>>();
  for (const table of tables) {
    const bag = byParent.get(table.identity.name);
    const columns = bag?.columns ?? [];
    const primary = bag?.constraints.find(
      (item) => item.definition.constraintKind === "primaryKey",
    );
    const identityColumn = identityPrimary(columns, primary?.definition.columns ?? []);
    const names = new Set<string>();
    for (const column of columns) {
      if (column === identityColumn) {
        names.add(column.identity.name);
        continue;
      }
      if (columnSource(column, column.identity.name, enums, domains) !== undefined) {
        names.add(column.identity.name);
      }
    }
    pulled.set(table.identity.name, names);
  }
  return pulled;
}

function referencedColumnsPulled(
  references: NonNullable<ConstraintObject["definition"]["references"]>,
  pulled: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const columns = pulled.get(references.parent.name);
  if (columns === undefined) return false;
  return references.columns.every((name) => columns.has(name));
}

function columnSource(
  column: ColumnObject,
  field: string,
  enums: ReadonlyMap<string, readonly string[]>,
  domains: ReadonlyMap<string, { readonly base: string; readonly check: string }>,
): string | undefined {
  if (column.definition.identity !== undefined) return undefined;
  if (column.definition.generated !== undefined && column.definition.generated.stored !== true) {
    return undefined;
  }
  const labels = enums.get(column.definition.dataType);
  const domain = domains.get(column.definition.dataType);
  let call: string | undefined;
  if (labels !== undefined) {
    const list = labels.map((label) => JSON.stringify(label)).join(", ");
    call = `t.enum(${JSON.stringify(column.definition.dataType)}, [${list}])`;
  } else if (domain !== undefined) {
    const base = builderCall(domain.base, 0);
    if (base === undefined) return undefined;
    call = `t.domain(${JSON.stringify(column.definition.dataType)}, ${base}, ${JSON.stringify(domain.check)})`;
  } else {
    call = builderFor(column.definition.dataType);
  }
  if (call === undefined) return undefined;
  if (field !== column.identity.name) call += `.sqlName(${JSON.stringify(column.identity.name)})`;
  if (column.definition.nullable || column.definition.unvalidatedNotNull !== undefined) {
    call += ".nullable()";
  }
  if (column.definition.defaultExpression !== undefined) {
    call += `.defaultSql(${JSON.stringify(column.definition.defaultExpression)})`;
  }
  if (column.definition.generated !== undefined) {
    call += `.generated(${JSON.stringify(column.definition.generated.expression)})`;
  }
  if (column.definition.collation !== undefined) return undefined;
  return call;
}

function builderFor(dataType: string): string | undefined {
  const dims = arrayDims(dataType);
  const scalar = dims === 0 ? dataType : dataType.slice(0, dataType.length - 2 * dims);
  const call = builderCall(scalar, dims);
  return call;
}

function builderCall(scalar: string, dims: number): string | undefined {
  const simple: Readonly<Record<string, string>> = {
    integer: "t.integer()",
    bigint: "t.bigint()",
    smallint: "t.smallint()",
    text: "t.text()",
    boolean: "t.boolean()",
    bytea: "t.bytea()",
    uuid: "t.uuid()",
    jsonb: "t.jsonb()",
    json: "t.json()",
    real: "t.real()",
    "double precision": "t.double()",
    numeric: "t.numeric()",
    date: "t.date()",
    inet: "t.inet()",
    cidr: "t.cidr()",
    macaddr: "t.macaddr()",
    macaddr8: "t.macaddr8()",
    point: "t.point()",
    line: "t.line()",
    tsvector: "t.tsvector()",
    ltree: "t.ltree()",
    citext: "t.citext()",
    tstzrange: "t.tstzrange()",
    daterange: "t.daterange()",
    int4range: "t.int4range()",
    int8range: "t.int8range()",
    numrange: "t.numrange()",
    interval: "t.interval()",
  };
  let call = simple[scalar];
  if (call === undefined) call = typedCall(scalar);
  if (call === undefined) return undefined;
  if (dims === 0) return call;
  if (dims === 1) return `${call}.array()`;
  return `${call}.array({ dims: ${String(dims)} })`;
}

function typedCall(scalar: string): string | undefined {
  const varying = /^(?:character varying|varchar)\((\d+)\)$/.exec(scalar);
  if (varying !== null) return `t.varchar(${varying[1] ?? ""})`;
  const fixed = /^(?:character|char)\((\d+)\)$/.exec(scalar);
  if (fixed !== null) return `t.char(${fixed[1] ?? ""})`;
  const numeric = /^numeric\((\d+)(?:,(\d+))?\)$/.exec(scalar);
  if (numeric !== null) {
    const scale = numeric[2];
    return scale === undefined
      ? `t.numeric(${numeric[1] ?? ""})`
      : `t.numeric(${numeric[1] ?? ""}, ${scale})`;
  }
  const zone = /^(timestamp|time)(?:\((\d+)\))? (with|without) time zone$/.exec(scalar);
  if (zone !== null) {
    const precision = zone[2];
    const arg = precision === undefined ? "" : precision;
    const name = zone[1];
    const withZone = zone[3] === "with";
    if (name === "timestamp" && withZone)
      return arg.length === 0 ? "t.timestamptz()" : `t.timestamptz(${arg})`;
    if (name === "timestamp") return arg.length === 0 ? "t.timestamp()" : `t.timestamp(${arg})`;
    if (withZone) return arg.length === 0 ? "t.timetz()" : `t.timetz(${arg})`;
    return arg.length === 0 ? "t.time()" : `t.time(${arg})`;
  }
  const interval = /^interval (.+)$/.exec(scalar);
  if (interval !== null) {
    const fields = interval[1] ?? "";
    if (!INTERVAL_FIELDS.has(fields)) return undefined;
    return `t.interval(${JSON.stringify(fields)})`;
  }
  return undefined;
}

const INTERVAL_FIELDS = new Set([
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "year to month",
  "day to hour",
  "day to minute",
  "day to second",
  "hour to minute",
  "hour to second",
  "minute to second",
]);

function arrayDims(dataType: string): number {
  let dims = 0;
  let end = dataType.length;
  while (end >= 2 && dataType.endsWith("[]", end)) {
    dims += 1;
    end -= 2;
  }
  return dims;
}

function columnReason(column: ColumnObject): string {
  if (column.definition.identity !== undefined) {
    return "t.identity() is generated always, bigint, and the only primary key";
  }
  if (column.definition.generated !== undefined && column.definition.generated.stored !== true) {
    return "generated columns are stored";
  }
  if (column.definition.collation !== undefined) return "table() has no collation option";
  return `table() has no builder for ${column.definition.dataType}`;
}

function rewriteForeign(lines: readonly string[], foreign: ReadonlyMap<string, string>): string[] {
  return lines.map((line) => {
    for (const [field, call] of foreign) {
      const key = jsKey(field);
      const prefix = `    ${key}: `;
      if (!line.startsWith(prefix) || !line.endsWith(",")) continue;
      const body = line.slice(prefix.length, -1);
      return `${prefix}${body}${call},`;
    }
    return line;
  });
}

function referenceCall(
  references: NonNullable<ConstraintObject["definition"]["references"]>,
  tableExports: ReadonlyMap<string, string>,
): string {
  const options: string[] = [];
  if (references.columns.length > 0) {
    options.push(`columns: [${references.columns.map((name) => JSON.stringify(name)).join(", ")}]`);
  }
  if (references.onDelete !== undefined)
    options.push(`onDelete: ${JSON.stringify(references.onDelete)}`);
  if (references.onUpdate !== undefined)
    options.push(`onUpdate: ${JSON.stringify(references.onUpdate)}`);
  const optionText = options.length === 0 ? "" : `, { ${options.join(", ")} }`;
  const parent = tableExports.get(references.parent.name) ?? exportNameOf(references.parent.name);
  return `.references(${JSON.stringify(parent)}${optionText})`;
}

function indexCall(index: IndexObject, fields: ReadonlyMap<string, string>): string {
  const columns = index.definition.columns
    .map((name) => `columns.${fields.get(name) ?? name}`)
    .join(", ");
  let call = `index(${columns})`;
  if (index.definition.unique) call += ".unique()";
  const sqlName = customIndexName(index);
  if (sqlName !== undefined) call += `.name(${JSON.stringify(sqlName)})`;
  const extra: string[] = [];
  if (index.definition.predicate !== undefined) {
    extra.push(`predicate: ${JSON.stringify(index.definition.predicate)}`);
  }
  if (index.definition.expression !== undefined) {
    extra.push(`expression: ${JSON.stringify(index.definition.expression)}`);
  }
  if (extra.length === 0) return call;
  return `{ ...${call}, ${extra.join(", ")} }`;
}

/**
 * The database name when it is not `{table}_{columns}_idx`.
 *
 * Pull omits `.name()` for the generated spelling so a default index stays
 * `index(columns.field)`. `schema()` then stores the same name introspection
 * read, and baseline has nothing to reconcile.
 */
function customIndexName(index: IndexObject): string | undefined {
  const expected = deterministicName({
    parent: index.identity.parent.name,
    purpose: "index",
    nameKey: index.definition.columns.join("_"),
  });
  return index.identity.name === expected ? undefined : index.identity.name;
}

function plainConstraint(constraint: ConstraintObject): boolean {
  return (
    !constraint.definition.deferrable &&
    constraint.definition.initially === "immediate" &&
    !constraint.definition.nullsNotDistinct
  );
}

function skipChildren(
  table: string,
  byParent: ReadonlyMap<string, ParentBag>,
  statements: readonly string[],
  skipped: PullSkip[],
): void {
  const bag = byParent.get(table);
  if (bag === undefined) return;
  for (const column of bag.columns) {
    skipped.push(
      skip(
        column,
        "column",
        `${table}.${column.identity.name}`,
        "the table is partitioned, and table() has no partition option",
        "",
      ),
    );
  }
  for (const constraint of bag.constraints) {
    skipped.push(
      skip(
        constraint,
        "constraint",
        `${table}.${constraint.identity.name}`,
        "the table is partitioned, and table() has no partition option",
        statementFor(statements, constraint.identity.name),
      ),
    );
  }
  for (const index of bag.indexes) {
    skipped.push(
      skip(
        index,
        "index",
        `${table}.${index.identity.name}`,
        "the table is partitioned, and table() has no partition option",
        statementFor(statements, index.identity.name),
      ),
    );
  }
  for (const sequence of bag.sequences) {
    skipped.push(
      skip(
        sequence,
        "sequence",
        sequence.identity.name,
        "the owning table is partitioned, and table() has no partition option",
        statementFor(statements, sequence.identity.name),
      ),
    );
  }
}

function identitySequence(table: string, column: string): string {
  return `${table}_${column}_seq`;
}

function schemaText(
  schemaFile: string,
  imports: readonly { readonly name: string; readonly file: string }[],
  extensions: readonly string[],
  routines: {
    readonly imports: readonly string[];
    readonly body: string;
    readonly functions: readonly string[];
    readonly triggers: readonly string[];
    readonly views: readonly string[];
  },
  importExt: PullImportExt,
): string {
  const lines = ['import { schema } from "okmodel/pg";'];
  if (extensions.length > 0) lines.push('import { extension } from "okmodel/ext";');
  for (const line of routines.imports) lines.push(line);
  const sorted = [...imports].sort((left, right) => compare(left.name, right.name));
  for (const item of sorted) {
    lines.push(
      `import { ${item.name} } from ${JSON.stringify(importSpecifier(schemaFile, item.file, importExt))};`,
    );
  }
  const tables = sorted.map((item) => item.name).join(", ");
  const extensionBlock =
    extensions.length === 0
      ? ""
      : `,
  extensions: [
${extensions.map((call) => `    ${call},`).join("\n")}
  ]`;
  const functionBlock =
    routines.functions.length === 0
      ? ""
      : `,
  functions: [${routines.functions.join(", ")}]`;
  const triggerBlock =
    routines.triggers.length === 0
      ? ""
      : `,
  triggers: [${routines.triggers.join(", ")}]`;
  const viewBlock =
    routines.views.length === 0
      ? ""
      : `,
  views: [${routines.views.join(", ")}]`;
  const body = routines.body.length === 0 ? "" : `\n${routines.body}`;
  return `${lines.join("\n")}
${body}
export default schema({
  tables: [${tables}]${extensionBlock}${functionBlock}${triggerBlock}${viewBlock},
});
`;
}

function extensionCalls(source: Catalog): string[] {
  const calls: string[] = [];
  for (const object of source.objects) {
    if (object.kind !== "extension") continue;
    const options: string[] = [`schema: ${JSON.stringify(object.definition.schema)}`];
    if (object.definition.version !== undefined) {
      options.push(`version: ${JSON.stringify(object.definition.version)}`);
    }
    options.push(`relocatable: ${object.definition.relocatable ? "true" : "false"}`);
    calls.push(`extension(${JSON.stringify(object.identity.name)}, { ${options.join(", ")} })`);
  }
  calls.sort();
  return calls;
}

function importLine(needsTable: boolean, needsIndex: boolean, needsSql: boolean): string {
  const names = ["t"];
  if (needsIndex) names.push("index");
  if (needsSql) names.push("sql");
  if (needsTable) names.push("table");
  names.sort();
  return `import { ${names.join(", ")} } from "okmodel/pg";`;
}

/**
 * Relative import path from one pulled file to another, including the `.ts`
 * extension so Node type stripping and `bunx okm` can resolve the module.
 *
 * @param fromFile - Absolute path of the importing file
 * @param toFile - Absolute path of the imported file
 * @param importExt - `ts` keeps `.ts`. `js` rewrites it to `.js`. `none` drops it
 * @returns A relative specifier that starts with `.`
 */
function importSpecifier(fromFile: string, toFile: string, importExt: PullImportExt): string {
  let spec = relative(dirname(fromFile), toFile).replaceAll("\\", "/");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  if (importExt === "js") return spec.slice(0, -".ts".length) + ".js";
  if (importExt === "none") return spec.slice(0, -".ts".length);
  return spec;
}

function groupByParent(source: Catalog): Map<string, ParentBag> {
  const map = new Map<string, ParentBag>();
  const ensure = (name: string): ParentBag => {
    const found = map.get(name);
    if (found !== undefined) return found;
    const bag: ParentBag = { columns: [], constraints: [], indexes: [], sequences: [] };
    map.set(name, bag);
    return bag;
  };
  for (const object of source.objects) {
    if (object.kind === "column" || object.kind === "constraint" || object.kind === "index") {
      const bag = ensure(object.identity.parent.name);
      if (object.kind === "column") bag.columns.push(object);
      else if (object.kind === "constraint") bag.constraints.push(object);
      else bag.indexes.push(object);
      continue;
    }
    if (object.kind === "sequence") {
      const owned = object.dependencies.find((edge) => edge.target.kind === "table");
      if (owned === undefined || owned.target.kind !== "table") continue;
      ensure(owned.target.name).sequences.push(object);
    }
  }
  return map;
}

function enumLabels(source: Catalog): Map<string, readonly string[]> {
  const labels = new Map<string, readonly string[]>();
  for (const object of source.objects) {
    if (object.kind !== "type" || isDomain(object.definition)) continue;
    labels.set(object.identity.name, object.definition.labels);
  }
  return labels;
}

function domainDefs(
  source: Catalog,
): Map<string, { readonly base: string; readonly check: string }> {
  const domains = new Map<string, { readonly base: string; readonly check: string }>();
  for (const object of source.objects) {
    if (object.kind !== "type" || !isDomain(object.definition)) continue;
    domains.set(object.identity.name, {
      base: object.definition.base,
      check: object.definition.check,
    });
  }
  return domains;
}

function typeIsUsed(name: string, source: Catalog, skipped: readonly PullSkip[]): boolean {
  const skippedKeys = new Set(skipped.map((item) => item.key));
  for (const object of source.objects) {
    if (object.kind !== "column") continue;
    if (skippedKeys.has(identityKey(object.identity))) continue;
    if (object.definition.dataType === name) return true;
    if (
      object.dependencies.some((edge) => edge.target.kind === "type" && edge.target.name === name)
    ) {
      return true;
    }
  }
  return false;
}

function rendered(source: Catalog): readonly string[] {
  try {
    return renderCatalog(source, "public");
  } catch {
    return [];
  }
}

function statementFor(statements: readonly string[], name: string): string {
  if (name.length === 0) return "";
  const quoted = `"${name.replaceAll('"', '""')}"`;
  return statements.find((statement) => statement.includes(quoted)) ?? "";
}

function skip(
  object: CatalogObject,
  kind: string,
  label: string,
  reason: string,
  sql: string,
): PullSkip {
  return { key: identityKey(object.identity), kind, label, reason, sql };
}

function isDeferred(kind: string): boolean {
  return DEFERRED.some((item) => item.kind === kind);
}

function deferredReason(kind: string): string {
  return DEFERRED.find((item) => item.kind === kind)?.reason ?? "a later step writes this object";
}

function kindLabel(kind: string): string {
  if (kind === "materializedView") return "materialized views";
  if (kind === "defaultPrivilege") return "default privileges";
  if (kind === "eventTrigger") return "event triggers";
  if (kind === "policy") return "policies";
  if (kind === "rowLevelSecurity") return "row level security";
  if (kind.endsWith("s")) return kind;
  return `${kind}s`;
}

const ROW_LEVEL_REASON = "pull does not write enable or force row level security";

/**
 * One enable line per table that has a policy, and a force line when any of
 * those policies recorded `FORCE ROW LEVEL SECURITY`.
 *
 * Introspection stores both facts on the policy. The files do not, so check
 * after baseline must not be the first place the operator hears about them.
 * Keys are not catalog identities: `skippedKeys` must not treat a column as
 * skipped because it shares a name with this note.
 */
function appendRowLevelSecurity(source: Catalog, skipped: PullSkip[]): void {
  const tables = new Map<string, { schema: string; force: boolean }>();
  for (const object of source.objects) {
    if (object.kind !== "policy") continue;
    const namespace = object.identity.parent.namespace;
    const schema = namespace.form === "static" ? namespace.name : "public";
    const name = object.identity.parent.name;
    const current = tables.get(`${schema}\0${name}`);
    if (current === undefined) {
      tables.set(`${schema}\0${name}`, { schema, force: object.definition.force });
    } else if (object.definition.force) {
      current.force = true;
    }
  }
  for (const [key, info] of tables) {
    const name = key.slice(info.schema.length + 1);
    const table = qualify(info.schema, name);
    skipped.push({
      key: `row-level-security\0${info.schema}\0${name}\0enable`,
      kind: "rowLevelSecurity",
      label: `${name} enable`,
      reason: ROW_LEVEL_REASON,
      sql: `alter table ${table} enable row level security`,
    });
    if (!info.force) continue;
    skipped.push({
      key: `row-level-security\0${info.schema}\0${name}\0force`,
      kind: "rowLevelSecurity",
      label: `${name} force`,
      reason: ROW_LEVEL_REASON,
      sql: `alter table ${table} force row level security`,
    });
  }
}

function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function objectLabel(object: CatalogObject): string {
  if ("name" in object.identity && typeof object.identity.name === "string") {
    if ("parent" in object.identity)
      return `${object.identity.parent.name}.${object.identity.name}`;
    return object.identity.name;
  }
  return object.kind;
}

function objectName(object: CatalogObject): string {
  if ("name" in object.identity && typeof object.identity.name === "string")
    return object.identity.name;
  return "";
}

/**
 * Windows device stems (any case). A file named `con.ts` is refused on NTFS.
 * Comparison is lowercase-folded; the written stem keeps its original case
 * after a stable `_` prefix when the bare stem is reserved.
 */
const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * One table file stem: case-insensitive unique, never a Windows reserved name.
 *
 * `used` stores lowercase-folded stems so `Tasks` and `tasks` cannot share a
 * path on a case-insensitive volume. The same database always yields the same
 * stems: tables are sorted by SQL name before this runs, and the suffix is
 * deterministic (`_2`, `_3`, …).
 *
 * @param name - Export binding that would become the stem
 * @param used - Folded stems already taken
 * @returns The stem to write (without `.ts`)
 */
function uniqueFile(name: string, used: Set<string>): string {
  const base = reservedFileStem(name);
  let file = base;
  let salt = 2;
  while (used.has(file.toLowerCase())) {
    file = `${base}_${String(salt)}`;
    salt += 1;
  }
  used.add(file.toLowerCase());
  return file;
}

function reservedFileStem(name: string): string {
  return WINDOWS_RESERVED.has(name.toLowerCase()) ? `_${name}` : name;
}

/**
 * SQL table name to the binding `table()` writes.
 *
 * A partitioned table is omitted. The binding matches the table file.
 *
 * @param source - Introspected catalog
 * @returns Bindings for tables this step writes
 */
export function tableExportNames(source: Catalog): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const object of source.objects) {
    if (object.kind !== "table" || object.definition.partition !== undefined) continue;
    names.set(
      object.identity.name,
      freshIdent(declaredIdent(object.provenance.source, object.identity.name), used),
    );
  }
  return names;
}

function exportNameOf(name: string): string {
  return freshIdent(name, new Set());
}

/**
 * TypeScript name stored on provenance, or the SQL name.
 *
 * `okm import drizzle` sets `field:<property>` and `export:<binding>`.
 * Introspection leaves `source` unset, so `okm pull` keeps the SQL name.
 *
 * @param source - Provenance source, when the author recorded one
 * @param fallback - SQL name
 * @returns The name to sanitize into an identifier
 */
function declaredIdent(source: string | undefined, fallback: string): string {
  if (source === undefined) return fallback;
  const field = prefixed(source, "field:");
  if (field !== undefined) return field;
  const exported = prefixed(source, "export:");
  if (exported !== undefined) return exported;
  return fallback;
}

function prefixed(source: string, prefix: string): string | undefined {
  if (!source.startsWith(prefix)) return undefined;
  const name = source.slice(prefix.length);
  return name.length > 0 ? name : undefined;
}

function freshIdent(sql: string, used: Set<string>): string {
  const base = avoidImportBinding(jsIdent(sql));
  let name = base;
  let salt = 2;
  // Folded so `Tasks` and `tasks` cannot share a binding (row types collide).
  while (used.has(name.toLowerCase())) {
    name = `${base}_${String(salt)}`;
    salt += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function jsIdent(sql: string): string {
  let out = "";
  for (const char of sql) {
    const ok =
      (char >= "A" && char <= "Z") ||
      (char >= "a" && char <= "z") ||
      (char >= "0" && char <= "9") ||
      char === "_";
    out += ok ? char : "_";
  }
  if (out.length === 0) out = "table";
  const first = out[0] ?? "";
  if (first >= "0" && first <= "9") out = `t_${out}`;
  if (RESERVED.has(out)) out = `${out}Name`;
  return out;
}

function jsKey(name: string): string {
  if (name === "__proto__") return '["__proto__"]';
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !RESERVED.has(name)) return name;
  return JSON.stringify(name);
}

function sqlTemplate(expression: string): string {
  const body = expression.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
  return `sql\`${body}\``;
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
