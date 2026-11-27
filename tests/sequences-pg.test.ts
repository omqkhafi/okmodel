/**
 * Sequences, counters, and numbered references on PostgreSQL.
 *
 * NEON_* and SUPABASE_* are ignored. The topology URL is the local primary.
 */

import { afterAll, expect } from "bun:test";
import postgres, { type Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { schema, sql as sqlText, t, table } from "../src/dialects/pg/index.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { numbered, sequence } from "../src/dialects/pg/seq/index.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { sealAuthored } from "../src/tooling/migrate/drift.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { sequenceFindings } from "../src/tooling/migrate/series-doctor.js";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("NEON_") || key.startsWith("SUPABASE_")) delete process.env[key];
}

const gate = await loadPostgresGate();

const docNo = sequence("doc_no");
const yearNo = sequence("year_no", { reset: "year", at: "Asia/Riyadh" });
const issueNo = sequence("issue_no");

function declared() {
  return schema({
    tables: [
      table("ids", { id: t.identity({ generated: "byDefault", start: 4, increment: 2 }) }),
      table("notes", { number: sequence({ start: 3, increment: 1 }).column(), title: t.text() }),
      table("docs", {
        tenantId: t.uuid(),
        number: docNo.column({ scope: ["tenantId"] }),
      }),
      table("years", {
        tenantId: t.uuid(),
        issued: t.timestamptz(),
        number: yearNo.column({ by: "issued", scope: ["tenantId"] }),
      }),
      table("issued", {
        ready: t.boolean(),
        number: issueNo.column({
          when: (columns) => {
            const ready = columns.ready;
            if (ready === undefined) return sqlText`true`;
            return sqlText`${ready} = true`;
          },
        }),
      }),
      table("invoices", {
        number: sequence().column(),
        reference: t.text().generated(() => numbered("number", { prefix: "INV-", pad: 6 })),
      }),
    ],
  });
}

postgresTest(
  gate,
  "proof:identity.options",
  async () => {
    const proof = await once();
    const column = proof.live.objects.find(
      (object) => object.kind === "column" && object.identity.name === "id",
    );
    expect(column?.kind === "column" && column.definition.identity?.always).toBe(false);
    expect(column?.kind === "column" && column.definition.identity?.start).toBe("4");
    expect(column?.kind === "column" && column.definition.identity?.increment).toBe("2");
  },
  180_000,
);

postgresTest(
  gate,
  "proof:sequence.native",
  async () => {
    const proof = await once();
    expect(
      proof.live.objects.some(
        (object) => object.kind === "sequence" && object.identity.name === "notes_number_seq",
      ),
    ).toBe(true);
  },
  180_000,
);

postgresTest(
  gate,
  "proof:sequence.counter",
  async () => {
    const proof = await once();
    const column = proof.live.objects.find(
      (object) =>
        object.kind === "column" &&
        object.identity.parent.name === "docs" &&
        object.identity.name === "number",
    );
    expect(column?.kind === "column" && column.definition.series?.name).toBe("doc_no");
    expect(
      proof.live.objects.some(
        (object) => object.kind === "table" && object.identity.name.startsWith("okm_ctr_"),
      ),
    ).toBe(false);
  },
  180_000,
);

postgresTest(
  gate,
  "proof:sequence.reset",
  async () => {
    const proof = await once();
    const column = proof.live.objects.find(
      (object) =>
        object.kind === "column" &&
        object.identity.parent.name === "years" &&
        object.identity.name === "number",
    );
    expect(column?.kind === "column" && column.definition.series?.reset).toBe("year");
    expect(column?.kind === "column" && column.definition.series?.at).toBe("Asia/Riyadh");
  },
  180_000,
);

postgresTest(
  gate,
  "proof:sequence.when",
  async () => {
    const proof = await once();
    const column = proof.live.objects.find(
      (object) =>
        object.kind === "column" &&
        object.identity.parent.name === "issued" &&
        object.identity.name === "number",
    );
    expect(
      column?.kind === "column" && (column.definition.series?.when?.includes("ready") ?? false),
    ).toBe(true);
  },
  180_000,
);

postgresTest(
  gate,
  "proof:sequence.numbered",
  async () => {
    const proof = await once();
    const column = proof.live.objects.find(
      (object) =>
        object.kind === "column" &&
        object.identity.parent.name === "invoices" &&
        object.identity.name === "reference",
    );
    expect(
      column?.kind === "column" && column.definition.generated?.expression.includes("lpad"),
    ).toBe(true);
  },
  180_000,
);

postgresTest(
  gate,
  "counter numbers, rollback, scope, reset, moves, and doctor",
  async () => {
    const proof = await once();
    const sql = proof.sql;
    const tenantA = "11111111-1111-4111-8111-111111111111";
    const tenantB = "22222222-2222-4222-8222-222222222222";

    await sql.unsafe("begin");
    const rolled = await sql<
      { number: string }[]
    >`insert into docs ("tenantId") values (${tenantA}) returning number`;
    await sql.unsafe("rollback");
    const again = await sql<
      { number: string }[]
    >`insert into docs ("tenantId") values (${tenantA}) returning number`;
    expect(again[0]?.number).toBe(rolled[0]?.number);

    const first = await sql<
      { number: string }[]
    >`insert into notes (title) values ('a') returning number`;
    await sql.unsafe("begin");
    await sql`insert into notes (title) values ('b')`;
    await sql.unsafe("rollback");
    const third = await sql<
      { number: string }[]
    >`insert into notes (title) values ('c') returning number`;
    expect(Number(third[0]?.number)).toBeGreaterThan(Number(first[0]?.number) + 1);

    const raw = await sql<
      { number: string }[]
    >`insert into docs ("tenantId") values (${tenantB}) returning number`;
    expect(raw[0]?.number).toBe("1");

    await proof.hold.unsafe("begin");
    await proof.hold`insert into docs ("tenantId") values (${tenantA})`;
    const other = postgres(proof.url, { max: 1, connect_timeout: 5 });
    const side = postgres(proof.url, { max: 1, connect_timeout: 5 });
    let waitingDone = false;
    const waiting = other`insert into docs ("tenantId") values (${tenantA}) returning number`.then(
      (rows) => {
        waitingDone = true;
        return rows[0]?.number;
      },
    );
    await Bun.sleep(300);
    expect(waitingDone).toBe(false);
    const free = await side<
      { number: string }[]
    >`insert into docs ("tenantId") values (${tenantB}) returning number`;
    expect(free[0]?.number).toBe("2");
    await proof.hold.unsafe("commit");
    const waited = await waiting;
    expect(waited).not.toBe(again[0]?.number);
    await other.end({ timeout: 5 });
    await side.end({ timeout: 5 });

    const boundary = "2026-12-31 22:30:00+00";
    await sql`insert into years ("tenantId", issued) values (${tenantA}, ${boundary})`;
    const period = await sql<{ period: string }[]>`select period from okm_ctr_year_no`;
    expect(period[0]?.period.startsWith("2027")).toBe(true);

    await sql`insert into issued (ready) values (false)`;
    const deferred = await sql<{ number: string | null }[]>`select number from issued`;
    expect(deferred[0]?.number).toBeNull();
    await sql`update issued set ready = true`;
    const assigned = await sql<{ number: string }[]>`select number from issued`;
    expect(assigned[0]?.number).toBe("1");

    let refused = false;
    try {
      await sql`update docs set "tenantId" = ${tenantB} where "tenantId" = ${tenantA} and number = ${again[0]?.number ?? "1"}`;
    } catch (error) {
      refused = error instanceof Error && error.message.includes("refuses");
    }
    expect(refused).toBe(true);

    await sql`insert into invoices (number) values (1234567)`;
    const reference = await sql<{ reference: string }[]>`select reference from invoices`;
    expect(reference[0]?.reference).toBe("INV-1234567");

    await sql`insert into ids (id) values (40)`;
    const findings = await sequenceFindings(runnerOf(sql), "public");
    expect(findings.some((item) => item.summary.includes("setval"))).toBe(true);
  },
  180_000,
);

postgresTest(
  gate,
  "proof:grants.sequence",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const roles = {
      migration: { name: "okm_migrate" },
      app: { name: "okm_app" },
    };
    try {
      await sql.unsafe(
        "do $$ begin if not exists (select 1 from pg_roles where rolname = 'okm_app') then create role okm_app; end if; end $$",
      );
      const built = schema({
        tables: [
          table("notes", {
            number: sequence({ grants: { app: ["usage", "select", "update"] } }).column(),
            title: t.text(),
          }),
        ],
      });
      const after = attachRoles(built.catalog, roles);
      await apply(sql, catalog([]), after);
      const wide = await privileges(sql);
      expect(wide).toContain("USAGE");
      expect(wide).toContain("SELECT");
      expect(wide).toContain("UPDATE");
      const narrowed = schema({
        tables: [
          table("notes", {
            number: sequence({ grants: { app: ["usage"] } }).column(),
            title: t.text(),
          }),
        ],
      });
      const next = attachRoles(narrowed.catalog, roles);
      const plan = planMigration({ before: after, after: next, name: "revoke" });
      for (const step of plan.steps) await sql.unsafe(step.sql);
      expect(await privileges(sql)).toEqual(["USAGE"]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  180_000,
);

async function privileges(sql: Sql): Promise<string[]> {
  const rows = await sql<{ privilege: string }[]>`
    select a.privilege_type as privilege
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    join pg_roles g on g.oid = a.grantee
    where n.nspname = 'public' and c.relkind = 'S' and g.rolname = 'okm_app'
    order by a.privilege_type`;
  return rows.map((row) => row.privilege);
}

type Proof = {
  readonly live: Catalog;
  readonly url: string;
  readonly sql: Sql;
  readonly hold: Sql;
  readonly close: () => Promise<void>;
};

let pending: Promise<Proof> | undefined;

afterAll(async () => {
  if (pending === undefined) return;
  const proof = await pending;
  await proof.close();
});

function once(): Promise<Proof> {
  pending ??= runOnce();
  return pending;
}

async function runOnce(): Promise<Proof> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  const hold = postgres(database.url, { max: 1, connect_timeout: 5 });
  try {
    const head = declared();
    await apply(sql, catalog([]), head.catalog);
    const live = await read(sql);
    const sealed = await sealAuthored(queryOf(sql), head.catalog);
    const steps = planMigration({ before: live, after: sealed, name: "round" }).steps;
    if (steps.length > 0) {
      throw new Error(steps.map((step) => step.sql).join("\n"));
    }
    return {
      live,
      url: database.url,
      sql,
      hold,
      close: async () => {
        await sql.end({ timeout: 5 });
        await hold.end({ timeout: 5 });
        await database.close();
      },
    };
  } catch (error) {
    await sql.end({ timeout: 5 });
    await hold.end({ timeout: 5 });
    await database.close();
    throw error;
  }
}

async function apply(sql: Sql, before: Catalog, after: Catalog): Promise<void> {
  const plan = planMigration({ before, after, name: "apply" });
  for (const step of plan.steps) await sql.unsafe(step.sql);
}

async function read(sql: Sql): Promise<Catalog> {
  return introspectSchema(queryOf(sql), "public", "public");
}

function queryOf(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}

function runnerOf(sql: Sql) {
  return {
    async execute(text: string, params?: readonly string[]) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return {
        rows: rows.map((row) =>
          Object.values(row).map((value) =>
            value === null || value === undefined ? null : String(value),
          ),
        ),
        count: rows.count ?? rows.length,
        notices: [],
      };
    },
  };
}
