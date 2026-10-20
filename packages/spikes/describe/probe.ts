/**
 * Runs the F7a describe matrix against one Postgres.
 *
 * Setup and the nullability lookups execute. Describe calls must not.
 * Throwaway spike code.
 */

import postgres from "postgres";

import {
  bunSqlSession,
  neonHttpSession,
  neonWebSocketSession,
  nodePostgresSession,
  pgliteSession,
  postgresJsSession,
  type DescribeRoute,
  type DriverSession,
  type ProbedColumn,
} from "./drivers.js";
import {
  NULLABILITY_SQL,
  NOT_NULL_CONSTRAINT_SQL,
  TYPE_LOOKUP_SQL,
  provenNotNull,
  type NullabilityRow,
} from "./nullability.js";
import { connectDescribe, type DescribeColumn, type DescribeOutcome } from "./protocol.js";

/** One statement in the edge list. */
export type Edge = {
  /** Short name. */
  readonly label: string;
  /** SQL text. */
  readonly text: string;
};

/** How one statement came back. */
export type StatementReport = {
  /** Edge label. */
  readonly label: string;
  /** True when Parse and Describe succeeded. */
  readonly ok: boolean;
  /** SQLSTATE when the server rejected the statement. */
  readonly code?: string;
  /** Server or driver message. */
  readonly message?: string;
  /** Parameter OIDs when describe succeeded. */
  readonly parameterOids?: readonly number[];
  /** Columns when describe succeeded. */
  readonly columns?: readonly ProbedColumn[];
  /** Log rows before the describe. Present on the side-effect statement. */
  readonly logBefore?: number;
  /** Log rows after the describe. */
  readonly logAfter?: number;
  /** Item rows before an INSERT describe. */
  readonly itemsBefore?: number;
  /** Item rows after an INSERT describe. */
  readonly itemsAfter?: number;
  /** True when `spike.nope` exists after the DDL describe. */
  readonly ddlCreated?: boolean;
};

/** One driver on one server. */
export type DriverReport = {
  /** Adapter name. */
  readonly name: string;
  /** Route for each capability. */
  readonly routes: {
    readonly parameterOids: DescribeRoute;
    readonly columnNames: DescribeRoute;
    readonly columnTypeOids: DescribeRoute;
    readonly tableOidAttnum: DescribeRoute;
  };
  /** Why the route is what it is. */
  readonly note: string;
  /** True when open() threw. */
  readonly openError?: string;
  /** Canonical describe, when the driver can describe. */
  readonly canonical?: StatementReport;
  /** Side-effect describe. */
  readonly sideEffect?: StatementReport;
  /** Every edge. Omitted when the driver cannot describe. */
  readonly statements?: readonly StatementReport[];
  /** Labels whose OIDs or errors differ from the built-in client. */
  readonly mismatches?: readonly string[];
  /** Warm describe of the canonical statement, milliseconds, minimum of five. */
  readonly warmDescribeMs?: number;
};

/** Catalog fact for one described column that names a table. */
export type NullabilityFact = {
  /** Statement label. */
  readonly label: string;
  /** Result column. */
  readonly column: string;
  /** Table OID from RowDescription. */
  readonly tableOid: number;
  /** Attribute number. */
  readonly attnum: number;
  /** Catalog row. Absent when the OID did not resolve. */
  readonly row?: NullabilityRow;
  /** `provenNotNull` of that row. */
  readonly proven?: boolean;
  /** PostgreSQL 18 not-null constraints on that attribute. */
  readonly notNullConstraints?: readonly { conname: string; convalidated: boolean; def: string }[];
};

/** Executed proof that a join can null a NOT NULL column. */
export type JoinProof = {
  /** SQL that was executed. */
  readonly text: string;
  /** Rows as text. */
  readonly rows: readonly (readonly (string | null)[])[];
};

/** One server, direct or through PgBouncer. */
export type ServerReport = {
  /** `15` … `18`, `pglite`, or a pooler label. */
  readonly label: string;
  /** `direct`, `pgbouncer`, or `pglite`. */
  readonly kind: "direct" | "pgbouncer" | "pglite";
  /** `SELECT version()`. */
  readonly version: string;
  /** Built-in client, which is the ground truth for the wire protocol. */
  readonly builtin: {
    readonly statements: readonly StatementReport[];
    /** Fresh connection plus one describe, minimum of three, milliseconds. */
    readonly freshMs: number;
    /** Describe on an already open connection, minimum of five, milliseconds. */
    readonly warmMs: number;
  };
  /** Adapter probes. */
  readonly drivers: readonly DriverReport[];
  /** Nullability lookups for columns the built-in client described. */
  readonly nullability: readonly NullabilityFact[];
  /** `pg_type` rows for OIDs the typed-parameter statement returned. */
  readonly types: readonly Record<string, unknown>[];
  /** Executed join rows. Empty on the pooler pass. */
  readonly joinProof: readonly JoinProof[];
  /** What a not-valid NOT NULL constraint did on this server. */
  readonly notValid: { readonly attempted: string; readonly outcome: string };
  /** Two backend pids from two connections. */
  readonly pids: readonly number[];
};

const EDGES: readonly Edge[] = [
  { label: "canonical", text: "SELECT id, name FROM spike.item WHERE id = $1" },
  { label: "side-effect", text: "SELECT spike.touch() AS n" },
  { label: "star", text: "SELECT * FROM spike.item" },
  {
    label: "insert-returning",
    text: "INSERT INTO spike.item (name) VALUES ('z') RETURNING id, name, name || '!' AS shouted",
  },
  {
    label: "cte",
    text: "WITH c AS (SELECT id, name FROM spike.item) SELECT id, name FROM c",
  },
  { label: "multi", text: "SELECT 1; SELECT 2" },
  { label: "trailing-semicolon", text: "SELECT 1;" },
  { label: "ddl", text: "CREATE TABLE spike.nope (id int)" },
  { label: "untyped", text: "SELECT $1" },
  { label: "arith-untyped", text: "SELECT $1 + 1 AS n" },
  { label: "cast-param", text: "SELECT $1::int AS n" },
  {
    label: "inferred",
    text: "SELECT id FROM spike.item WHERE name = $1 AND score = $2",
  },
  {
    label: "column-types",
    text: "SELECT tags, mood, span, pair, pos FROM spike.item WHERE pos = $1",
  },
  {
    label: "typed-params",
    text: "SELECT $1::spike.mood AS mood, $2::text[] AS tags, $3::spike.pair AS pair, $4::int4range AS span, $5::spike.pos AS pos",
  },
  { label: "missing", text: "SELECT * FROM spike.missing" },
  { label: "runtime-error", text: "SELECT 1/0 AS n" },
  { label: "insert-null", text: "INSERT INTO spike.item (name) VALUES (NULL)" },
  {
    label: "left-join",
    text: "SELECT i.name, o.id AS other_id FROM spike.item i LEFT JOIN spike.other o ON o.item_id = i.id",
  },
  {
    label: "right-join",
    text: "SELECT i.name, o.id AS other_id FROM spike.item i RIGHT JOIN spike.other o ON o.item_id = i.id",
  },
  {
    label: "full-join",
    text: "SELECT i.name, o.id AS other_id FROM spike.item i FULL JOIN spike.other o ON o.item_id = i.id",
  },
  {
    label: "inner-join",
    text: "SELECT i.name, o.id AS other_id FROM spike.item i JOIN spike.other o ON o.item_id = i.id",
  },
  {
    label: "subquery",
    text: "SELECT id, name FROM (SELECT id, name FROM spike.item) s",
  },
  {
    label: "union",
    text: "SELECT id, name FROM spike.item UNION ALL SELECT id, name FROM spike.item",
  },
  {
    label: "cte-left",
    text: "WITH c AS (SELECT o.id FROM spike.item i LEFT JOIN spike.other o ON o.item_id = i.id) SELECT id FROM c",
  },
  { label: "view", text: "SELECT id, name FROM spike.item_name" },
  { label: "insert-no-returning", text: "INSERT INTO spike.log (note) VALUES ('x')" },
];

const FIXTURE = `
DROP SCHEMA IF EXISTS spike CASCADE;
CREATE SCHEMA spike;
CREATE TABLE spike.log (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note text NOT NULL
);
CREATE FUNCTION spike.touch() RETURNS int
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO spike.log (note) VALUES ('touched');
  RETURN 1;
END;
$$;
CREATE TYPE spike.mood AS ENUM ('ok', 'bad');
CREATE TYPE spike.pair AS (a int, b text);
CREATE DOMAIN spike.pos AS int NOT NULL CHECK (VALUE > 0);
CREATE TABLE spike.item (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  note text,
  score int NOT NULL DEFAULT 0,
  tags text[],
  mood spike.mood,
  span int4range,
  pair spike.pair,
  pos spike.pos,
  doubled int GENERATED ALWAYS AS (score * 2) STORED,
  loose int GENERATED ALWAYS AS (CASE WHEN note IS NULL THEN NULL ELSE length(note) END) STORED,
  checked int,
  CONSTRAINT item_checked_nn CHECK (checked IS NOT NULL)
);
CREATE TABLE spike.other (
  id int PRIMARY KEY,
  item_id int
);
INSERT INTO spike.item (name, score, pos, checked) VALUES ('a', 1, 1, 0), ('b', 2, 2, 0);
INSERT INTO spike.other (id, item_id) VALUES (1, 1), (2, NULL);
CREATE VIEW spike.item_name AS SELECT id, name FROM spike.item;
`;

/**
 * Probes one TCP Postgres, direct or through PgBouncer.
 *
 * @param url - Connection URL
 * @param label - Matrix label
 * @param kind - Direct or pooler
 * @param setup - Apply the fixture first
 * @returns The server report
 */
export async function probeTcp(
  url: string,
  label: string,
  kind: "direct" | "pgbouncer",
  setup: boolean,
): Promise<ServerReport> {
  const sql = openSql(url);
  try {
    if (setup) {
      await sql.unsafe(FIXTURE).simple();
      await sql`select spike.touch()`;
      await sql`delete from spike.log`;
    }
    const version = cell(await sql`select version()`);
    const builtin = await probeBuiltin(url);
    const drivers = await probeDrivers(url, builtin.statements, [
      () => postgresJsSession(),
      () => nodePostgresSession(),
      () => bunSqlSession(),
      () => neonWebSocketSession(),
      () => neonHttpSession(),
    ]);
    const nullability = kind === "direct" ? await lookupNullability(sql, builtin.statements) : [];
    const types = kind === "direct" ? await lookupTypes(sql, builtin.statements) : [];
    const joinProof = kind === "direct" ? await proveJoins(sql) : [];
    const notValid =
      kind === "direct"
        ? await proveNotValid(sql)
        : { attempted: "", outcome: "skipped on pooler" };
    const pids = await twoPids(url);
    return {
      label,
      kind,
      version,
      builtin,
      drivers,
      nullability,
      types,
      joinProof,
      notValid,
      pids,
    };
  } finally {
    await sql.end();
  }
}

/**
 * Probes the bundled PGlite.
 *
 * @returns The server report
 */
export async function probePglite(): Promise<ServerReport> {
  const session = pgliteSession();
  await session.open("memory://");
  try {
    await session.apply?.(FIXTURE);
    await session.scalar?.("select spike.touch()");
    await session.scalar?.("delete from spike.log");
    const version = (await session.scalar?.("select version()")) ?? "";
    const statements: StatementReport[] = [];
    for (const edge of EDGES) statements.push(await statementOnSession(session, edge));
    const builtin = { statements, freshMs: 0, warmMs: await warm(session, canonicalText()) };
    const nullability = await lookupNullabilityPglite(session, statements);
    const types = await lookupTypesPglite(session, statements);
    const joinProof = await proveJoinsPglite(session);
    return {
      label: "pglite",
      kind: "pglite",
      version,
      builtin,
      drivers: [
        packDriver({
          name: session.name,
          routes: routesOf(session),
          note: session.note,
          statements,
          sideEffect: statements.find((item) => item.label === "side-effect"),
          canonical: statements.find((item) => item.label === "canonical"),
          mismatches: [],
          warmDescribeMs: builtin.warmMs,
        }),
      ],
      nullability,
      types,
      joinProof,
      notValid: { attempted: "not run on pglite in this pass", outcome: "see tcp servers" },
      pids: [],
    };
  } finally {
    await session.close();
  }
}

async function probeBuiltin(url: string): Promise<ServerReport["builtin"]> {
  const client = await connectDescribe(url);
  try {
    const statements: StatementReport[] = [];
    for (const edge of EDGES) statements.push(await statementOnBuiltin(client, edge, url));
    const warmMs = await minMs(5, async () => {
      await client.describe(canonicalText());
    });
    const freshMs = await minMs(3, async () => {
      const fresh = await connectDescribe(url);
      try {
        await fresh.describe(canonicalText());
      } finally {
        fresh.close();
      }
    });
    return { statements, freshMs, warmMs };
  } finally {
    client.close();
  }
}

async function statementOnBuiltin(
  client: Awaited<ReturnType<typeof connectDescribe>>,
  edge: Edge,
  url: string,
): Promise<StatementReport> {
  const counts = await countsFor(url, edge.label);
  const outcome = await client.describe(edge.text);
  const after = await countsFor(url, edge.label);
  return reportOf(edge.label, outcome, counts, after);
}

async function statementOnSession(
  session: DriverSession,
  edge: Edge,
  url?: string,
): Promise<StatementReport> {
  const before = await countsOf(session, edge.label, url);
  try {
    const described = await session.describe(edge.text);
    const after = await countsOf(session, edge.label, url);
    return {
      label: edge.label,
      ok: true,
      parameterOids: described.parameterOids,
      columns: described.columns,
      ...countFields(before, after),
    };
  } catch (error) {
    const after = await countsOf(session, edge.label, url);
    const parsed = errorOf(error);
    return packStatement({
      label: edge.label,
      ok: false,
      code: parsed.code,
      message: parsed.message,
      ...countFields(before, after),
    });
  }
}

async function probeDrivers(
  url: string,
  ground: readonly StatementReport[],
  factories: readonly (() => DriverSession)[],
): Promise<readonly DriverReport[]> {
  const reports: DriverReport[] = [];
  for (const factory of factories) {
    const session = factory();
    try {
      await session.open(url);
    } catch (error) {
      reports.push({
        name: session.name,
        routes: untestedRoutes(),
        note: `${session.note} open failed: ${errorOf(error).message}`,
        openError: errorOf(error).message,
      });
      continue;
    }
    try {
      if (session.parameterOids === "untested" || session.parameterOids === "not-possible") {
        let refusal = "";
        try {
          await session.describe(canonicalText());
        } catch (error) {
          refusal = errorOf(error).message;
        }
        reports.push({
          name: session.name,
          routes: routesOf(session),
          note: refusal.length === 0 ? session.note : `${session.note} Refusal: ${refusal}`,
        });
        continue;
      }
      const statements: StatementReport[] = [];
      for (const edge of EDGES) statements.push(await statementOnSession(session, edge, url));
      reports.push(
        packDriver({
          name: session.name,
          routes: routesOf(session),
          note: session.note,
          canonical: statements.find((item) => item.label === "canonical"),
          sideEffect: statements.find((item) => item.label === "side-effect"),
          statements,
          mismatches: mismatches(ground, statements),
          warmDescribeMs: await warm(session, canonicalText()),
        }),
      );
    } finally {
      await session.close();
    }
  }
  return reports;
}

function mismatches(
  ground: readonly StatementReport[],
  actual: readonly StatementReport[],
): readonly string[] {
  const out: string[] = [];
  for (const edge of ground) {
    const found = actual.find((item) => item.label === edge.label);
    if (found === undefined) {
      out.push(`${edge.label}: missing`);
      continue;
    }
    if (edge.ok !== found.ok || (edge.code ?? "") !== (found.code ?? "")) {
      out.push(
        `${edge.label}: ground ${edge.ok ? "ok" : edge.code} driver ${found.ok ? "ok" : found.code}`,
      );
      continue;
    }
    if (!edge.ok) continue;
    if (!sameNumbers(edge.parameterOids, found.parameterOids)) {
      out.push(`${edge.label}: parameter oids`);
    }
    if (!sameColumns(edge.columns, found.columns)) {
      out.push(`${edge.label}: columns`);
    }
  }
  return out;
}

async function lookupNullability(
  sql: postgres.Sql,
  statements: readonly StatementReport[],
): Promise<readonly NullabilityFact[]> {
  const facts: NullabilityFact[] = [];
  const seen = new Set<string>();
  for (const statement of statements) {
    if (!statement.ok || statement.columns === undefined) continue;
    for (const column of statement.columns) {
      if (
        column.tableOid === null ||
        column.tableOid === 0 ||
        column.attnum === null ||
        column.attnum === 0
      )
        continue;
      const key = `${statement.label}:${column.name}:${String(column.tableOid)}:${String(column.attnum)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rows = await sql.unsafe(NULLABILITY_SQL, [
        String(column.tableOid),
        String(column.attnum),
      ]);
      const row = rows[0] === undefined ? undefined : nullabilityOf(rows[0]);
      const constraints = await sql.unsafe(NOT_NULL_CONSTRAINT_SQL, [
        String(column.tableOid),
        String(column.attnum),
      ]);
      facts.push({
        label: statement.label,
        column: column.name,
        tableOid: column.tableOid,
        attnum: column.attnum,
        ...(row === undefined ? {} : { row, proven: provenNotNull(row) }),
        notNullConstraints: constraints.map((item) => ({
          conname: String(item.conname),
          convalidated: Boolean(item.convalidated),
          def: String(item.def),
        })),
      });
    }
  }
  return facts;
}

async function lookupTypes(
  sql: postgres.Sql,
  statements: readonly StatementReport[],
): Promise<readonly Record<string, unknown>[]> {
  const typed = statements.find((item) => item.label === "typed-params");
  const columnTypes = statements.find((item) => item.label === "column-types");
  const oids = [
    ...(typed?.parameterOids ?? []),
    ...(typed?.columns?.map((column) => column.typeOid ?? 0) ?? []),
    ...(columnTypes?.columns?.map((column) => column.typeOid ?? 0) ?? []),
  ].filter((oid) => oid > 0);
  if (oids.length === 0) return [];
  const rows = await sql.unsafe(TYPE_LOOKUP_SQL, [`{${oids.join(",")}}`]);
  return rows.map((row) => recordOf(row));
}

async function proveJoins(sql: postgres.Sql): Promise<readonly JoinProof[]> {
  const texts = [
    "SELECT i.name, o.id::text AS other_id FROM spike.item i LEFT JOIN spike.other o ON o.item_id = i.id ORDER BY i.name",
    "SELECT i.name, o.id::text AS other_id FROM spike.item i RIGHT JOIN spike.other o ON o.item_id = i.id ORDER BY o.id",
  ];
  const proofs: JoinProof[] = [];
  for (const text of texts) {
    const rows = await sql.unsafe(text);
    proofs.push({
      text,
      rows: rows.map((row) => [textOf(row.name), textOf(row.other_id)]),
    });
  }
  return proofs;
}

async function proveNotValid(sql: postgres.Sql): Promise<{ attempted: string; outcome: string }> {
  const attempted = "ALTER TABLE spike.item ADD CONSTRAINT item_note_nn NOT NULL note NOT VALID";
  try {
    await sql.unsafe(attempted);
    const rows =
      await sql`select attnotnull from pg_attribute where attrelid = 'spike.item'::regclass and attname = 'note'`;
    const constraints =
      await sql`select conname, convalidated from pg_constraint where conrelid = 'spike.item'::regclass and contype = 'n'`;
    await sql.unsafe("ALTER TABLE spike.item DROP CONSTRAINT item_note_nn");
    return {
      attempted,
      outcome: `accepted; attnotnull=${String(rows[0]?.attnotnull)}; constraints=${JSON.stringify(constraints)}`,
    };
  } catch (error) {
    return { attempted, outcome: errorOf(error).message };
  }
}

async function twoPids(url: string): Promise<readonly number[]> {
  const pids: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const sql = openSql(url);
    try {
      const rows = await sql`select pg_backend_pid() as pid`;
      pids.push(num(rows[0]?.pid));
    } finally {
      await sql.end();
    }
  }
  return pids;
}

async function lookupNullabilityPglite(
  session: DriverSession,
  statements: readonly StatementReport[],
): Promise<readonly NullabilityFact[]> {
  const facts: NullabilityFact[] = [];
  for (const statement of statements) {
    if (!statement.ok || statement.columns === undefined) continue;
    if (statement.label !== "star" && statement.label !== "canonical") continue;
    for (const column of statement.columns) {
      if (column.tableOid === null || column.tableOid === 0 || column.attnum === null) continue;
      const sql = `SELECT row_to_json(x)::text AS j FROM (${NULLABILITY_SQL.replaceAll("$1", String(column.tableOid)).replaceAll("$2", String(column.attnum))}) x`;
      const json = await session.scalar?.(sql);
      if (json === null || json === undefined) continue;
      const row = nullabilityOf(JSON.parse(json) as Record<string, unknown>);
      facts.push({
        label: statement.label,
        column: column.name,
        tableOid: column.tableOid,
        attnum: column.attnum,
        row,
        proven: provenNotNull(row),
      });
    }
  }
  return facts;
}

async function lookupTypesPglite(
  session: DriverSession,
  statements: readonly StatementReport[],
): Promise<readonly Record<string, unknown>[]> {
  const typed = statements.find((item) => item.label === "typed-params");
  const oids = [
    ...(typed?.parameterOids ?? []),
    ...(typed?.columns?.map((column) => column.typeOid ?? 0) ?? []),
  ].filter((oid) => oid > 0);
  if (oids.length === 0) return [];
  const sql = `SELECT coalesce(json_agg(x), '[]')::text AS j FROM (${TYPE_LOOKUP_SQL.replace("$1::oid[]", `'{${oids.join(",")}}'::oid[]`)}) x`;
  const json = await session.scalar?.(sql);
  if (json === null || json === undefined) return [];
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed)
    ? parsed.map((row) => ({ ...(row as Record<string, unknown>) }))
    : [];
}

async function proveJoinsPglite(session: DriverSession): Promise<readonly JoinProof[]> {
  const text =
    "SELECT i.name || '|' || coalesce(o.id::text, '') FROM spike.item i LEFT JOIN spike.other o ON o.item_id = i.id ORDER BY 1";
  const json = await session.scalar?.(`SELECT coalesce(json_agg(x), '[]')::text FROM (${text}) x`);
  return [{ text, rows: json === null || json === undefined ? [] : [[json]] }];
}

function reportOf(
  label: string,
  outcome: DescribeOutcome,
  before: Counts,
  after: Counts,
): StatementReport {
  const failed = outcome.code !== undefined;
  return {
    label,
    ok: !failed,
    ...(outcome.code === undefined ? {} : { code: outcome.code, message: outcome.message }),
    ...(failed
      ? {}
      : {
          parameterOids: outcome.parameterOids,
          columns: outcome.columns.map(columnOf),
        }),
    ...countFields(before, after),
  };
}

function columnOf(column: DescribeColumn): ProbedColumn {
  return {
    name: column.name,
    typeOid: column.typeOid,
    tableOid: column.tableOid,
    attnum: column.attnum,
  };
}

type Counts = { log?: number; items?: number; nope?: boolean };

async function countsFor(url: string, label: string): Promise<Counts> {
  if (
    label !== "side-effect" &&
    label !== "insert-returning" &&
    label !== "insert-null" &&
    label !== "insert-no-returning" &&
    label !== "ddl"
  ) {
    return {};
  }
  const sql = openSql(url);
  try {
    return await readCounts(sql, label);
  } finally {
    await sql.end();
  }
}

async function readCounts(sql: postgres.Sql, label: string): Promise<Counts> {
  if (label === "side-effect") {
    const rows = await sql`select count(*)::int as n from spike.log`;
    return { log: num(rows[0]?.n) };
  }
  if (label === "ddl") {
    const rows = await sql`select to_regclass('spike.nope') as rel`;
    return { nope: rows[0]?.rel !== null };
  }
  const rows = await sql`select count(*)::int as n from spike.item`;
  const log =
    label === "insert-no-returning"
      ? await sql`select count(*)::int as n from spike.log`
      : undefined;
  return {
    items: num(rows[0]?.n),
    ...(log === undefined ? {} : { log: num(log[0]?.n) }),
  };
}

async function countsOf(session: DriverSession, label: string, url?: string): Promise<Counts> {
  if (url !== undefined) return countsFor(url, label);
  return sessionCounts(session, label);
}

async function sessionCounts(session: DriverSession, label: string): Promise<Counts> {
  if (session.scalar === undefined) return {};
  if (label === "side-effect") {
    const value = await session.scalar("select count(*)::int from spike.log");
    return { log: value === null ? 0 : Number(value) };
  }
  if (label === "ddl") {
    const value = await session.scalar("select to_regclass('spike.nope')::text");
    return { nope: value !== null };
  }
  if (label === "insert-returning" || label === "insert-null" || label === "insert-no-returning") {
    const items = await session.scalar("select count(*)::int from spike.item");
    const log =
      label === "insert-no-returning"
        ? await session.scalar("select count(*)::int from spike.log")
        : null;
    return {
      items: items === null ? 0 : Number(items),
      ...(log === null ? {} : { log: Number(log) }),
    };
  }
  return {};
}

function countFields(
  before: Counts,
  after: Counts,
): Pick<StatementReport, "logBefore" | "logAfter" | "itemsBefore" | "itemsAfter" | "ddlCreated"> {
  return {
    ...(before.log === undefined ? {} : { logBefore: before.log, logAfter: after.log }),
    ...(before.items === undefined ? {} : { itemsBefore: before.items, itemsAfter: after.items }),
    ...(before.nope === undefined ? {} : { ddlCreated: after.nope === true }),
  };
}

function nullabilityOf(row: Record<string, unknown>): NullabilityRow {
  return {
    attnotnull: bool(row.attnotnull),
    attidentity: text(row.attidentity),
    attgenerated: text(row.attgenerated),
    atttypid: num(row.atttypid),
    typname: text(row.typname),
    typtype: text(row.typtype),
    domain_not_null: bool(row.domain_not_null),
    typbasetype: num(row.typbasetype),
    relkind: text(row.relkind),
    relname: text(row.relname),
    nspname: text(row.nspname),
  };
}

/**
 * Drops properties whose value is `undefined` so optional fields stay absent.
 *
 * @param fields - Report fields, including ones that may be missing
 * @returns A report with only the fields that have a value
 */
function packDriver(fields: Loose<DriverReport>): DriverReport {
  return pack(fields);
}

/**
 * @param fields - Statement fields, including ones that may be missing
 * @returns A statement report with only the fields that have a value
 */
function packStatement(fields: Loose<StatementReport>): StatementReport {
  return pack(fields);
}

type Loose<T> = { [K in keyof T]: T[K] | undefined };

function pack<T>(fields: Loose<T>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

function routesOf(session: DriverSession): DriverReport["routes"] {
  return {
    parameterOids: session.parameterOids,
    columnNames: session.columnNames,
    columnTypeOids: session.columnTypeOids,
    tableOidAttnum: session.tableOidAttnum,
  };
}

function untestedRoutes(): DriverReport["routes"] {
  return {
    parameterOids: "untested",
    columnNames: "untested",
    columnTypeOids: "untested",
    tableOidAttnum: "untested",
  };
}

function canonicalText(): string {
  return EDGES[0]?.text ?? "select 1";
}

async function warm(session: DriverSession, text: string): Promise<number> {
  return minMs(5, async () => {
    await session.describe(text);
  });
}

async function minMs(samples: number, run: () => Promise<void>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    await run();
    best = Math.min(best, performance.now() - start);
  }
  return Math.round(best * 1000) / 1000;
}

function sameNumbers(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): boolean {
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameColumns(
  left: readonly ProbedColumn[] | undefined,
  right: readonly ProbedColumn[] | undefined,
): boolean {
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((column, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      column.name === other.name &&
      column.typeOid === other.typeOid &&
      column.tableOid === other.tableOid &&
      column.attnum === other.attnum
    );
  });
}

function errorOf(error: unknown): { code?: string; message: string } {
  if (typeof error === "object" && error !== null) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    const message =
      "message" in error && typeof error.message === "string" ? error.message : text(error);
    if (code === undefined) return { message };
    return { code, message };
  }
  return { message: String(error) };
}

function openSql(url: string): postgres.Sql {
  return postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
}

function cell(rows: readonly Record<string, unknown>[]): string {
  const value = Object.values(rows[0] ?? {})[0];
  return value === undefined || value === null ? "" : text(value);
}

function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return text(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function recordOf(row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) out[key] = (row as Record<string, unknown>)[key];
  return out;
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) return Number(value);
  if (typeof value === "bigint") return Number(value);
  throw new Error(`expected a number, got ${String(value)}`);
}

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}
