/**
 * Deterministic schema fixtures.
 *
 * The neutral description is the source. Postgres DDL is rendered from it.
 * Later prompts turn the description into OKModel schemas.
 */

import { sha256 } from "../../../src/contracts/sha256.js";

/** Column types the generator mixes into every fixture. */
export const FIXTURE_COLUMN_TYPES = [
  "int4",
  "int8",
  "text",
  "bool",
  "timestamptz",
  "uuid",
  "numeric",
  "jsonb",
  "bytea",
  "float8",
] as const;

/** A Postgres column type the generator emits. */
export type FixtureColumnType = (typeof FIXTURE_COLUMN_TYPES)[number];

/** Table counts the generator produces. */
export const FIXTURE_SIZES = [10, 50, 200, 500] as const;

/** A supported fixture size. */
export type FixtureSize = (typeof FIXTURE_SIZES)[number];

/** `column` adds a non-null `tenant_id` to every table. */
export type FixtureTenancy = "none" | "column";

/** One column in the neutral description. */
export type FixtureColumn = {
  readonly name: string;
  readonly type: FixtureColumnType;
  readonly nullable: boolean;
};

/** A foreign key to an earlier table's primary key. */
export type FixtureForeignKey = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
};

/** A unique constraint. */
export type FixtureUnique = {
  readonly name: string;
  readonly columns: readonly string[];
};

/** A secondary index. */
export type FixtureIndex = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
};

/** One table in the neutral description. */
export type FixtureTable = {
  readonly name: string;
  readonly columns: readonly FixtureColumn[];
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly FixtureForeignKey[];
  readonly uniques: readonly FixtureUnique[];
  readonly indexes: readonly FixtureIndex[];
};

/** A seeded schema fixture. */
export type SchemaFixture = {
  readonly seed: number;
  readonly tableCount: number;
  readonly tenancy: FixtureTenancy;
  readonly tables: readonly FixtureTable[];
};

/**
 * Builds a schema fixture.
 *
 * The same seed, size, and tenancy always return the same description.
 * Tables only reference earlier tables, so the rendered DDL applies in order.
 *
 * @param options - Seed, size (10, 50, 200, or 500), and optional tenancy
 * @returns The neutral description
 */
export function generateFixture(options: {
  readonly seed: number;
  readonly tables: FixtureSize;
  readonly tenancy?: FixtureTenancy;
}): SchemaFixture {
  if (!(FIXTURE_SIZES as readonly number[]).includes(options.tables)) {
    throw new Error(`Fixture size must be one of ${FIXTURE_SIZES.join(", ")}.`);
  }
  if (!Number.isInteger(options.seed)) {
    throw new Error(`Fixture seed must be an integer, got ${String(options.seed)}.`);
  }
  const tenancy = options.tenancy ?? "none";
  const random = mulberry32(options.seed);
  const tables: FixtureTable[] = [];
  for (let index = 0; index < options.tables; index++) {
    tables.push(makeTable(index, tables, random, tenancy));
  }
  return { seed: options.seed, tableCount: options.tables, tenancy, tables };
}

/**
 * Renders Postgres DDL for a fixture.
 *
 * @param fixture - Neutral description from {@link generateFixture}
 * @returns SQL that creates the tables, keys, and indexes
 */
export function renderFixtureDdl(fixture: SchemaFixture): string {
  const lines: string[] = [];
  for (const table of fixture.tables) {
    const body = table.columns.map((column) => {
      const primary =
        table.primaryKey.length === 1 && table.primaryKey[0] === column.name ? " primary key" : "";
      const nullSql = column.nullable ? "" : " not null";
      return `  ${column.name} ${column.type}${primary}${nullSql}`;
    });
    lines.push(`create table ${table.name} (\n${body.join(",\n")}\n);`);
    for (const unique of table.uniques) {
      lines.push(
        `create unique index ${unique.name} on ${table.name} (${unique.columns.join(", ")});`,
      );
    }
    for (const index of table.indexes) {
      const kind = index.unique ? "unique index" : "index";
      lines.push(`create ${kind} ${index.name} on ${table.name} (${index.columns.join(", ")});`);
    }
    for (const foreignKey of table.foreignKeys) {
      lines.push(
        `alter table ${table.name} add constraint ${foreignKey.name} foreign key (${foreignKey.columns.join(", ")}) references ${foreignKey.refTable} (${foreignKey.refColumns.join(", ")});`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * SHA-256 of the canonical JSON description and the DDL.
 *
 * @param fixture - Neutral description
 * @param ddl - DDL from {@link renderFixtureDdl}
 * @returns Lowercase hex digest
 */
export function fixtureHash(fixture: SchemaFixture, ddl: string): string {
  return sha256(`${JSON.stringify(fixture)}\n${ddl}`);
}

function makeTable(
  index: number,
  previous: readonly FixtureTable[],
  random: () => number,
  tenancy: FixtureTenancy,
): FixtureTable {
  const name = `t${String(index).padStart(3, "0")}`;
  const columns: FixtureColumn[] = [{ name: "id", type: "int8", nullable: false }];
  if (tenancy === "column") {
    columns.push({ name: "tenant_id", type: "uuid", nullable: false });
  }
  if (index === 0) {
    columns.push({ name: "c00", type: "text", nullable: false });
    columns.push({ name: "c01", type: "int4", nullable: false });
  }

  const extra = 2 + nextInt(random, 4);
  const start = index === 0 ? 2 : 0;
  for (let offset = 0; offset < extra; offset++) {
    const type = FIXTURE_COLUMN_TYPES[nextInt(random, FIXTURE_COLUMN_TYPES.length)] ?? "text";
    columns.push({
      name: `c${String(start + offset).padStart(2, "0")}`,
      type,
      nullable: random() < 0.25,
    });
  }

  const foreignKeys: FixtureForeignKey[] = [];
  if (index > 0 && (index === 1 || random() < 0.4)) {
    const parent = index === 1 ? previous[0] : previous[nextInt(random, previous.length)];
    if (parent !== undefined) {
      columns.push({ name: "parent_id", type: "int8", nullable: false });
      foreignKeys.push({
        name: `${name}_parent_fkey`,
        columns: ["parent_id"],
        refTable: parent.name,
        refColumns: ["id"],
      });
    }
  }

  const uniques: FixtureUnique[] = [];
  const textColumn = columns.find((column) => column.type === "text");
  if (index === 0 || (textColumn !== undefined && random() < 0.35)) {
    const column = textColumn;
    if (column !== undefined) {
      const uniqueColumns = tenancy === "column" ? ["tenant_id", column.name] : [column.name];
      uniques.push({ name: `${name}_${column.name}_key`, columns: uniqueColumns });
    }
  }

  const indexes: FixtureIndex[] = [];
  const indexColumn = columns.find((column) => column.name === "c01") ?? lastColumn(columns);
  const uniqueColumns = new Set(uniques.flatMap((unique) => unique.columns));
  if (
    indexColumn !== undefined &&
    indexColumn.name !== "id" &&
    indexColumn.name !== "tenant_id" &&
    indexColumn.name !== "parent_id" &&
    (index === 0 || (random() < 0.5 && !uniqueColumns.has(indexColumn.name)))
  ) {
    indexes.push({
      name: `${name}_${indexColumn.name}_idx`,
      columns: [indexColumn.name],
      unique: false,
    });
  }

  return {
    name,
    columns,
    primaryKey: ["id"],
    foreignKeys,
    uniques,
    indexes,
  };
}

function lastColumn(columns: readonly FixtureColumn[]): FixtureColumn | undefined {
  return columns[columns.length - 1];
}

function nextInt(random: () => number, max: number): number {
  return Math.floor(random() * max);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

if (import.meta.main) {
  for (const tables of FIXTURE_SIZES) {
    for (const tenancy of ["none", "column"] as const) {
      const fixture = generateFixture({ seed: 1, tables, tenancy });
      const ddl = renderFixtureDdl(fixture);
      console.log(`${String(tables)} ${tenancy} ${fixtureHash(fixture, ddl)}`);
    }
  }
}
