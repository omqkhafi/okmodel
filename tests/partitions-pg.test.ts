/**
 * Partition round trips, bounds, conversion, and the no-partition error.
 *
 * Proof titles are the registry strings. The server is the thing under test.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "postgres";

import { DriverError } from "../src/adapters/error.js";
import type { DriverConnection } from "../src/contracts/driver.js";
import { catalog } from "../src/contracts/catalog/build.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { OkmError } from "../src/contracts/error.js";
import type { TableObject } from "../src/contracts/catalog/types.js";
import { mapPostgresError } from "../src/dialects/pg/errors.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { parseBound, sameBound } from "../src/dialects/pg/partition-compile.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { openPostgres, withPostgresSchema } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import {
  assertPartitionManager,
  describePartitions,
  maintainPartitions,
  partitionDoctorLines,
} from "../src/tooling/migrate/partition-maintain.js";
import { guardPartitionRows } from "../src/tooling/migrate/partition-probe.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { poolerConfig, POOLER_PORT } from "../scripts/pooler-proof.js";

const gate = await loadPostgresGate();

postgresTest(gate, "proof:partition.range", async () => {
  await withPostgresSchema(async (sql, name) => {
    const app = events("range");
    await roundTrip(sql, name, app);
    await sql.unsafe(`set time zone 'UTC'`);
    const child = await sql<{ bound: string }[]>`
      select pg_get_expr(c.relpartbound, c.oid) as bound
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${name} and c.relname = 'events_2026_03'
    `;
    expect(child[0]?.bound).toContain("2026-02-28 21:00:00+00");
  });
});

postgresTest(gate, "proof:partition.list", async () => {
  await withPostgresSchema(async (sql, name) => {
    await roundTrip(sql, name, events("list"));
  });
});

postgresTest(gate, "proof:partition.hash", async () => {
  await withPostgresSchema(async (sql, name) => {
    await roundTrip(sql, name, events("hash"));
  });
});

postgresTest(gate, "proof:partition.external", async () => {
  await withPostgresSchema(async (sql, name) => {
    await roundTrip(sql, name, events("external"));
    const children = await sql<{ n: string }[]>`
      select c.relname as n
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_class p on p.oid = i.inhparent
      join pg_namespace n on n.oid = p.relnamespace
      where n.nspname = ${name} and p.relname = 'events'
    `;
    expect(children.map((row) => row.n)).toEqual([]);
  });
});

postgresTest(
  gate,
  "a New York month bound is the same instant in UTC and in the session zone",
  async () => {
    await withPostgresSchema(async (sql, name) => {
      await sql.unsafe(`
      create table ${name}.days (
        id int,
        at timestamptz,
        primary key (id, at)
      ) partition by range (at)
    `);
      await sql.unsafe(`
      create table ${name}.days_2026_03 partition of ${name}.days
      for values from ('2026-03-01 00:00:00-05') to ('2026-04-01 00:00:00-04')
    `);
      await sql.unsafe(`set time zone 'UTC'`);
      const utc = await sql<{ bound: string }[]>`
      select pg_get_expr(c.relpartbound, c.oid) as bound
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${name} and c.relname = 'days_2026_03'
    `;
      await sql.unsafe(`set time zone 'America/New_York'`);
      const local = await sql<{ bound: string }[]>`
      select pg_get_expr(c.relpartbound, c.oid) as bound
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${name} and c.relname = 'days_2026_03'
    `;
      expect(utc[0]?.bound).toContain("2026-03-01 05:00:00+00");
      expect(local[0]?.bound).not.toContain("+00");
      expect(local[0]?.bound).toContain("2026-03-01 00:00:00");
    });
  },
);

postgresTest(gate, "proof:partition.maintain", async () => {
  await withPostgresSchema(async (sql, name) => {
    const app = events("range");
    const tableObject = app.catalog.objects.find((object) => object.kind === "table");
    if (tableObject?.kind !== "table") throw new Error("missing");
    await roundTrip(sql, name, app);
    await sql.unsafe(`drop table ${name}."events_2026_01"`);
    const url = primaryUrl();
    const before = await describePartitions(url, name, tableObject);
    expect(before.children.some((child) => child.suffix === "2026_01")).toBe(false);
    const maintained = await maintainPartitions({
      url,
      schema: name,
      catalog: app.catalog,
      table: tableObject,
      dryRun: false,
      allowProtected: false,
      lockTimeoutMs: 1000,
      lockWaitMs: 5000,
    });
    expect(maintained.statements.length).toBeGreaterThan(0);
    const after = await describePartitions(url, name, tableObject);
    expect(after.children.some((child) => child.suffix === "2026_01")).toBe(true);
  });
});

postgresTest(gate, "proof:partition.convert", async () => {
  await withPostgresSchema(async (sql, name) => {
    await roundTrip(sql, name, plainEvents());
    await sql.unsafe(
      `alter table ${name}.events alter column "id" add generated by default as identity`,
    );
    await sql.unsafe(
      `insert into ${name}.events ("occurredAt", "body") values ('2026-01-15 00:00:00+00', 'kept')`,
    );
    const app = events("range");
    const before = await introspectSchema(queryOf(sql), name, "public");
    const plan = planMigration({ before, after: app.catalog, schema: name, name: "convert" });
    expect(plan.steps.some((step) => step.sql.toLowerCase().includes("attach partition"))).toBe(
      true,
    );
    expect(plan.steps.some((step) => step.weight === "blocking")).toBe(true);
    for (const step of plan.steps) await sql.unsafe(step.sql);
    const rows = await sql.unsafe<{ body: string }[]>(`select "body" as body from ${name}.events`);
    expect(rows.map((row) => row.body)).toEqual(["kept"]);
    const again = planMigration({
      before: await introspectSchema(queryOf(sql), name, "public"),
      after: app.catalog,
      schema: name,
      name: "again",
    });
    expect(again.steps.map((step) => step.sql)).toEqual([]);
  });
});

postgresTest(gate, "a dependent view blocks conversion and names the view", async () => {
  await withPostgresSchema(async (sql, name) => {
    await roundTrip(sql, name, plainEvents());
    await sql.unsafe(`create view ${name}.events_v as select "id" from ${name}.events`);
    const before = await introspectSchema(queryOf(sql), name, "public");
    expect(() =>
      planMigration({ before, after: events("range").catalog, schema: name, name: "blocked" }),
    ).toThrow(/events_v/);
  });
});

postgresTest(gate, "an inbound foreign key blocks conversion and names the table", async () => {
  await withPostgresSchema(async (sql, name) => {
    await roundTrip(sql, name, plainEvents());
    await sql.unsafe(`create unique index events_id_key on ${name}.events ("id")`);
    await sql.unsafe(`
      create table ${name}.notes (
        "id" int primary key,
        "eventId" int not null references ${name}.events ("id")
      )
    `);
    const before = await introspectSchema(queryOf(sql), name, "public");
    expect(() =>
      planMigration({ before, after: events("range").catalog, schema: name, name: "blocked" }),
    ).toThrow(/notes/);
  });
});

postgresTest(gate, "rows outside the first partition refuse before the lock", async () => {
  await withPostgresSchema(async (sql, name) => {
    await sql.unsafe(`
      create table ${name}.events (
        "id" int primary key,
        "occurredAt" timestamptz not null,
        "body" text
      )
    `);
    await sql.unsafe(
      `insert into ${name}.events ("id", "occurredAt") values (1, '2030-06-01 00:00:00+00')`,
    );
    const before = await introspectSchema(queryOf(sql), name, "public");
    const plan = planMigration({
      before,
      after: events("range").catalog,
      schema: name,
      name: "outside",
    });
    const connection = {
      execute: async (statement: string) => {
        const rows = await sql.unsafe(statement);
        return {
          rows: rows.map((row) => Object.values(row).map((value) => String(value))),
          count: rows.length,
          notices: [],
        };
      },
      batch: async () => [],
      release: async () => undefined,
    } as DriverConnection;
    let refused = false;
    try {
      await guardPartitionRows(
        connection,
        plan.steps.map((step) => step.sql),
      );
    } catch (error) {
      refused = String(error).includes("outside the partition");
    }
    expect(refused).toBe(true);
    const kind = await sql<{ relkind: string }[]>`
      select relkind from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${name} and c.relname = 'events'
    `;
    expect(kind[0]?.relkind).toBe("r");
  });
});

postgresTest(gate, "a row with no partition is check no_partition", async () => {
  await withPostgresSchema(async (sql, name) => {
    await roundTrip(sql, name, events("range"));
    try {
      await sql.unsafe(
        `insert into ${name}.events ("id", "occurredAt") values (1, '2030-06-01 00:00:00+00')`,
      );
      throw new Error("insert should fail");
    } catch (error) {
      const pg = error as { code?: string; constraint_name?: string; message?: string };
      const mapped = mapPostgresError(
        new DriverError(pg.message ?? "no partition", {
          ...(typeof pg.code === "string" ? { sqlstate: pg.code } : {}),
          ...(pg.constraint_name !== undefined && pg.constraint_name.length > 0
            ? { constraint: pg.constraint_name }
            : {}),
        }),
      );
      expect(mapped.kind).toBe("check");
      expect(mapped.fieldReason).toBe("no_partition");
    }
  });
});

postgresTest(gate, "a partitioned parent accepts a statement-level transition table", async () => {
  await withPostgresSchema(async (sql, name) => {
    await sql.unsafe(`
      create table ${name}.events (
        id int,
        occurred_at timestamptz,
        primary key (id, occurred_at)
      ) partition by range (occurred_at)
    `);
    await sql.unsafe(`
      create function ${name}.note() returns trigger language plpgsql as $$
      begin return null; end $$
    `);
    await sql.unsafe(`
      create trigger ev_parent after insert on ${name}.events
      referencing new table as new_rows
      for each statement execute function ${name}.note()
    `);
    const found = await sql<{ n: string }[]>`
      select tgname as n from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = ${name} and not t.tgisinternal
    `;
    expect(found.map((row) => row.n)).toContain("ev_parent");
  });
});

postgresTest(gate, "okm check fails when partman lists an okm-managed table", async () => {
  await withPostgresSchema(async (sql, name) => {
    await sql.unsafe(`create schema if not exists partman`);
    // pg_partman part_config: parent_table is the primary key. control,
    // partition_interval, and partition_type are NOT NULL and have no default.
    // The check reads parent_table only. This is the stub of that shape, not
    // an install of the extension.
    await sql.unsafe(`drop table if exists partman.part_config`);
    await sql.unsafe(`
      create table partman.part_config (
        parent_table text not null primary key,
        control text not null,
        partition_interval text not null,
        partition_type text not null,
        premake int not null default 4
      )
    `);
    await sql`
      insert into partman.part_config (parent_table, control, partition_interval, partition_type)
      values (${`${name}.events`}, 'occurred_at', '1 month', 'range')
    `;
    const app = events("range");
    let refused = false;
    try {
      await assertPartitionManager(primaryUrl(), app.catalog, name);
    } catch (error) {
      refused = String(error).includes("partman");
    }
    expect(refused).toBe(true);
    await sql`delete from partman.part_config where parent_table = ${`${name}.events`}`;
  });
});

postgresTest(gate, "a numeric range round-trips", async () => {
  await withPostgresSchema(async (sql, name) => {
    const app = schema({
      tables: [
        table(
          "events",
          { id: t.integer(), n: t.integer(), body: t.text() },
          {
            primaryKey: ["id", "n"],
            partition: { by: "range", key: "n", every: "100", from: "0", ahead: 2 },
          },
        ),
      ],
    });
    await roundTrip(sql, name, app);
  });
});

postgresTest(gate, "doctor warns when a declared partition is missing", async () => {
  await withPostgresSchema(async (sql, name) => {
    const app = events("range");
    await roundTrip(sql, name, app);
    await sql.unsafe(`drop table ${name}."events_2026_01"`);
    const lines = await partitionDoctorLines(primaryUrl(), app.catalog, name);
    expect(lines.some((line) => line.includes("ahead is not satisfied"))).toBe(true);
  });
});

postgresTest(
  gate,
  "lock_timeout retries an attach after a writer commits",
  async () => {
    await withPostgresSchema(async (sql, name) => {
      const app = events("range");
      const tableObject = app.catalog.objects.find((object) => object.kind === "table");
      if (tableObject?.kind !== "table") throw new Error("missing");
      await roundTrip(sql, name, app);
      await sql.unsafe(`drop table ${name}."events_2026_02"`);
      const holder = openPostgres(primaryUrl());
      await holder.unsafe("begin");
      await holder.unsafe(`lock table ${name}.events in share row exclusive mode`);
      const release = (async () => {
        await Bun.sleep(400);
        await holder.unsafe("commit");
        await holder.end({ timeout: 5 });
      })();
      await maintainPartitions({
        url: primaryUrl(),
        schema: name,
        catalog: app.catalog,
        table: tableObject,
        dryRun: false,
        allowProtected: false,
        lockTimeoutMs: 200,
        lockWaitMs: 5000,
      });
      await release;
      const after = await describePartitions(primaryUrl(), name, tableObject);
      expect(after.children.some((child) => child.suffix === "2026_02")).toBe(true);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "a cancelled detach concurrently is finalized by the next maintain",
  async () => {
    await withPostgresSchema(async (sql, name) => {
      const app = events("range");
      const tableObject = app.catalog.objects.find((object) => object.kind === "table");
      if (tableObject?.kind !== "table") throw new Error("missing");
      await roundTrip(sql, name, app);
      const url = primaryUrl();
      const holder = openPostgres(url);
      const worker = openPostgres(url);
      try {
        await holder.unsafe("begin");
        await holder.unsafe(`select * from ${name}.events`);
        const pid = await worker<{ pid: string }[]>`select pg_backend_pid()::text as pid`;
        let detachError = "";
        const detach = worker
          .unsafe(
            `alter table ${name}.events detach partition ${name}."events_2026_01" concurrently`,
          )
          .then(
            () => undefined,
            (error: { code?: string }) => {
              detachError = error.code ?? "";
            },
          );
        await Bun.sleep(500);
        await holder.unsafe(`select pg_cancel_backend(${pid[0]?.pid ?? "0"})`);
        await detach;
        expect(detachError).toBe("57014");
        const pending = await holder<{ pending: boolean }[]>`
        select i.inhdetachpending as pending
        from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${name} and c.relname = 'events_2026_01'
      `;
        expect(pending[0]?.pending).toBe(true);
        await holder.unsafe("commit");
        await maintainPartitions({
          url,
          schema: name,
          catalog: app.catalog,
          table: tableObject,
          dryRun: false,
          allowProtected: false,
          lockTimeoutMs: 1000,
          lockWaitMs: 5000,
        });
        const left = await sql<{ part: boolean }[]>`
        select relispartition as part
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${name} and c.relname = 'events_2026_01'
      `;
        expect(left[0]?.part).toBe(false);
      } finally {
        await holder.end({ timeout: 5 }).catch(() => undefined);
        await worker.end({ timeout: 5 }).catch(() => undefined);
      }
    });
  },
  20_000,
);

postgresTest(gate, "a direct grant on a child is a doctor warning", async () => {
  await withPostgresSchema(async (sql, name) => {
    const app = events("hash");
    await roundTrip(sql, name, app);
    await sql.unsafe(`grant select on ${name}.events_h0 to public`);
    const lines = await partitionDoctorLines(primaryUrl(), app.catalog, name);
    expect(lines.some((line) => line.includes("events_h0"))).toBe(true);
  });
});

postgresTest(
  gate,
  "a bound that crosses daylight saving is the same instant in UTC and in the session zone",
  async () => {
    await withPostgresSchema(async (sql, name) => {
      const app = schema({
        tables: [
          table(
            "events",
            { id: t.integer(), occurredAt: t.timestamptz(), body: t.text() },
            {
              primaryKey: ["id", "occurredAt"],
              partition: {
                by: "range",
                key: "occurredAt",
                every: "month",
                at: "America/New_York",
                from: "2026-01-01",
                ahead: 12,
              },
            },
          ),
        ],
      });
      await roundTrip(sql, name, app);
      const stored = app.catalog.objects.find((object) => object.kind === "table");
      if (stored?.kind !== "table") throw new Error("missing table");
      for (const suffix of ["2026_03", "2026_11"]) {
        const declared = stored.definition.partition?.children?.find(
          (child) => child.suffix === suffix,
        );
        if (declared?.bound.kind !== "range") throw new Error(`missing ${suffix}`);
        await sql.unsafe(`set time zone 'America/New_York'`);
        const local = await boundText(sql, name, `events_${suffix}`);
        await sql.unsafe(`set time zone 'UTC'`);
        const utc = await boundText(sql, name, `events_${suffix}`);
        const localBound = parseBound(local);
        const utcBound = parseBound(utc);
        expect(localBound).toBeDefined();
        expect(utcBound).toBeDefined();
        expect(sameBound(localBound!, utcBound!)).toBe(true);
        expect(sameBound(utcBound!, declared.bound)).toBe(true);
        const report = await describePartitions(primaryUrl(), name, stored);
        const child = report.children.find((item) => item.suffix === suffix);
        const read = child === undefined ? undefined : parseBound(child.bound);
        expect(read).toBeDefined();
        expect(sameBound(read!, declared.bound)).toBe(true);
      }
    });
  },
);

postgresTest(
  gate,
  "partitions maintain is OKM1854 on PgBouncer, including dry-run",
  async () => {
    if (Bun.which("pgbouncer") === null) return;
    await withPostgresSchema(async (_sql, name) => {
      const app = events("range");
      const stored = app.catalog.objects.find(
        (object): object is TableObject => object.kind === "table",
      );
      if (stored === undefined) throw new Error("missing table");
      await withPgbouncer(primaryUrl(), async (url) => {
        let failed: unknown;
        try {
          await maintainPartitions({
            url,
            schema: name,
            catalog: app.catalog,
            table: stored,
            dryRun: true,
            allowProtected: false,
            lockTimeoutMs: 1_000,
            lockWaitMs: 0,
          });
        } catch (error) {
          failed = error;
        }
        expect(failed).toBeInstanceOf(OkmError);
        if (failed instanceof OkmError) expect(failed.code).toBe("OKM1854");
      });
    });
  },
  60_000,
);

function plainEvents() {
  return schema({
    tables: [
      table(
        "events",
        { id: t.integer(), occurredAt: t.timestamptz(), body: t.text() },
        { primaryKey: ["id", "occurredAt"] },
      ),
    ],
  });
}

function events(form: "range" | "list" | "hash" | "external") {
  if (form === "hash") {
    return schema({
      tables: [
        table(
          "events",
          { id: t.integer(), tenantId: t.integer(), body: t.text() },
          { primaryKey: ["id", "tenantId"], partition: { by: "hash", key: "tenantId", count: 4 } },
        ),
      ],
    });
  }
  if (form === "list") {
    return schema({
      tables: [
        table(
          "events",
          { id: t.integer(), region: t.text(), body: t.text() },
          {
            primaryKey: ["id", "region"],
            partition: { by: "list", key: "region" },
            partitions: { eu: { in: ["eu", "uk"] }, rest: { default: true } },
          },
        ),
      ],
    });
  }
  if (form === "external") {
    return schema({
      tables: [
        table(
          "events",
          { id: t.integer(), occurredAt: t.timestamptz(), body: t.text() },
          {
            primaryKey: ["id", "occurredAt"],
            partition: { by: "range", key: "occurredAt", at: "UTC", children: "external" },
          },
        ),
      ],
    });
  }
  return schema({
    tables: [
      table(
        "events",
        { id: t.integer(), occurredAt: t.timestamptz(), body: t.text() },
        {
          primaryKey: ["id", "occurredAt"],
          partition: {
            by: "range",
            key: "occurredAt",
            every: "month",
            at: "Asia/Riyadh",
            from: "2026-01-01",
            ahead: 1,
          },
        },
      ),
    ],
  });
}

async function roundTrip(
  sql: Sql,
  name: string,
  app: { readonly catalog: Catalog },
): Promise<void> {
  const plan = planMigration({
    before: catalog([]),
    after: app.catalog,
    schema: name,
    name: "create",
  });
  for (const step of plan.steps) await sql.unsafe(step.sql);
  const found = await introspectSchema(queryOf(sql), name, "public");
  const again = planMigration({ before: found, after: app.catalog, schema: name, name: "again" });
  expect(again.steps.map((step) => step.sql)).toEqual([]);
}

async function boundText(sql: Sql, schemaName: string, relname: string): Promise<string> {
  const rows = await sql<{ bound: string }[]>`
    select pg_get_expr(c.relpartbound, c.oid) as bound
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schemaName} and c.relname = ${relname}
  `;
  const bound = rows[0]?.bound;
  if (bound === undefined) throw new Error(`missing bound ${relname}`);
  return bound;
}

async function withPgbouncer(
  databaseUrl: string,
  body: (url: string) => Promise<void>,
): Promise<void> {
  const primary = new URL(databaseUrl);
  const dir = mkdtempSync(join(tmpdir(), "okm-part-pooler-"));
  const port = POOLER_PORT + 30;
  writeFileSync(join(dir, "users.txt"), `"${decodeURIComponent(primary.username)}" ""\n`);
  const dbname = primary.pathname.replace(/^\//, "");
  const ini = poolerConfig(
    primary.hostname,
    primary.port,
    decodeURIComponent(primary.username),
    decodeURIComponent(primary.password),
    dir,
  )
    .replace(`listen_port = ${String(POOLER_PORT)}`, `listen_port = ${String(port)}`)
    .replace("dbname=okm", `dbname=${dbname}`)
    .replace("pool_mode = transaction", "pool_mode = transaction\ndefault_pool_size = 1");
  writeFileSync(join(dir, "pgbouncer.ini"), ini);
  const child = Bun.spawn(["pgbouncer", join(dir, "pgbouncer.ini")], {
    cwd: dir,
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitForPort(port);
    const url = `postgres://${encodeURIComponent(decodeURIComponent(primary.username))}:${encodeURIComponent(decodeURIComponent(primary.password))}@127.0.0.1:${String(port)}/${dbname}`;
    await body(url);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    }).catch(() => undefined);
    if (socket !== undefined) {
      socket.end();
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`pgbouncer did not open 127.0.0.1:${String(port)}`);
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
