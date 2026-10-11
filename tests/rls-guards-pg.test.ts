/**
 * Runtime guards for rlsTenancy on Postgres.
 *
 * A hand-written disable is refused. A live disable is caught by okm check
 * and by the first scoped call. A rolled-back savepoint and a scope switch
 * keep returning the tenant's rows. Each endpoint is checked on its own.
 */

import { expect } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl, replicaUrl } from "../packages/harness/src/topology.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import { RlsRoleError } from "../src/runtime/tenancy/rls.js";
import { rlsTenancy } from "../src/runtime/tenancy/index.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { testing } from "../src/tooling/testing/index.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";
const NOTE_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
const NOTE_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";
const PASSWORD = "rlsappsecret";

const notes = table("notes", { id: id({ default: "none" }), title: text() });
const built = schema({
  casing: "snake",
  tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes],
});

type Kind = "superuser" | "owner" | "bypass" | "plain";

type Scoped = {
  notes: {
    find(options?: {
      limit?: number;
      route?: "replica";
    }): Promise<readonly { id: string; tenantId: string }[]>;
    insert(row: { id: string; title: string }): Promise<{ id: string; tenantId: string }>;
  };
  tx<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
};

type TxClient = Scoped & {
  for(input: { tenantId: string }): Scoped;
};

type Root = {
  for(input: { tenantId: string }): Scoped;
  tx<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

type Target = string | { primary: string; replicas: readonly { name: string; url: string }[] };

const adapters: readonly {
  readonly name: string;
  readonly open: (target: Target, schemaName: string) => Promise<Root>;
}[] = [
  {
    name: "postgres.js",
    open: (target, schemaName) => openWith(connectPostgres, target, schemaName),
  },
  {
    name: "node-postgres",
    open: (target, schemaName) => openWith(connectPg, target, schemaName),
  },
  { name: "Bun.sql", open: (target, schemaName) => openWith(connectBun, target, schemaName) },
];

function openWith(
  connect: (target: never, options: never) => unknown,
  target: Target,
  schemaName: string,
): Promise<Root> {
  const options = { schema: built, searchPath: schemaName, max: 1 };
  return Promise.resolve(connect(target as never, options as never)) as unknown as Promise<Root>;
}

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "migrate check and apply refuse a hand-written disable",
  async () => {
    await withProject(async (cwd) => {
      writeSchema(cwd);
      await run(["generate"], { cwd, stdout() {} });
      const file = readdirSync(join(cwd, "migrations")).find((name) => name.endsWith(".sql"));
      if (file === undefined) throw new Error("generate wrote no migration");
      appendFileSync(
        join(cwd, "migrations", file),
        "\nalter table notes disable row level security;\n",
      );
      let refused: unknown;
      try {
        await run(["migrate", "check"], { cwd, stdout() {} });
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(Error);
      if (refused instanceof Error) expect(refused.message).toContain("OKM1550");
      refused = undefined;
      try {
        await run(["migrate", "apply"], { cwd, stdout() {} });
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(Error);
      if (refused instanceof Error) expect(refused.message).toContain("OKM1550");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "okm check and the first scoped call catch a live disable",
  async () => {
    await withProject(async (cwd, url) => {
      writeSchema(cwd);
      await run(["generate"], { cwd, stdout() {} });
      await run(["migrate", "apply"], { cwd, stdout() {} });
      const admin = postgres(url, { max: 1, onnotice() {} });
      const schemaName = "public";
      const role = "rls_plain_guard";
      try {
        await dropRole(admin, schemaName, role);
        await admin.unsafe(
          `create role ${role} login password '${PASSWORD}' nosuperuser nobypassrls`,
        );
        await admin.unsafe(`grant connect on database ${databaseName(url)} to ${role}`);
        await admin.unsafe(`grant usage on schema ${schemaName} to ${role}`);
        await admin.unsafe(`grant select, insert on all tables in schema ${schemaName} to ${role}`);
        await admin.unsafe(`alter table ${schemaName}.notes disable row level security`);
        const db = await adapters[0]!.open(roleUrl(url, role), schemaName);
        try {
          let caught: unknown;
          try {
            await db.for({ tenantId: TENANT_A }).notes.find({ limit: 1 });
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(OkmError);
          if (caught instanceof OkmError) {
            expect(caught.message).toContain("row-level security");
            expect(caught.message).toContain("Endpoint primary");
          }
        } finally {
          await db.close();
        }
        let drift: unknown;
        try {
          await run(["check"], { cwd, stdout() {} });
        } catch (error) {
          drift = error;
        }
        expect(drift).toBeInstanceOf(OkmError);
        if (drift instanceof OkmError) {
          expect(drift.code).toBe("OKM1520");
          expect(drift.message).toContain("enable row level security");
        }
      } finally {
        await admin.unsafe(`drop role if exists ${role}`).catch(() => undefined);
        await admin.end({ timeout: 5 });
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "isolation fails when a policy is using (true)",
  async () => {
    await withPostgresSchema(async (admin, schemaName) => {
      await install(admin, schemaName);
      const role = `p_${schemaName}`;
      await grantPlain(admin, schemaName, role);
      const url = roleUrl(primaryUrl(), role);
      await admin.unsafe(
        `alter policy notes_tenant on ${schemaName}.notes using (true) with check (true)`,
      );
      const harness = await testing(built, {
        driver: (await import("../src/runtime/pg/postgresjs.js")).open({
          url,
          max: 1,
          searchPath: schemaName,
        }),
        migrate: false,
      });
      try {
        let caught: unknown;
        try {
          await harness.isolation();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(OkmError);
        if (caught instanceof OkmError) expect(caught.message).toContain("tenant predicate");
      } finally {
        await harness.close();
        await dropRole(admin, schemaName, role);
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a rolled-back savepoint and a scope switch keep the tenant on every adapter",
  async () => {
    for (const adapter of adapters) {
      await withPostgresSchema(async (admin, schemaName) => {
        await install(admin, schemaName);
        const role = `s_${schemaName}`;
        await grantPlain(admin, schemaName, role);
        await seed(admin, schemaName);
        const db = await adapter.open(roleUrl(primaryUrl(), role), schemaName);
        try {
          await savepointCase(db);
          await nestedCase(db);
          await switchCase(db);
        } finally {
          await db.close();
          await dropRole(admin, schemaName, role);
        }
      });
    }
  },
  120_000,
);

postgresTest(
  gate,
  "every endpoint is checked before its first scoped use",
  async () => {
    await withPostgresSchema(async (admin, schemaName) => {
      await install(admin, schemaName);
      await seed(admin, schemaName);
      const roles = await makeRoles(admin, schemaName);
      await waitForReplica(schemaName);
      try {
        for (const adapter of adapters) {
          for (const primaryKind of ["superuser", "owner", "bypass", "plain"] as const) {
            for (const replicaKind of ["superuser", "owner", "bypass", "plain"] as const) {
              const db = await adapter.open(
                {
                  primary: roleUrl(primaryUrl(), roles[primaryKind]),
                  replicas: [{ name: "a", url: roleUrl(replicaUrl("a"), roles[replicaKind]) }],
                },
                schemaName,
              );
              try {
                const scoped = db.for({ tenantId: TENANT_A });
                if (replicaKind === "plain") {
                  const rows = await scoped.notes.find({ limit: 20, route: "replica" });
                  expect(rows.some((row) => row.id === NOTE_A)).toBe(true);
                  expect(rows.some((row) => row.id === NOTE_B)).toBe(false);
                  expect(rows.every((row) => row.tenantId === TENANT_A)).toBe(true);
                } else {
                  await expectRole(
                    scoped.notes.find({ limit: 1, route: "replica" }),
                    replicaKind,
                    "a",
                  );
                }
                if (primaryKind === "plain") {
                  const inserted = await scoped.notes.insert({
                    id: crypto.randomUUID(),
                    title: `${adapter.name}-${primaryKind}-${replicaKind}`,
                  });
                  expect(inserted.tenantId).toBe(TENANT_A);
                } else {
                  await expectRole(
                    scoped.notes.insert({
                      id: crypto.randomUUID(),
                      title: `${adapter.name}-refused`,
                    }),
                    primaryKind,
                    "primary",
                  );
                }
              } finally {
                await db.close();
              }
            }
          }
        }
      } finally {
        for (const role of Object.values(roles)) await dropRole(admin, schemaName, role);
      }
    });
  },
  180_000,
);

async function savepointCase(db: Root): Promise<void> {
  await db.for({ tenantId: TENANT_A }).tx(async (tx) => {
    try {
      await tx.tx(async (inner) => {
        await inner.notes.insert({ id: "not-a-uuid", title: "bad" });
      });
      throw new Error("the savepoint should have failed");
    } catch (error) {
      expect(
        error instanceof Error && error.message.includes("the savepoint should have failed"),
      ).toBe(false);
    }
    const rows = await tx.notes.find({ limit: 5 });
    expect(rows.map((row) => row.id)).toContain(NOTE_A);
    expect(rows.every((row) => row.tenantId === TENANT_A)).toBe(true);
  });
}

async function nestedCase(db: Root): Promise<void> {
  await db.for({ tenantId: TENANT_A }).tx(async (tx) => {
    try {
      await tx.tx(async (mid) => {
        try {
          await mid.tx(async (deep) => {
            await deep.notes.find({ limit: 1 });
            throw new Error("deep");
          });
        } catch (error) {
          expect(messageOf(error)).toContain("deep");
        }
        const midRows = await mid.notes.find({ limit: 5 });
        expect(midRows.some((row) => row.id === NOTE_A)).toBe(true);
        throw new Error("mid");
      });
    } catch (error) {
      expect(messageOf(error)).toContain("mid");
    }
    const rows = await tx.notes.find({ limit: 5 });
    expect(rows.some((row) => row.id === NOTE_A)).toBe(true);
  });
}

async function switchCase(db: Root): Promise<void> {
  await db.tx(async (tx) => {
    const a = await tx.for({ tenantId: TENANT_A }).notes.find({ limit: 5 });
    const b = await tx.for({ tenantId: TENANT_B }).notes.find({ limit: 5 });
    const again = await tx.for({ tenantId: TENANT_A }).notes.find({ limit: 5 });
    expect(a.map((row) => row.id)).toEqual([NOTE_A]);
    expect(b.map((row) => row.id)).toEqual([NOTE_B]);
    expect(again.map((row) => row.id)).toEqual([NOTE_A]);
  });
}

async function expectRole(
  pending: Promise<unknown>,
  kind: Exclude<Kind, "plain">,
  endpoint: string,
): Promise<void> {
  let caught: unknown;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RlsRoleError);
  if (caught instanceof RlsRoleError) {
    expect(caught.code).toBe("OKM1707");
    expect(caught.reason).toBe(kind === "bypass" ? "bypassrls" : kind);
    expect(caught.message).toContain(`Endpoint ${endpoint}`);
  }
}

async function install(admin: ReturnType<typeof postgres>, schemaName: string): Promise<void> {
  for (const statement of renderCatalog(built.catalog, schemaName)) {
    await admin.unsafe(statement);
  }
}

async function grantPlain(
  admin: ReturnType<typeof postgres>,
  schemaName: string,
  role: string,
): Promise<void> {
  await admin.unsafe(`create role ${role} login password '${PASSWORD}' nosuperuser nobypassrls`);
  await admin.unsafe(`grant connect on database okm to ${role}`);
  await admin.unsafe(`grant usage on schema ${schemaName} to ${role}`);
  await admin.unsafe(
    `grant select, insert, update, delete on all tables in schema ${schemaName} to ${role}`,
  );
  await admin.unsafe(`alter role ${role} set search_path to ${schemaName}`);
}

async function seed(admin: ReturnType<typeof postgres>, schemaName: string): Promise<void> {
  await admin.unsafe(
    `insert into ${schemaName}.notes (id, title, tenant_id) values ('${NOTE_A}', 'alpha', '${TENANT_A}'), ('${NOTE_B}', 'beta', '${TENANT_B}')`,
  );
}

async function makeRoles(
  admin: ReturnType<typeof postgres>,
  schemaName: string,
): Promise<Record<Kind, string>> {
  const roles: Record<Kind, string> = {
    superuser: `su_${schemaName}`,
    owner: `ow_${schemaName}`,
    bypass: `by_${schemaName}`,
    plain: `pl_${schemaName}`,
  };
  await admin.unsafe(`create role ${roles.superuser} login password '${PASSWORD}' superuser`);
  await admin.unsafe(
    `create role ${roles.owner} login password '${PASSWORD}' nosuperuser nobypassrls`,
  );
  await admin.unsafe(
    `create role ${roles.bypass} login password '${PASSWORD}' nosuperuser bypassrls`,
  );
  await admin.unsafe(
    `create role ${roles.plain} login password '${PASSWORD}' nosuperuser nobypassrls`,
  );
  for (const role of Object.values(roles)) {
    await admin.unsafe(`grant connect on database okm to ${role}`);
    await admin.unsafe(`grant usage on schema ${schemaName} to ${role}`);
    await admin.unsafe(
      `grant select, insert, update, delete on all tables in schema ${schemaName} to ${role}`,
    );
    await admin.unsafe(`alter role ${role} set search_path to ${schemaName}`);
  }
  await admin.unsafe(`alter table ${schemaName}.notes owner to ${roles.owner}`);
  return roles;
}

async function waitForReplica(schemaName: string): Promise<void> {
  const replica = postgres(replicaUrl("a"), { max: 1, connect_timeout: 5, onnotice() {} });
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const rows = await replica
        .unsafe(`select id from ${schemaName}.notes where id = '${NOTE_A}'`)
        .catch(() => []);
      if (rows.length > 0) return;
      await Bun.sleep(100);
    }
  } finally {
    await replica.end({ timeout: 5 });
  }
  throw new Error(`replica did not see ${schemaName}.notes`);
}

async function dropRole(
  admin: ReturnType<typeof postgres>,
  schemaName: string,
  role: string,
): Promise<void> {
  await admin
    .unsafe(`alter table if exists ${schemaName}.notes owner to current_user`)
    .catch(() => undefined);
  await admin
    .unsafe(`revoke all privileges on all tables in schema ${schemaName} from ${role}`)
    .catch(() => undefined);
  await admin
    .unsafe(`revoke all privileges on schema ${schemaName} from ${role}`)
    .catch(() => undefined);
  await admin.unsafe(`revoke connect on database okm from ${role}`).catch(() => undefined);
  await admin.unsafe(`drop role if exists ${role}`);
}

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = PASSWORD;
  return url.toString();
}

function databaseName(url: string): string {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (name.length === 0) throw new Error("database url has no name");
  return name;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

async function withProject(body: (cwd: string, url: string) => Promise<void>): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-rls-guard-"));
  try {
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        "export default defineConfig({",
        '  schema: "./schema.ts",',
        '  migrations: "./migrations",',
        `  database: ${JSON.stringify(database.url)},`,
        "});",
        "",
      ].join("\n"),
    );
    await body(cwd, database.url);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

function writeSchema(cwd: string): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      `import { rlsTenancy } from ${source("src/runtime/tenancy/index.ts")};`,
      'const notes = table("notes", { id: t.id({ default: "none" }), title: t.text() });',
      'export const app = schema({ casing: "snake", tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }), tables: [notes] });',
      "",
    ].join("\n"),
  );
}
