/**
 * Typed raw SQL and `explain()` on a fake pool, and routing reasons from `inspect()`.
 *
 * Real rows are `sql-lane-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import {
  explain,
  fragment,
  ident,
  one,
  raw,
  schema,
  t,
  table,
  uuid,
} from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { connectTopology } from "../src/runtime/topology.js";
import { archivable } from "../src/runtime/traits/index.js";
import { columnTenancy, compositeTenancy, via } from "../src/runtime/tenancy/index.js";

const TENANT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const PAYLOAD = "'; drop table notes; --";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
  secret: t.text().hidden().nullable(),
  code: t.text().hidden({ filterable: true }).nullable(),
});

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});

const plain = schema({
  casing: "snake",
  tables: [table("notes", { id: t.text().primaryKey(), title: t.text() })],
});

const archived = schema({
  casing: "snake",
  tables: [
    table("notes", { id: t.text().primaryKey(), title: t.text() }, { traits: [archivable()] }),
  ],
});

class NoteRow {
  id = "";
  title = "";
  n = 0;
}

class ProjectRow {
  id = "";
}

type Call = {
  readonly text: string;
  readonly params: readonly (string | null)[] | undefined;
  readonly route: string | undefined;
};

test("a raw read binds parameters, decodes the class, and keeps the tenant predicate", async () => {
  const calls: Call[] = [];
  const db = connect(
    recording(calls, () => [["n1", "hello", "4"]]),
    { schema: app },
  );
  await db.connected;
  calls.length = 0;
  const scoped = db.for({ tenantId: TENANT });
  const rows = await raw(
    scoped.notes,
    NoteRow,
    "read",
    fragment`select ${ident("id")}, ${ident("title")}, ${3} from notes where ${ident("title")} = ${PAYLOAD}`,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toBeInstanceOf(NoteRow);
  expect(rows[0]?.id).toBe("n1");
  expect(rows[0]?.title).toBe("hello");
  expect(rows[0]?.n).toBe(4);
  const sent = calls.filter((call) => !call.text.startsWith("select current_setting"));
  expect(sent).toHaveLength(1);
  const text = sent[0]?.text ?? "";
  expect(text.startsWith("select okm_raw.* from (")).toBe(true);
  expect(text).toContain('"tenant_id"');
  expect(text).toContain('okm_raw."id"');
  expect(text).not.toContain(PAYLOAD);
  expect(sent[0]?.params).toContain(PAYLOAD);
  expect(sent[0]?.params).toContain(TENANT);
  expect(sent[0]?.route).toBeUndefined();
});

test("a raw read renumbers two tenant markers past nine user parameters", async () => {
  const organization = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c11";
  const workspace = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";
  const organizations = table("organizations", { id: uuid().primaryKey(), name: t.text() });
  const projects = table(
    "projects",
    {
      id: t.text().primaryKey(),
      name: t.text(),
      organizationId: uuid().references("organizations"),
    },
    {
      tenancy: via("organization"),
      relations: { organization: one("organizations", "organizationId") },
    },
  );
  const scopedSchema = schema({
    casing: "snake",
    tenancy: compositeTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" }),
    tables: [organizations, projects],
  });
  const calls: Call[] = [];
  const db = connect(
    recording(calls, () => [["p1"]]),
    { schema: scopedSchema },
  );
  await db.connected;
  calls.length = 0;
  const scoped = db.for({ organizationId: organization, workspaceId: workspace });
  await raw(
    scoped.projects,
    ProjectRow,
    "read",
    fragment`select ${ident("id")} from projects where ${ident("id")} <> ${"u1"} and ${ident("id")} <> ${"u2"} and ${ident("id")} <> ${"u3"} and ${ident("id")} <> ${"u4"} and ${ident("id")} <> ${"u5"} and ${ident("id")} <> ${"u6"} and ${ident("id")} <> ${"u7"} and ${ident("id")} <> ${"u8"} and ${ident("id")} <> ${"u9"}`,
  );
  const sent = calls.filter((call) => !call.text.startsWith("select current_setting"));
  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).toBe(
    'select okm_raw.* from (select "id" from projects where "id" <> $1 and "id" <> $2 and "id" <> $3 and "id" <> $4 and "id" <> $5 and "id" <> $6 and "id" <> $7 and "id" <> $8 and "id" <> $9) as okm_raw where okm_raw."id" in (select "id" from "projects" as okm_tenant where exists (select 1 from "organizations" p0 where p0."id" = okm_tenant."organization_id" and p0."organization_id" = $10 and p0."workspace_id" = $11))',
  );
  expect(sent[0]?.params).toEqual([
    "u1",
    "u2",
    "u3",
    "u4",
    "u5",
    "u6",
    "u7",
    "u8",
    "u9",
    organization,
    workspace,
  ]);
});

test("a hidden field is refused through ident, including a filterable one", async () => {
  const calls: Call[] = [];
  const db = connect(
    recording(calls, () => []),
    { schema: app },
  );
  await db.connected;
  calls.length = 0;
  const scoped = db.for({ tenantId: TENANT });
  const secret = await thrown(() =>
    raw(
      scoped.notes,
      NoteRow,
      "read",
      fragment`select ${ident("id")}, ${ident("secret")} from notes`,
    ),
  );
  expect(secret.code).toBe("OKM1120");
  expect(secret.fix.summary).toContain("hidden");
  const code = await thrown(() =>
    raw(
      scoped.notes,
      NoteRow,
      "read",
      fragment`select ${ident("id")}, ${ident("code")} from notes`,
    ),
  );
  expect(code.code).toBe("OKM1120");
  expect(calls.filter((call) => !call.text.startsWith("select current_setting"))).toEqual([]);
});

test("a raw write on a tenant table is OKM1702 and a read without the key is too", async () => {
  const calls: Call[] = [];
  const db = connect(
    recording(calls, () => []),
    { schema: app },
  );
  await db.connected;
  calls.length = 0;
  const scoped = db.for({ tenantId: TENANT });
  const write = await thrown(() =>
    raw(scoped.notes, NoteRow, "write", fragment`delete from notes where ${ident("id")} = ${"n1"}`),
  );
  expect(write.code).toBe("OKM1702");
  expect(write.fix.summary.length).toBeGreaterThan(0);
  const missing = await thrown(() =>
    raw(scoped.notes, NoteRow, "read", fragment`select ${ident("title")} from notes`),
  );
  expect(missing.code).toBe("OKM1702");
  expect(calls.filter((call) => !call.text.startsWith("select current_setting"))).toEqual([]);
});

test("a bad statement is OKM1602", async () => {
  const db = connect(
    recording([], () => []),
    { schema: app },
  );
  await db.connected;
  const scoped = db.for({ tenantId: TENANT });
  class Empty {
    declare id: string;
  }
  const empty = await thrown(() =>
    raw(scoped.notes, Empty, "read", fragment`select ${ident("id")} from notes`),
  );
  expect(empty.code).toBe("OKM1602");
  expect(empty.fix.summary.length).toBeGreaterThan(0);
  const text = await thrown(() => raw(scoped.notes, NoteRow, "read", "select 1"));
  expect(text.code).toBe("OKM1602");
  const kind = await thrown(() => raw(scoped.notes, NoteRow, "read", fragment`delete from notes`));
  expect(kind.code).toBe("OKM1602");
  const missing = await thrown(() => {
    const root = db as unknown as { table(name: string): object };
    return raw(root.table("notes"), NoteRow, "read", fragment`select ${ident("id")} from notes`);
  });
  expect(missing.code).toBe("OKM1701");
});

test("a non-tenant write runs on the primary and an archived read keeps the active set", async () => {
  const calls: Call[] = [];
  const db = connect(
    recording(calls, () => []),
    { schema: plain },
  );
  await db.connected;
  calls.length = 0;
  const gone = await raw(
    db.notes,
    NoteRow,
    "write",
    fragment`delete from notes where ${ident("id")} = ${"n1"}`,
  );
  expect(gone).toEqual([]);
  expect(calls.at(-1)?.text.startsWith("delete")).toBe(true);
  expect(calls.at(-1)?.text).not.toContain("okm_raw");
  expect(calls.at(-1)?.route).toBe("primary");

  const stored: Call[] = [];
  const files = connect(
    recording(stored, () => []),
    { schema: archived },
  );
  await files.connected;
  stored.length = 0;
  await raw(
    files.notes,
    NoteRow,
    "read",
    fragment`select ${ident("id")}, ${ident("title")} from notes`,
  );
  const text = stored.at(-1)?.text ?? "";
  expect(text).toContain("okm_raw");
  expect(text).toContain("is null");
});

test("explain returns the plan outside production and sends nothing in production", async () => {
  const calls: Call[] = [];
  const db = connect(
    recording(calls, () => []),
    { schema: plain },
  );
  await db.connected;
  calls.length = 0;
  const seen = await explain(db.notes, db.notes.find({ limit: 1 }));
  expect(seen.plan).toEqual(["Seq Scan on notes"]);
  expect(seen.text.toLowerCase()).toContain("notes");
  expect(seen.params.length).toBeGreaterThan(0);
  expect(calls.some((call) => call.text.startsWith("explain "))).toBe(true);

  calls.length = 0;
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const hidden = await explain(db.notes, db.notes.find({ limit: 1 }));
    expect(hidden.plan).toBeNull();
    expect(hidden.params).toEqual([]);
    expect(hidden.text.toLowerCase()).toContain("notes");
    expect(calls.some((call) => call.text.startsWith("explain "))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("a single endpoint inspect stays synchronous", async () => {
  const db = connect(
    recording([], () => []),
    { schema: plain },
  );
  await db.connected;
  const seen = db.notes.find({ limit: 1 }).inspect();
  expect(seen).not.toBeInstanceOf(Promise);
  if (seen instanceof Promise) return;
  expect(seen.routing).toEqual({
    endpoint: "primary",
    role: "primary",
    reason: "single-endpoint",
  });
});

test("inspect on a topology reports the routing reason and does not move the selector", async () => {
  const opened: { url: string; sql: string[] }[] = [];
  const reasons: string[] = [];
  const db = await connectTopology(
    {
      primary: "postgres://primary/db",
      replicas: [{ url: "postgres://east/db", weight: 2, name: "east" }, "postgres://west/db"],
    },
    {
      schema: plain,
      routing: { probe: 60_000 },
      onRoute(event) {
        reasons.push(event.reason);
      },
    },
    (config) => {
      const sql: string[] = [];
      opened.push({ url: config.url, sql });
      return recordingPool(sql);
    },
  );
  await db.connected;
  const notesOf = (url: string) =>
    opened.find((endpoint) => endpoint.url === url)?.sql.filter((text) => text.includes("notes"))
      .length ?? 0;
  const eastBefore = notesOf("postgres://east/db");
  const westBefore = notesOf("postgres://west/db");
  reasons.length = 0;
  const automatic = await db.notes.find({ limit: 1 }).inspect();
  expect(automatic.routing).toEqual({ endpoint: "east", role: "replica", reason: "auto:east" });
  expect(reasons).toEqual([]);
  expect(notesOf("postgres://east/db")).toBe(eastBefore);
  const forced = await db.notes.find({ limit: 1, route: "primary" }).inspect();
  expect(forced.routing).toEqual({
    endpoint: "primary",
    role: "primary",
    reason: "constraint:primary",
  });
  const replicaClient = db.using("replica");
  await replicaClient.connected;
  const replica = await replicaClient.notes.find({ limit: 1 }).inspect();
  expect(replica.routing.reason).toBe("constraint:replica");
  expect(replica.routing.role).toBe("replica");
  reasons.length = 0;
  await db.notes.find({ limit: 1 });
  expect(notesOf("postgres://east/db")).toBe(eastBefore + 1);
  expect(notesOf("postgres://west/db")).toBe(westBefore);
  expect(reasons).toEqual(["auto:east"]);
  await db.close();
});

function recording(calls: Call[], rows: () => readonly (readonly (string | null)[])[]): DriverPool {
  return {
    capabilities: {
      transactions: "none",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "unnamed",
      describe: false,
    },
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
    execute(text, params, options) {
      calls.push({ text, params, route: options?.route });
      if (text.startsWith("select current_setting")) {
        return Promise.resolve({
          rows: [["170000", "PostgreSQL 17.1", null]],
          count: 1,
          notices: [],
        });
      }
      if (text.startsWith("explain ")) {
        return Promise.resolve({ rows: [["Seq Scan on notes"]], count: 1, notices: [] });
      }
      const body = rows();
      return Promise.resolve({ rows: body, count: body.length, notices: [] });
    },
    batch: () => Promise.resolve([]),
  };
}

function recordingPool(sql: string[]): DriverPool {
  return {
    capabilities: {
      transactions: "none",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "unnamed",
      describe: false,
    },
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    execute(text) {
      sql.push(text);
      if (text.startsWith("select current_setting")) {
        return Promise.resolve({
          rows: [["170000", "PostgreSQL 17.1", null]],
          count: 1,
          notices: [],
        });
      }
      if (text.includes("has_function_privilege")) {
        return Promise.resolve({ rows: [["t"]], count: 1, notices: [] });
      }
      if (text.includes("pg_last_wal_replay_lsn")) {
        return Promise.resolve({ rows: [["1", "0/16B3748"]], count: 1, notices: [] });
      }
      return Promise.resolve({ rows: [], count: 0, notices: [] });
    },
    batch: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  };
}

async function thrown(run: () => Promise<unknown>): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) return error;
  }
  throw new Error("expected OkmError");
}
