/**
 * Random catalog pairs for the migration property test.
 *
 * Every pair starts from one catalog that already contains a table, columns,
 * an index, a check, a generated column, an expression index, a domain, a
 * partitioned table, a view, a plpgsql function, a SQL function, and a trigger.
 * Mutations may add or change a policy, a materialized view, a sequence, or an
 * extension. Renames are not guessed here; the recreate test declares them.
 *
 * `OKM_MIGRATION_CASES` sets how many seeds {@link PROPERTY_SEEDS} contains.
 * The default is 100, which is what `bun run check` runs. A larger run sets
 * the variable (the recorded 500-case run uses `500`).
 */

import { identityKey } from "../catalog/canonical.js";
import {
  staticNamespace,
  type CatalogObject,
  type NamespaceName,
  type Provenance,
} from "../catalog/object.js";
import { quoteIdent } from "../catalog/sql.js";
import { type ColumnRename } from "./diff.js";

const provenance: Provenance = { source: "migration-spike" };

/** Partition shape of the `events` table. */
export type PartitionStyle = "range-int" | "range-ts" | "list" | "hash";

type ColumnSpec = {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly defaultSql?: string;
  readonly generatedSql?: string;
};

type IndexSpec = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly expression?: string;
  readonly unique: boolean;
};

type CheckSpec = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly expression: string;
};

type TableSpec = {
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
  readonly primaryKey: readonly string[];
  readonly indexes: readonly IndexSpec[];
  readonly checks: readonly CheckSpec[];
  readonly rowSecurity?: boolean;
  readonly partition?: {
    readonly method: "range" | "list" | "hash";
    readonly columns: readonly string[];
    readonly parts: readonly {
      readonly name: string;
      readonly from: string;
      readonly to: string;
      readonly values?: readonly string[];
      readonly modulus?: number;
      readonly remainder?: number;
    }[];
  };
  readonly foreignKey?: {
    readonly name: string;
    readonly columns: readonly string[];
    readonly refTable: string;
    readonly refColumns: readonly string[];
  };
};

type Spec = {
  readonly domains: readonly { readonly name: string; readonly checkSql: string }[];
  readonly tables: readonly TableSpec[];
  readonly views: readonly {
    readonly name: string;
    readonly columns: readonly string[];
    readonly sql: string;
    readonly dependsOn: readonly string[];
  }[];
  readonly functions: readonly {
    readonly name: string;
    readonly args: readonly { readonly name: string; readonly type: string }[];
    readonly returns: string;
    readonly language: "sql" | "plpgsql";
    readonly volatility: "immutable" | "stable" | "volatile";
    readonly bodyStyle: "string" | "return" | "atomic";
    readonly body: string;
    readonly dependsOn: readonly string[];
  }[];
  readonly triggers: readonly {
    readonly name: string;
    readonly table: string;
    readonly fn: string;
  }[];
  readonly eventsStyle: PartitionStyle;
  readonly rankDefault: string;
  readonly checkExpression: string;
  readonly viewWhere: string;
  readonly countBody: "star" | "id";
  readonly domainCheck: string;
  readonly includeNotes: boolean;
  readonly includeRankIndex: boolean;
  readonly includeKind: boolean;
  readonly includeNote: boolean;
  readonly includePolicy: boolean;
  readonly policyUsing: string;
  readonly includeMatview: boolean;
  readonly matviewWhere: string;
  readonly includeSequence: boolean;
  readonly sequenceIncrement: string;
  readonly extension: string | undefined;
};

/** Extensions the property test may install. Empty means none are available. */
export type MigrationOptions = {
  readonly extensions?: readonly string[];
};

/** A pair the property test applies. */
export type MigrationPair = {
  readonly seed: number;
  readonly before: readonly CatalogObject[];
  readonly after: readonly CatalogObject[];
  readonly renames: readonly ColumnRename[];
};

/**
 * How many property seeds to run.
 *
 * Unset or blank is 100. `OKM_MIGRATION_CASES` must be a positive integer.
 *
 * @returns The case count
 */
export function propertyCaseCount(): number {
  const raw = process.env.OKM_MIGRATION_CASES;
  if (raw === undefined || raw.trim() === "") return 100;
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    throw new Error(`OKM_MIGRATION_CASES must be a positive integer, got ${raw}.`);
  }
  return Number(raw.trim());
}

/**
 * Seeds `1..count` for the property test.
 *
 * @param count - How many seeds. Defaults to {@link propertyCaseCount}
 * @returns Seed numbers
 */
export function propertySeeds(count: number = propertyCaseCount()): readonly number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

/** Seeds the property test runs. One hundred pairs unless `OKM_MIGRATION_CASES` is set. */
export const PROPERTY_SEEDS = propertySeeds();

/**
 * Builds catalog A and catalog B for one seed.
 *
 * @param seed - Deterministic seed
 * @param options - Extensions the database can install. Omit when none are available
 * @returns Both catalogs in the `app` namespace
 */
export function migrationPair(seed: number, options: MigrationOptions = {}): MigrationPair {
  const extensions = options.extensions ?? [];
  const before = template();
  let after = template();
  const random = mulberry32(seed);
  const count = 1 + Math.floor(random() * 3);
  const start = Math.floor(random() * MUTATIONS.length);
  for (let index = 0; index < count; index += 1) {
    const mutation = MUTATIONS[(start + index) % MUTATIONS.length];
    if (mutation === undefined) continue;
    after = mutation(after, seed + index, extensions);
  }
  if (
    identityKeyList(buildCatalog(before)) === identityKeyList(buildCatalog(after)) &&
    sameBodies(before, after)
  ) {
    after = addNote(after);
  }
  return {
    seed,
    before: buildCatalog(before),
    after: buildCatalog(after),
    renames: [],
  };
}

/**
 * Column type change that forces dependents to be recreated.
 *
 * @param namespace - Logical namespace
 * @returns Before and after catalogs. `rank` moves from int8 to int4
 */
export function typeChangePair(namespace: NamespaceName = staticNamespace("app")): {
  readonly before: readonly CatalogObject[];
  readonly after: readonly CatalogObject[];
} {
  return {
    before: buildSpec(shapeSpec("rank", "int8"), namespace),
    after: buildSpec(shapeSpec("rank", "int4"), namespace),
  };
}

/**
 * Declared rename of `title` to `name`, with dependents rewritten.
 *
 * @param namespace - Logical namespace
 * @returns Both catalogs and the declaration the planner requires
 */
export function renamePair(namespace: NamespaceName = staticNamespace("app")): {
  readonly before: readonly CatalogObject[];
  readonly after: readonly CatalogObject[];
  readonly renames: readonly ColumnRename[];
} {
  return {
    before: buildSpec(renameSpec("title"), namespace),
    after: buildSpec(renameSpec("name"), namespace),
    renames: [{ namespace: namespace.name, parent: "tasks", from: "title", to: "name" }],
  };
}

/**
 * A plpgsql function that reads `tasks`.
 *
 * When the dependency is declared, the target catalog drops the function with
 * the table. When it is missing, the function stays in the catalog and the
 * plan drops only the table.
 *
 * @param declared - When true, the function depends on the table
 * @param namespace - Logical namespace
 * @returns The applied catalog and the catalog the plan aims at
 */
export function dependencyPair(
  declared: boolean,
  namespace: NamespaceName = staticNamespace("app"),
): { readonly before: readonly CatalogObject[]; readonly after: readonly CatalogObject[] } {
  const before = buildSpec(dependencySpec(declared), namespace);
  const after = before.filter((object) => {
    if (object.identity.name === "tasks" || parentName(object) === "tasks") return false;
    if (declared && object.identity.name === "task_rows") return false;
    return true;
  });
  return { before, after };
}

function parentName(object: CatalogObject): string | undefined {
  if (
    object.kind === "column" ||
    object.kind === "index" ||
    object.kind === "constraint" ||
    object.kind === "trigger" ||
    object.kind === "policy" ||
    object.kind === "partition"
  ) {
    return object.identity.parent;
  }
  return undefined;
}

function template(): Spec {
  return {
    domains: [{ name: "posint", checkSql: "value > 0" }],
    tables: [],
    views: [],
    functions: [],
    triggers: [],
    eventsStyle: "range-int",
    rankDefault: "0",
    checkExpression: "id > 0",
    viewWhere: '"id" > 0',
    countBody: "star",
    domainCheck: "value > 0",
    includeNotes: false,
    includeRankIndex: false,
    includeKind: true,
    includeNote: false,
    includePolicy: false,
    policyUsing: "true",
    includeMatview: false,
    matviewWhere: '"id" > 0',
    includeSequence: false,
    sequenceIncrement: "1",
    extension: undefined,
  };
}

const MUTATIONS: readonly ((spec: Spec, seed: number, extensions: readonly string[]) => Spec)[] = [
  addNote,
  dropKind,
  flipDefault,
  addRankIndex,
  dropRankIndex,
  flipCheck,
  flipView,
  flipCount,
  flipDomain,
  cyclePartition,
  addNotes,
  dropNotes,
  addPolicy,
  dropPolicy,
  flipPolicy,
  addMatview,
  dropMatview,
  flipMatview,
  addSequence,
  dropSequence,
  flipSequence,
  addExtension,
  dropExtension,
];

function addNote(spec: Spec): Spec {
  if (spec.includeNote) return spec;
  return { ...spec, includeNote: true };
}

function dropKind(spec: Spec): Spec {
  if (!spec.includeKind) return spec;
  return { ...spec, includeKind: false };
}

function flipDefault(spec: Spec): Spec {
  return { ...spec, rankDefault: spec.rankDefault === "0" ? "1" : "0" };
}

function addRankIndex(spec: Spec): Spec {
  return { ...spec, includeRankIndex: true };
}

function dropRankIndex(spec: Spec): Spec {
  return { ...spec, includeRankIndex: false };
}

function flipCheck(spec: Spec): Spec {
  return { ...spec, checkExpression: spec.checkExpression === "id > 0" ? "id > 1" : "id > 0" };
}

function flipView(spec: Spec): Spec {
  return { ...spec, viewWhere: spec.viewWhere === '"id" > 0' ? '"id" > 1' : '"id" > 0' };
}

function flipCount(spec: Spec): Spec {
  return { ...spec, countBody: spec.countBody === "star" ? "id" : "star" };
}

function flipDomain(spec: Spec): Spec {
  return { ...spec, domainCheck: spec.domainCheck === "value > 0" ? "value > 1" : "value > 0" };
}

function cyclePartition(spec: Spec, seed: number): Spec {
  const styles: readonly PartitionStyle[] = ["range-int", "range-ts", "list", "hash"];
  const index = styles.indexOf(spec.eventsStyle);
  const next = styles[(index + 1 + (seed % 3)) % styles.length] ?? "list";
  return { ...spec, eventsStyle: next };
}

function addNotes(spec: Spec): Spec {
  return { ...spec, includeNotes: true };
}

function dropNotes(spec: Spec): Spec {
  return { ...spec, includeNotes: false };
}

function addPolicy(spec: Spec): Spec {
  if (spec.includePolicy) return spec;
  return { ...spec, includePolicy: true, policyUsing: "true" };
}

function dropPolicy(spec: Spec): Spec {
  if (!spec.includePolicy) return spec;
  return { ...spec, includePolicy: false };
}

function flipPolicy(spec: Spec): Spec {
  if (!spec.includePolicy) return { ...spec, includePolicy: true, policyUsing: "id > 0" };
  return { ...spec, policyUsing: spec.policyUsing === "true" ? "id > 0" : "true" };
}

function addMatview(spec: Spec): Spec {
  if (spec.includeMatview) return spec;
  return { ...spec, includeMatview: true };
}

function dropMatview(spec: Spec): Spec {
  if (!spec.includeMatview) return spec;
  return { ...spec, includeMatview: false };
}

function flipMatview(spec: Spec): Spec {
  if (!spec.includeMatview) return { ...spec, includeMatview: true, matviewWhere: '"id" > 1' };
  return { ...spec, matviewWhere: spec.matviewWhere === '"id" > 0' ? '"id" > 1' : '"id" > 0' };
}

function addSequence(spec: Spec): Spec {
  if (spec.includeSequence) return spec;
  return { ...spec, includeSequence: true, sequenceIncrement: "1" };
}

function dropSequence(spec: Spec): Spec {
  if (!spec.includeSequence) return spec;
  return { ...spec, includeSequence: false };
}

function flipSequence(spec: Spec): Spec {
  if (!spec.includeSequence) return { ...spec, includeSequence: true, sequenceIncrement: "2" };
  return { ...spec, sequenceIncrement: spec.sequenceIncrement === "1" ? "2" : "1" };
}

function addExtension(spec: Spec, seed: number, extensions: readonly string[]): Spec {
  if (spec.extension !== undefined || extensions.length === 0) return spec;
  const name = extensions[Math.abs(seed) % extensions.length];
  if (name === undefined) return spec;
  return { ...spec, extension: name };
}

function dropExtension(spec: Spec): Spec {
  if (spec.extension === undefined) return spec;
  return { ...spec, extension: undefined };
}

function buildCatalog(
  spec: Spec,
  namespace: NamespaceName = staticNamespace("app"),
): readonly CatalogObject[] {
  const filled: Spec = {
    ...spec,
    domains: [{ name: "posint", checkSql: spec.domainCheck }],
    tables: tablesFor(spec),
    views: [
      {
        name: "active_tasks",
        columns: ["id", "title"],
        sql: `select "id", "title" from ${qualified(namespace, "tasks")} where ${spec.viewWhere}`,
        dependsOn: ["tasks", "tasks.id", "tasks.title"],
      },
    ],
    functions: [
      {
        name: "touch",
        args: [],
        returns: "trigger",
        language: "plpgsql",
        volatility: "volatile",
        bodyStyle: "string",
        body: `begin\n  perform 1 from ${qualified(namespace, "tasks")} where id = new.id;\n  return new;\nend`,
        dependsOn: ["tasks"],
      },
      {
        name: "task_count",
        args: [],
        returns: "int8",
        language: "sql",
        volatility: "stable",
        bodyStyle: "atomic",
        body:
          spec.countBody === "star"
            ? `select count(*)::int8 from ${qualified(namespace, "tasks")};`
            : `select count("id")::int8 from ${qualified(namespace, "tasks")};`,
        dependsOn: ["tasks"],
      },
    ],
    triggers: [{ name: "tasks_touch", table: "tasks", fn: "touch" }],
    includePolicy: spec.includePolicy,
    policyUsing: spec.policyUsing,
    includeMatview: spec.includeMatview,
    matviewWhere: spec.matviewWhere,
    includeSequence: spec.includeSequence,
    sequenceIncrement: spec.sequenceIncrement,
    extension: spec.extension,
  };
  return buildSpec(filled, namespace);
}

function tablesFor(spec: Spec): readonly TableSpec[] {
  const columns: ColumnSpec[] = [
    { name: "id", type: "int8", nullable: false },
    { name: "title", type: "text", nullable: false },
    { name: "rank", type: "int8", nullable: false, defaultSql: spec.rankDefault },
    { name: "score", type: "int8", nullable: false, generatedSql: "rank + 1" },
  ];
  if (spec.includeKind) columns.push({ name: "kind", type: "posint", nullable: true });
  if (spec.includeNote) columns.push({ name: "note", type: "text", nullable: true });
  const indexes: IndexSpec[] = [
    { name: "tasks_title_idx", columns: ["title"], unique: false },
    { name: "tasks_title_lower_idx", columns: [], expression: "lower(title)", unique: false },
  ];
  if (spec.includeRankIndex) {
    indexes.push({ name: "tasks_rank_idx", columns: ["rank"], unique: false });
  }
  const tables: TableSpec[] = [
    {
      name: "tasks",
      columns,
      primaryKey: ["id"],
      indexes,
      checks: [{ name: "tasks_id_check", columns: ["id"], expression: spec.checkExpression }],
      rowSecurity: spec.includePolicy,
    },
    eventsTable(spec.eventsStyle),
  ];
  if (spec.includeNotes) {
    tables.push({
      name: "notes",
      columns: [
        { name: "id", type: "int8", nullable: false },
        { name: "task_id", type: "int8", nullable: false },
      ],
      primaryKey: ["id"],
      indexes: [],
      checks: [],
      foreignKey: {
        name: "notes_task_fkey",
        columns: ["task_id"],
        refTable: "tasks",
        refColumns: ["id"],
      },
    });
  }
  return tables;
}

function eventsTable(style: PartitionStyle): TableSpec {
  if (style === "range-ts") {
    return {
      name: "events",
      columns: [
        { name: "occurred", type: "timestamptz", nullable: false },
        { name: "label", type: "text", nullable: false },
      ],
      primaryKey: ["occurred"],
      indexes: [],
      checks: [],
      partition: {
        method: "range",
        columns: ["occurred"],
        parts: [
          {
            name: "events_y2020",
            from: "2020-01-01 00:00:00+00",
            to: "2021-01-01 00:00:00+00",
          },
          {
            name: "events_y2021",
            from: "2021-01-01 00:00:00+00",
            to: "2022-01-01 00:00:00+00",
          },
        ],
      },
    };
  }
  if (style === "list") {
    return {
      name: "events",
      columns: [
        { name: "kind", type: "int4", nullable: false },
        { name: "label", type: "text", nullable: false },
      ],
      primaryKey: ["kind"],
      indexes: [],
      checks: [],
      partition: {
        method: "list",
        columns: ["kind"],
        parts: [
          { name: "events_a", from: "", to: "", values: ["1"] },
          { name: "events_b", from: "", to: "", values: ["2"] },
        ],
      },
    };
  }
  if (style === "hash") {
    return {
      name: "events",
      columns: [
        { name: "id", type: "int8", nullable: false },
        { name: "label", type: "text", nullable: false },
      ],
      primaryKey: ["id"],
      indexes: [],
      checks: [],
      partition: {
        method: "hash",
        columns: ["id"],
        parts: [
          { name: "events_h0", from: "", to: "", modulus: 2, remainder: 0 },
          { name: "events_h1", from: "", to: "", modulus: 2, remainder: 1 },
        ],
      },
    };
  }
  return {
    name: "events",
    columns: [
      { name: "id", type: "int8", nullable: false },
      { name: "label", type: "text", nullable: false },
    ],
    primaryKey: ["id"],
    indexes: [],
    checks: [],
    partition: {
      method: "range",
      columns: ["id"],
      parts: [
        { name: "events_low", from: "0", to: "100" },
        { name: "events_high", from: "100", to: "1000" },
      ],
    },
  };
}

function shapeSpec(column: string, type: string): Spec {
  const spec = template();
  return {
    ...spec,
    includeKind: false,
    domains: [],
    tables: [
      {
        name: "tasks",
        columns: [
          { name: "id", type: "int8", nullable: false },
          { name: "title", type: "text", nullable: false },
          { name: column, type, nullable: false, defaultSql: "0" },
        ],
        primaryKey: ["id"],
        indexes: [{ name: "tasks_rank_idx", columns: [column], unique: false }],
        checks: [{ name: "tasks_rank_check", columns: [column], expression: `${column} > 0` }],
      },
    ],
    views: [
      {
        name: "ranks",
        columns: [column],
        sql: `select ${quoteIdent(column)} from ${qualified(staticNamespace("app"), "tasks")}`,
        dependsOn: ["tasks", `tasks.${column}`],
      },
    ],
    functions: [],
    triggers: [],
  };
}

function renameSpec(column: string): Spec {
  const spec = template();
  return {
    ...spec,
    includeKind: false,
    domains: [],
    tables: [
      {
        name: "tasks",
        columns: [
          { name: "id", type: "int8", nullable: false },
          { name: column, type: "text", nullable: false },
        ],
        primaryKey: ["id"],
        indexes: [{ name: "tasks_title_idx", columns: [column], unique: false }],
        checks: [
          {
            name: "tasks_title_check",
            columns: [column],
            expression: `${column} <> ''`,
          },
        ],
      },
    ],
    views: [
      {
        name: "titles",
        columns: [column],
        sql: `select ${quoteIdent(column)} from ${qualified(staticNamespace("app"), "tasks")}`,
        dependsOn: ["tasks", `tasks.${column}`],
      },
    ],
    functions: [],
    triggers: [],
  };
}

function dependencySpec(declared: boolean): Spec {
  const spec = template();
  return {
    ...spec,
    includeKind: false,
    domains: [],
    tables: [
      {
        name: "tasks",
        columns: [
          { name: "id", type: "int8", nullable: false },
          { name: "title", type: "text", nullable: false },
        ],
        primaryKey: ["id"],
        indexes: [],
        checks: [],
      },
    ],
    views: [],
    functions: [
      {
        name: "task_rows",
        args: [],
        returns: "int8",
        language: "plpgsql",
        volatility: "stable",
        bodyStyle: "string",
        body: "",
        dependsOn: declared ? ["tasks"] : [],
      },
    ],
    triggers: [],
  };
}

function buildSpec(spec: Spec, namespace: NamespaceName): readonly CatalogObject[] {
  const objects: CatalogObject[] = [];
  const domainNames = new Set(spec.domains.map((domain) => domain.name));
  for (const domain of spec.domains) {
    objects.push({
      kind: "domain",
      identity: { kind: "domain", namespace, name: domain.name },
      owner: "managed",
      definition: { baseType: "int8", notNull: false, checkSql: domain.checkSql },
      dependencies: [],
      provenance,
    });
  }
  for (const table of spec.tables) {
    const domainDeps = table.columns
      .filter((column) => domainNames.has(column.type))
      .map((column) => ({ identity: { kind: "domain" as const, namespace, name: column.type } }));
    objects.push({
      kind: "table",
      identity: { kind: "table", namespace, name: table.name },
      owner: "managed",
      definition:
        table.partition === undefined
          ? { rowSecurity: table.rowSecurity === true }
          : {
              rowSecurity: table.rowSecurity === true,
              partitionBy: { method: table.partition.method, columns: table.partition.columns },
            },
      dependencies: domainDeps,
      provenance,
    });
    const tableIdentity = { kind: "table" as const, namespace, name: table.name };
    for (const column of table.columns) {
      const extra = domainNames.has(column.type)
        ? [{ identity: { kind: "domain" as const, namespace, name: column.type } }]
        : [];
      objects.push({
        kind: "column",
        identity: { kind: "column", namespace, parent: table.name, name: column.name },
        owner: "managed",
        definition: {
          type: column.type,
          nullable: column.nullable,
          ...(column.defaultSql === undefined ? {} : { defaultSql: column.defaultSql }),
          ...(column.generatedSql === undefined ? {} : { generatedSql: column.generatedSql }),
        },
        dependencies: [{ identity: tableIdentity }, ...extra],
        provenance,
      });
    }
    objects.push({
      kind: "constraint",
      identity: { kind: "constraint", namespace, parent: table.name, name: `${table.name}_pkey` },
      owner: "managed",
      definition: {
        constraintKind: "primary_key",
        columns: table.primaryKey,
        deferrable: false,
        initially: "immediate",
        nullsNotDistinct: false,
      },
      dependencies: [{ identity: tableIdentity }],
      provenance,
    });
    for (const check of table.checks) {
      objects.push({
        kind: "constraint",
        identity: { kind: "constraint", namespace, parent: table.name, name: check.name },
        owner: "managed",
        definition: {
          constraintKind: "check",
          columns: check.columns,
          expression: check.expression,
          deferrable: false,
          initially: "immediate",
          nullsNotDistinct: false,
        },
        dependencies: [
          { identity: tableIdentity },
          ...check.columns.map((column) => ({
            identity: { kind: "column" as const, namespace, parent: table.name, name: column },
          })),
        ],
        provenance,
      });
    }
    if (table.foreignKey !== undefined) {
      const foreignKey = table.foreignKey;
      objects.push({
        kind: "constraint",
        identity: { kind: "constraint", namespace, parent: table.name, name: foreignKey.name },
        owner: "managed",
        definition: {
          constraintKind: "foreign_key",
          columns: foreignKey.columns,
          references: { table: foreignKey.refTable, columns: foreignKey.refColumns },
          deferrable: false,
          initially: "immediate",
          nullsNotDistinct: false,
        },
        dependencies: [
          { identity: tableIdentity },
          { identity: { kind: "table", namespace, name: foreignKey.refTable } },
        ],
        provenance,
      });
    }
    for (const index of table.indexes) {
      objects.push({
        kind: "index",
        identity: { kind: "index", namespace, parent: table.name, name: index.name },
        owner: "managed",
        definition: {
          columns: index.columns,
          unique: index.unique,
          ...(index.expression === undefined ? {} : { expression: index.expression }),
        },
        dependencies: [
          { identity: tableIdentity },
          ...index.columns.map((column) => ({
            identity: { kind: "column" as const, namespace, parent: table.name, name: column },
          })),
        ],
        provenance,
      });
    }
    for (const part of table.partition?.parts ?? []) {
      objects.push({
        kind: "partition",
        identity: { kind: "partition", namespace, parent: table.name, name: part.name },
        owner: "managed",
        definition: {
          parent: table.name,
          from: part.from,
          to: part.to,
          method: table.partition?.method ?? "range",
          ...(part.values === undefined ? {} : { values: part.values }),
          ...(part.modulus === undefined ? {} : { modulus: part.modulus }),
          ...(part.remainder === undefined ? {} : { remainder: part.remainder }),
        },
        dependencies: [{ identity: tableIdentity }],
        provenance,
      });
    }
  }
  for (const fn of spec.functions) {
    objects.push({
      kind: "function",
      identity: {
        kind: "function",
        namespace,
        name: fn.name,
        argTypes: fn.args.map((arg) => arg.type),
      },
      owner: "managed",
      definition: {
        args: fn.args,
        returns: fn.returns,
        language: fn.language,
        volatility: fn.volatility,
        bodyStyle: fn.bodyStyle,
        body: fn.body === "" ? functionBody(fn.name, namespace) : fn.body,
      },
      dependencies: fn.dependsOn.map((target) => ({ identity: targetIdentity(namespace, target) })),
      provenance,
    });
  }
  for (const trigger of spec.triggers) {
    objects.push({
      kind: "trigger",
      identity: { kind: "trigger", namespace, parent: trigger.table, name: trigger.name },
      owner: "managed",
      definition: {
        timing: "before",
        events: ["update"],
        level: "row",
        function: trigger.fn,
        functionArgTypes: [],
      },
      dependencies: [
        { identity: { kind: "table", namespace, name: trigger.table } },
        { identity: { kind: "function", namespace, name: trigger.fn, argTypes: [] } },
      ],
      provenance,
    });
  }
  if (spec.includePolicy) {
    objects.push({
      kind: "policy",
      identity: { kind: "policy", namespace, parent: "tasks", name: "tasks_read" },
      owner: "managed",
      definition: {
        command: "select",
        permissive: true,
        using: spec.policyUsing,
        check: "",
      },
      dependencies: [{ identity: { kind: "table", namespace, name: "tasks" } }],
      provenance,
    });
  }
  if (spec.includeMatview) {
    objects.push({
      kind: "materialized_view",
      identity: { kind: "materialized_view", namespace, name: "task_titles" },
      owner: "managed",
      definition: {
        sql: `select "id", "title" from ${qualified(namespace, "tasks")} where ${spec.matviewWhere}`,
        columns: ["id", "title"],
        withData: false,
      },
      dependencies: [
        { identity: { kind: "table", namespace, name: "tasks" } },
        { identity: { kind: "column", namespace, parent: "tasks", name: "id" } },
        { identity: { kind: "column", namespace, parent: "tasks", name: "title" } },
      ],
      provenance,
    });
  }
  if (spec.includeSequence) {
    objects.push({
      kind: "sequence",
      identity: { kind: "sequence", namespace, name: "task_seq" },
      owner: "managed",
      definition: { dataType: "int8", start: "1", increment: spec.sequenceIncrement },
      dependencies: [],
      provenance,
    });
  }
  if (spec.extension !== undefined) {
    objects.push({
      kind: "extension",
      identity: { kind: "extension", name: spec.extension },
      owner: "managed",
      definition: { name: spec.extension },
      dependencies: [],
      provenance,
    });
  }
  for (const view of spec.views) {
    const sql = view.sql === "" ? `select "rank" from ${qualified(namespace, "tasks")}` : view.sql;
    objects.push({
      kind: "view",
      identity: { kind: "view", namespace, name: view.name },
      owner: "managed",
      definition: { sql, columns: view.columns },
      dependencies: view.dependsOn.map((target) => ({
        identity: targetIdentity(namespace, target),
      })),
      provenance,
    });
  }
  return objects;
}

function functionBody(name: string, namespace: NamespaceName): string {
  if (name === "task_rows") {
    return `begin\n  return (select count(*) from ${qualified(namespace, "tasks")});\nend`;
  }
  return "begin\n  return new;\nend";
}

function targetIdentity(namespace: NamespaceName, target: string): CatalogObject["identity"] {
  const [parent, column] = target.split(".");
  if (column !== undefined && parent !== undefined) {
    return { kind: "column", namespace, parent, name: column };
  }
  return { kind: "table", namespace, name: target };
}

function qualified(namespace: NamespaceName, name: string): string {
  return `${quoteIdent(namespace.name)}.${quoteIdent(name)}`;
}

function identityKeyList(objects: readonly CatalogObject[]): string {
  return objects
    .map((object) => identityKey(object.identity))
    .sort()
    .join("\n");
}

function sameBodies(left: Spec, right: Spec): boolean {
  return (
    left.rankDefault === right.rankDefault &&
    left.checkExpression === right.checkExpression &&
    left.viewWhere === right.viewWhere &&
    left.countBody === right.countBody &&
    left.domainCheck === right.domainCheck &&
    left.eventsStyle === right.eventsStyle &&
    left.includeNotes === right.includeNotes &&
    left.includeRankIndex === right.includeRankIndex &&
    left.includeKind === right.includeKind &&
    left.includeNote === right.includeNote &&
    left.includePolicy === right.includePolicy &&
    left.policyUsing === right.policyUsing &&
    left.includeMatview === right.includeMatview &&
    left.matviewWhere === right.matviewWhere &&
    left.includeSequence === right.includeSequence &&
    left.sequenceIncrement === right.sequenceIncrement &&
    left.extension === right.extension
  );
}

/**
 * Short description of how catalog B differs from catalog A.
 *
 * @param pair - One generated pair
 * @returns Added, removed, and changed objects
 */
export function describePair(pair: MigrationPair): string {
  const before = new Map(pair.before.map((object) => [identityKey(object.identity), object]));
  const after = new Map(pair.after.map((object) => [identityKey(object.identity), object]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, object] of after) {
    const prior = before.get(key);
    if (prior === undefined) added.push(labelOf(object));
    else if (JSON.stringify(prior.definition) !== JSON.stringify(object.definition)) {
      changed.push(labelOf(object));
    }
  }
  for (const [key, object] of before) {
    if (!after.has(key)) removed.push(labelOf(object));
  }
  return `added [${added.sort().join(", ")}]; removed [${removed.sort().join(", ")}]; changed [${changed.sort().join(", ")}]`;
}

function labelOf(object: CatalogObject): string {
  const parent = parentName(object);
  return parent === undefined
    ? `${object.kind} ${object.identity.name}`
    : `${object.kind} ${parent}.${object.identity.name}`;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
