/**
 * Pairwise composition of table traits, tenancy, concealment, batch, isolation,
 * casing, and one operation.
 *
 * Writes go through `db.batch` or `tx.batch`. `db.batch` has no isolation
 * argument, so a `db` + `serializable` write still asserts the row. Reads are
 * seeded through that batch, then run inside `tx` at the drawn isolation.
 * A versioned update on `db.batch` is the documented OKM1121 refusal.
 *
 * Set `OKM_COMPOSITION=1` to run. The ordinary suite skips this file.
 */

import { inspect } from "node:util";

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../../packages/harness/src/postgres.js";
import { primaryUrl } from "../../packages/harness/src/topology.js";
import { OkmError } from "../../src/contracts/error.js";
import { renderCatalog } from "../../src/dialects/pg/ddl.js";
import { inc, schema, t, table } from "../../src/dialects/pg/index.js";
import { connect } from "../../src/runtime/pg/postgresjs.js";
import { columnTenancy, compositeTenancy } from "../../src/runtime/tenancy/index.js";
import { archivable, versioned } from "../../src/runtime/traits/index.js";
import { compositionCover, type CompositionCase } from "./cover.js";

const gate = await loadPostgresGate();
const ENABLED = process.env.OKM_COMPOSITION === "1";

const CANARY_HIDDEN = "okmcanary-code-b41e2d18";
const CANARY_TOKEN = "okmcanary-token-7f3a9c2e";
const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const ORG = "00000000-0000-4000-8000-000000000010";

/**
 * The client, reached by table name.
 * `any` is justified here: each case builds a different schema, and the
 * assertion is the row the runtime returns.
 */
// oxlint-disable-next-line typescript/no-explicit-any
type Loose = { readonly [key: string]: any };

/** Product leaks this file already reproduced. Channel plus a short repro. */
const KNOWN_LEAKS: readonly { readonly channel: string; readonly repro: string }[] = [];

postgresTest(
  gate,
  "pairwise composition keeps the row, the tenant, and the canary",
  async () => {
    if (!ENABLED) {
      console.warn("[composition] skipped (set OKM_COMPOSITION=1 to run)");
      return;
    }
    const leaks: string[] = [];
    for (const item of compositionCover()) {
      await withPostgresSchema(async (sql, schemaName) => {
        const app = buildApp(item);
        for (const statement of renderCatalog(app.catalog, schemaName)) {
          await sql.unsafe(statement);
        }
        const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 2 });
        try {
          await db.connected;
          const found = await runCase(db as unknown as Loose, item);
          if (found !== undefined) leaks.push(found);
        } finally {
          await db.close();
        }
      });
    }
    const unknown = leaks.filter(
      (line) => !KNOWN_LEAKS.some((known) => line.startsWith(known.channel)),
    );
    expect(unknown).toEqual([]);
  },
  300_000,
);

function buildApp(item: CompositionCase) {
  const columns: Record<string, object> = {
    id: t.text().primaryKey(),
    NoteBody: t.text(),
    n: t.integer(),
  };
  if (item.conceal === "hidden") columns.code = t.text().hidden({ filterable: true });
  if (item.conceal === "sensitive") columns.token = t.text().sensitive();
  const traits = [
    ...(item.archivable ? [archivable()] : []),
    ...(item.versioned ? [versioned()] : []),
  ];
  const notes =
    traits.length > 0
      ? table("notes", columns as never, { traits } as never)
      : table("notes", columns as never);
  const tenancy =
    item.tenancy === "column"
      ? columnTenancy({ key: "tenantId", type: "uuid" })
      : item.tenancy === "composite"
        ? compositeTenancy({ key: ["orgId", "tenantId"], type: "uuid" })
        : undefined;
  return schema({
    tables: [notes],
    ...(item.casing === "verbatim" ? {} : { casing: item.casing }),
    ...(tenancy === undefined ? {} : { tenancy }),
  });
}

async function runCase(db: Loose, item: CompositionCase): Promise<string | undefined> {
  const a = scope(db, item, "a");
  await seed(a, db, item);
  const described = await describe(a, item);
  const outcome = await perform(a, item);
  const row = await readActive(a, item.operation === "insert" ? "c" : "a");
  assertContract(item, outcome, row);
  await assertBoundaries(db, item);
  return leakOf(item, outcome, row, described);
}

async function seed(a: Loose, db: Loose, item: CompositionCase): Promise<void> {
  await write(a, item, (handle) => handle.notes.insert(rowOf(item, "a", "seed", 1)));
  if (isRead(item.operation)) {
    await write(a, item, (handle) => handle.notes.insert(rowOf(item, "b", "second", 2)));
  }
  if (item.archivable) {
    await write(a, item, (handle) => handle.notes.insert(rowOf(item, "z", "gone", 0)));
    await write(a, item, (handle) => handle.notes.archive({ where: { id: "z" } }));
  }
  if (item.tenancy !== "none") {
    const b = scope(db, item, "b");
    await write(b, item, (handle) => handle.notes.insert(rowOf(item, "a", "other", 9)));
  }
}

async function perform(a: Loose, item: CompositionCase): Promise<Outcome> {
  try {
    if (isRead(item.operation)) {
      const value = await inTx(a, item, (tx) => readOp(tx, item));
      return { value };
    }
    const value = await write(a, item, (handle) => writeOp(handle, item));
    return { value };
  } catch (error) {
    return { error };
  }
}

function writeOp(handle: Loose, item: CompositionCase): unknown {
  if (item.operation === "insert") return handle.notes.insert(rowOf(item, "c", "new", 4));
  if (item.operation === "update-id") {
    return handle.notes.update({
      where: { id: "a" },
      set: { NoteBody: "edited" },
      ...(item.versioned ? { version: 1 } : {}),
    });
  }
  if (item.operation === "update-filter") {
    return handle.notes.update({
      where: { NoteBody: "seed" },
      set: { n: 3 },
      ...(item.versioned ? { version: 1 } : {}),
    });
  }
  if (item.operation === "claim") {
    return handle.notes.update({
      where: { n: 1 },
      set: { NoteBody: "claimed" },
      version: "any",
      lock: "skip",
      limit: 1,
    });
  }
  if (item.operation === "atomic") {
    return handle.notes.update({
      where: { id: "a" },
      set: { n: inc(1) },
      ...(item.versioned ? { version: 1 } : {}),
    });
  }
  if (item.operation === "delete") return handle.notes.delete({ where: { id: "a" } });
  return handle.notes.archive({ where: { id: "a" } });
}

async function readOp(tx: Loose, item: CompositionCase): Promise<unknown> {
  if (item.operation === "find") {
    return tx.notes.find({ where: { id: "a" }, limit: 5 });
  }
  if (item.operation === "page") {
    const first = await tx.notes.page({ orderBy: { id: "asc" }, limit: 1 });
    const second = await tx.notes.page({ orderBy: { id: "asc" }, limit: 1, after: first.next });
    return { first, second };
  }
  if (item.operation === "stream") {
    const rows: unknown[] = [];
    for await (const row of tx.notes.find({ orderBy: { id: "asc" }, limit: 10 }).stream()) {
      rows.push(row);
    }
    return rows;
  }
  return tx.notes.aggregate({ count: true });
}

function assertContract(item: CompositionCase, outcome: Outcome, row: Row | undefined): void {
  const refusal = expectedRefusal(item);
  if (refusal !== undefined) {
    if (outcome.error === undefined) fail(item, `${refusal} was accepted`);
    if (refusal === "version" && codeOf(outcome.error) !== "OKM1121") {
      fail(item, `expected OKM1121, got ${textOf(outcome.error)}`);
    }
    if (refusal === "claim" && codeOf(outcome.error) !== "OKM1120") {
      fail(item, `expected OKM1120, got ${textOf(outcome.error)}`);
    }
    if (row?.NoteBody !== "seed" || row.n !== 1) fail(item, "a refused write changed the row");
    if (item.versioned && row.version !== 1) fail(item, "a refused write bumped version");
    return;
  }
  if (outcome.error !== undefined) fail(item, textOf(outcome.error));
  if (item.operation === "insert") {
    expectRow(item, row, {
      id: "c",
      NoteBody: "new",
      n: 4,
      version: item.versioned ? 1 : undefined,
    });
    return;
  }
  if (item.operation === "update-id") {
    expectRow(item, row, {
      id: "a",
      NoteBody: "edited",
      n: 1,
      version: item.versioned ? 2 : undefined,
    });
    return;
  }
  if (item.operation === "update-filter") {
    expectRow(item, row, {
      id: "a",
      NoteBody: "seed",
      n: 3,
      version: item.versioned ? 2 : undefined,
    });
    return;
  }
  if (item.operation === "claim") {
    expectRow(item, row, { id: "a", NoteBody: "claimed", n: 1, version: 2 });
    return;
  }
  if (item.operation === "atomic") {
    expectRow(item, row, {
      id: "a",
      NoteBody: "seed",
      n: 2,
      version: item.versioned ? 2 : undefined,
    });
    return;
  }
  if (item.operation === "delete") {
    if (row !== undefined) fail(item, "deleted row is still visible");
    return;
  }
  if (item.operation === "archive") {
    if (row !== undefined) fail(item, "archived row is still visible");
    return;
  }
  assertRead(item, outcome.value);
}

function assertRead(item: CompositionCase, value: unknown): void {
  if (item.operation === "find") {
    const rows = asRows(value);
    if (rows.length !== 1) fail(item, `find returned ${String(rows.length)} rows`);
    expectRow(item, rows[0], {
      id: "a",
      NoteBody: "seed",
      n: 1,
      version: item.versioned ? 1 : undefined,
    });
    return;
  }
  if (item.operation === "page") {
    const page = value as { first?: { items?: Row[]; next?: unknown }; second?: { items?: Row[] } };
    const ids = [...(page.first?.items ?? []), ...(page.second?.items ?? [])].map((row) => row.id);
    if (ids.join(",") !== "a,b") fail(item, `page ids ${ids.join(",")}`);
    if (JSON.stringify(page.first?.next ?? "").includes(CANARY_HIDDEN))
      fail(item, "cursor has the hidden canary");
    if (JSON.stringify(page.first?.next ?? "").includes(CANARY_TOKEN))
      fail(item, "cursor has the sensitive canary");
    return;
  }
  if (item.operation === "stream") {
    const ids = asRows(value).map((row) => row.id);
    if (ids.join(",") !== "a,b") fail(item, `stream ids ${ids.join(",")}`);
    return;
  }
  const counts = asRows(value).map((row) => row.count);
  if (counts.length !== 1 || counts[0] !== 2) fail(item, `aggregate count ${String(counts[0])}`);
}

async function assertBoundaries(db: Loose, item: CompositionCase): Promise<void> {
  const a = scope(db, item, "a");
  const visible = await readIds(a);
  if (visible.includes("z")) fail(item, "archived row is in the active set");
  if (item.tenancy !== "none") {
    const other = await readActive(scope(db, item, "b"), "a");
    if (other?.NoteBody !== "other" || other.n !== 9) fail(item, "the other tenant row changed");
  }
  if (item.archivable && item.operation === "archive") {
    const archived = await readArchived(a, "a");
    if (archived?.id !== "a") fail(item, "archive did not keep the row");
    if (item.versioned && archived.version !== 1) fail(item, "archive bumped version");
  }
}

function expectRow(
  item: CompositionCase,
  row: Row | undefined,
  want: { id: string; NoteBody: string; n: number; version: number | undefined },
): void {
  if (row === undefined) fail(item, "row missing");
  if (row.id !== want.id || row.NoteBody !== want.NoteBody || row.n !== want.n) {
    fail(item, `row ${JSON.stringify({ id: row.id, NoteBody: row.NoteBody, n: row.n })}`);
  }
  if (want.version === undefined) {
    if (row.version !== undefined) fail(item, "unexpected version");
  } else if (row.version !== want.version) {
    fail(item, `version ${String(row.version)}`);
  }
  if ("code" in row) fail(item, "hidden column is on the row");
  if (item.conceal === "sensitive" && row.token !== CANARY_TOKEN)
    fail(item, "sensitive column was dropped");
}

function expectedRefusal(item: CompositionCase): "version" | "claim" | "archive" | undefined {
  if (!item.versioned && item.operation === "claim") return "claim";
  if (!item.archivable && item.operation === "archive") return "archive";
  if (
    item.versioned &&
    item.batch === "db" &&
    (item.operation === "update-id" ||
      item.operation === "update-filter" ||
      item.operation === "atomic")
  ) {
    return "version";
  }
  return undefined;
}

async function write(
  handle: Loose,
  item: CompositionCase,
  make: (handle: Loose) => unknown,
): Promise<unknown> {
  if (item.batch === "db") {
    const [value] = await handle.batch([make(handle)]);
    return value;
  }
  const body = async (tx: Loose) => {
    const [value] = await tx.batch([make(tx)]);
    return value;
  };
  if (item.isolation === "serializable") return handle.tx({ isolation: "serializable" }, body);
  return handle.tx(body);
}

async function inTx<T>(
  handle: Loose,
  item: CompositionCase,
  fn: (tx: Loose) => Promise<T>,
): Promise<T> {
  if (item.isolation === "serializable") return handle.tx({ isolation: "serializable" }, fn);
  return handle.tx(fn);
}

function scope(db: Loose, item: CompositionCase, which: "a" | "b"): Loose {
  if (item.tenancy === "none") return db;
  const tenantId = which === "a" ? TENANT_A : TENANT_B;
  if (item.tenancy === "column") return db.for({ tenantId });
  return db.for({ orgId: ORG, tenantId });
}

function rowOf(
  item: CompositionCase,
  id: string,
  body: string,
  n: number,
): Record<string, unknown> {
  return {
    id,
    NoteBody: body,
    n,
    ...(item.conceal === "hidden" ? { code: CANARY_HIDDEN } : {}),
    ...(item.conceal === "sensitive" ? { token: CANARY_TOKEN } : {}),
  };
}

async function readActive(handle: Loose, id: string): Promise<Row | undefined> {
  const rows = await handle.notes.find({ where: { id }, limit: 2 });
  return rows[0];
}

async function readArchived(handle: Loose, id: string): Promise<Row | undefined> {
  const rows = await handle.notes.withArchived().find({ where: { id }, limit: 2 });
  return rows[0];
}

async function readIds(handle: Loose): Promise<string[]> {
  const rows = await handle.notes.find({ orderBy: { id: "asc" }, limit: 10 });
  return rows.map((row: Row) => row.id);
}

async function describe(handle: Loose, item: CompositionCase): Promise<string> {
  if (expectedRefusal(item) !== undefined) return "";
  try {
    const plan = planOf(handle, item) as { sql?: () => Promise<string>; inspect?: () => string };
    const sqlText = typeof plan.sql === "function" ? await plan.sql() : "";
    const inspected = typeof plan.inspect === "function" ? plan.inspect() : inspect(plan);
    return `${sqlText}\n${inspected}`;
  } catch (error) {
    return textOf(error);
  }
}

function planOf(handle: Loose, item: CompositionCase): unknown {
  if (item.operation === "find") return handle.notes.find({ where: { id: "a" }, limit: 5 });
  if (item.operation === "page") return handle.notes.page({ orderBy: { id: "asc" }, limit: 1 });
  if (item.operation === "stream") return handle.notes.find({ orderBy: { id: "asc" }, limit: 10 });
  if (item.operation === "aggregate") return handle.notes.aggregate({ count: true });
  return writeOp(handle, item);
}

function leakOf(
  item: CompositionCase,
  outcome: Outcome,
  row: Row | undefined,
  described: string,
): string | undefined {
  // The token may sit on the returned row. sql(), inspect(), and errors may not.
  const blobs = [
    described,
    textOf(outcome.error),
    JSON.stringify(scrubValue(outcome.value)),
    JSON.stringify(scrubValue(row)),
  ];
  const joined = blobs.join("\n");
  if (joined.includes(CANARY_HIDDEN)) return `hidden ${label(item)}`;
  if (joined.includes(CANARY_TOKEN)) return `token ${label(item)}`;
  return undefined;
}

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "token") continue;
      out[key] = scrubValue(item);
    }
    return out;
  }
  return value;
}

function isRead(operation: CompositionCase["operation"]): boolean {
  return (
    operation === "find" ||
    operation === "page" ||
    operation === "stream" ||
    operation === "aggregate"
  );
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

function codeOf(error: unknown): string {
  return error instanceof OkmError ? error.code : "";
}

function textOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return "";
  return JSON.stringify(error);
}

function label(item: CompositionCase): string {
  return [
    `operation=${item.operation}`,
    `versioned=${String(item.versioned)}`,
    `archivable=${String(item.archivable)}`,
    `tenancy=${item.tenancy}`,
    `conceal=${item.conceal}`,
    `batch=${item.batch}`,
    `isolation=${item.isolation}`,
    `casing=${item.casing}`,
  ].join(" ");
}

function fail(item: CompositionCase, message: string): never {
  throw new Error(`${label(item)}\n${message.split("\n")[0]}`);
}

type Row = {
  id?: string;
  NoteBody?: string;
  n?: number;
  version?: number;
  token?: string;
  code?: string;
  count?: number;
};

type Outcome = { value?: unknown; error?: unknown };
