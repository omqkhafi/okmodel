/**
 * Generate, apply, and check on Postgres 18 for the 0.6 QA findings.
 *
 * Each case is the command sequence `okm generate init`, `okm migrate apply`,
 * `okm migrate check`, and `okm check`, except the grant that must fail and
 * the superuser preflight.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tenantPolicyExpression } from "../src/contracts/catalog/policy.js";
import { OkmError } from "../src/contracts/error.js";
import { quoteIdent } from "../src/dialects/pg/ddl.js";
import { assertCreateRole, assertRoleHealth } from "../src/dialects/pg/role/check.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
const tenancy = JSON.stringify(join(root, "src/runtime/tenancy/index.ts"));
const view = JSON.stringify(join(root, "src/dialects/pg/view/index.ts"));
const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));

postgresTest(
  gate,
  "rls apply matches pg_get_expr for default, snake, and mixed case",
  async () => {
    await rlsCase(undefined, "tenantId", tenantPolicyExpression("tenantId", "uuid"));
    await rlsCase("snake", "tenantId", tenantPolicyExpression("tenant_id", "uuid"));
    await rlsCase(undefined, "TenantId", tenantPolicyExpression("TenantId", "uuid"));
  },
  120_000,
);

postgresTest(gate, "a reserved-word policy expression matches pg_get_expr", async () => {
  const expression = tenantPolicyExpression("user", "uuid");
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await sql.unsafe(`create table accounts ("user" uuid)`);
    await sql.unsafe(`alter table accounts enable row level security`);
    await sql.unsafe(`create policy accounts_tenant on accounts using ${expression}`);
    const rows = await sql<{ expr: string }[]>`
      select pg_get_expr(p.polqual, p.polrelid) as expr
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      where c.relname = 'accounts' and p.polname = 'accounts_tenant'
    `;
    expect(rows[0]?.expr).toBe(expression);
    expect(tenantPolicyExpression("order", "uuid").startsWith(`("order"`)).toBe(true);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(
  gate,
  "a three-hop path applies when the child name sorts first",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project(database.url, pathSchema());
    try {
      await cycle(cwd);
      const sql = openPostgres(database.url);
      try {
        const rows = await sql<{ relname: string }[]>`
        select c.relname
        from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        where k.contype = 'f'
      `;
        const names = rows.map((row) => row.relname).sort();
        expect(names).toEqual(["departments", "notes", "teams"]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a materialized view index applies and checks",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project(database.url, matviewSchema());
    try {
      await cycle(cwd);
      const sql = openPostgres(database.url);
      try {
        const rows = await sql<{ index: string; unique: boolean }[]>`
        select c.relname as index, i.indisunique as unique
        from pg_index i
        join pg_class c on c.oid = i.indexrelid
        join pg_class t on t.oid = i.indrelid
        where t.relname = 'sums'
        order by c.relname
      `;
        expect(rows.length).toBe(4);
        expect(rows.some((row) => row.unique === true)).toBe(true);
        expect(rows.some((row) => row.unique === false)).toBe(true);
      } finally {
        await sql.end({ timeout: 5 });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "roles apply when the migration role owns public, and matview writes are revoked",
  async () => {
    const mig = roleName("mig");
    const app = roleName("app");
    const report = roleName("report");
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const cwd = project(database.url, rolesSchema(), rolesConfig(mig, app, report));
    try {
      await sql.unsafe(`create role ${quoteIdent(mig)} nosuperuser nocreatedb createrole`);
      await sql.unsafe(`alter schema public owner to ${quoteIdent(mig)}`);
      await cycle(cwd);
      const rows = await sql<{ acl: string }[]>`
      select relacl::text as acl from pg_class where relname = 'sums'
    `;
      const acl = rows[0]?.acl ?? "";
      expect(acl).toContain(`${app}=r/`);
      expect(acl).not.toContain(`${app}=arwd`);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
      await dropRoles([mig, app, report]);
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a schema grant that does not land fails with an owner hint",
  async () => {
    const mig = roleName("mig");
    const app = roleName("app");
    const report = roleName("report");
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const cwd = project(
      database.url,
      `import { schema, table, text } from ${pg};
export const app = schema({ tables: [table("people", { email: text() })] });
`,
      rolesConfig(mig, app, report),
    );
    try {
      await sql.unsafe(
        `create role ${quoteIdent(mig)} login password 'secret' nosuperuser nocreatedb createrole`,
      );
      await sql.unsafe(`grant usage, create on schema public to ${quoteIdent(mig)}`);
      await sql.unsafe(
        `create role ${quoteIdent(app)} login password 'secret' nosuperuser nocreatedb nocreaterole`,
      );
      await sql.unsafe(
        `create role ${quoteIdent(report)} login password 'secret' nosuperuser nocreatedb nocreaterole`,
      );
      let caught: unknown;
      try {
        await run(["generate", "init"], { cwd, stdout: () => {} });
        await run(["migrate", "apply"], { cwd, stdout: () => {} });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OkmError);
      const error = caught as OkmError;
      expect(error.code).toBe("OKM1825");
      expect(error.fix.summary).toContain("OWNER TO");
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
      await dropRoles([mig, app, report]);
    }
  },
  90_000,
);

postgresTest(
  gate,
  "ignored and external tables are absent after generate and apply",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project(
      database.url,
      `import { schema, table, text, withOwner } from ${pg};
const people = withOwner(table("people", { email: text() }), "ignored");
const outside = withOwner(table("outside", { email: text() }), "external");
const managed = table("managed", { email: text() });
export const app = schema({ tables: [people, outside, managed] });
`,
    );
    try {
      const output = await cycle(cwd);
      expect(output).not.toContain('"people"');
      const sql = openPostgres(database.url);
      try {
        const rows = await sql<{ relname: string }[]>`
        select relname from pg_class
        where relkind = 'r' and relnamespace = 'public'::regnamespace
          and relname in ('people', 'outside', 'managed')
        order by relname
      `;
        expect(rows.map((row) => row.relname)).toEqual(["managed"]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(gate, "a superuser satisfies the CREATEROLE preflight", async () => {
  const superuser = roleName("super");
  const plain = roleName("plain");
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await sql.unsafe(
      `create role ${quoteIdent(superuser)} login password 'secret' superuser nocreaterole`,
    );
    await sql.unsafe(
      `create role ${quoteIdent(plain)} login password 'secret' nosuperuser nocreatedb nocreaterole`,
    );
    const flags = await sql<{ rolsuper: boolean; rolcreaterole: boolean }[]>`
      select rolsuper, rolcreaterole from pg_roles where rolname = ${superuser}
    `;
    expect(flags[0]?.rolsuper).toBe(true);
    expect(flags[0]?.rolcreaterole).toBe(false);
    const pool = open({ url: database.url, max: 1 });
    try {
      await assertCreateRole(pool, superuser);
      let caught: unknown;
      try {
        await assertCreateRole(pool, plain);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OkmError);
      expect((caught as OkmError).message).toContain("lacks CREATEROLE");
    } finally {
      await pool.close();
    }
    const url = new URL(database.url);
    url.username = superuser;
    url.password = "secret";
    const acting = open({ url: url.href, max: 1 });
    try {
      await assertRoleHealth(
        acting,
        { migration: superuser, app: superuser, managed: [{ name: superuser }] },
        [],
      );
    } finally {
      await acting.close();
    }
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
    await dropRoles([superuser, plain]);
  }
});

async function rlsCase(
  casing: "snake" | undefined,
  key: string,
  expression: string,
): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = project(database.url, rlsSchema(casing, key));
  try {
    await cycle(cwd);
    const sql = openPostgres(database.url);
    try {
      const rows = await sql<{ expr: string }[]>`
        select pg_get_expr(p.polqual, p.polrelid) as expr
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        where c.relname = 'notes' and p.polname = 'notes_tenant'
      `;
      expect(rows[0]?.expr).toBe(expression);
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

function rlsSchema(casing: "snake" | undefined, key: string): string {
  const casingLine = casing === undefined ? "" : `casing: "snake",`;
  return `import { id, schema, table, text } from ${pg};
import { rlsTenancy } from ${tenancy};
const notes = table("notes", { id: id({ default: "none" }), title: text() });
export const app = schema({
  ${casingLine}
  tenancy: rlsTenancy({ key: ${JSON.stringify(key)}, type: "uuid" }),
  tables: [notes],
});
`;
}

function pathSchema(): string {
  return `import { id, one, schema, table, text, uuid } from ${pg};
import { columnTenancy, via } from ${tenancy};
const organizations = table("organizations", { id: id({ default: "none" }), name: text() });
const departments = table("departments", {
  id: id({ default: "none" }),
  name: text(),
  organizationId: uuid().references("organizations"),
}, {
  tenancy: via("organization"),
  relations: { organization: one("organizations", "organizationId") },
});
const teams = table("teams", {
  id: id({ default: "none" }),
  name: text(),
  departmentId: uuid().references("departments"),
}, {
  tenancy: via("department.organization"),
  relations: { department: one("departments", "departmentId") },
});
const notes = table("notes", {
  id: id({ default: "none" }),
  body: text(),
  teamId: uuid().references("teams"),
}, {
  tenancy: via("team.department.organization"),
  relations: { team: one("teams", "teamId") },
});
export const app = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [organizations, departments, teams, notes],
});
`;
}

function matviewSchema(): string {
  return `import { schema, table, text } from ${pg};
import { materializedView } from ${view};
const tasks = table("tasks", { id: text().primaryKey(), title: text() });
const columns = [
  { name: "id", type: "text" },
  { name: "title", type: "text" },
];
export const app = schema({
  tables: [tasks],
  views: [
    materializedView("sums", {
      columns,
      query: "SELECT id, title FROM tasks",
      refresh: "concurrently",
      indexes: [
        { columns: ["id"], unique: true },
        { columns: ["title"], unique: false },
        { columns: ["id", "title"], unique: true },
        { columns: ["title", "id"], unique: false },
      ],
    }),
  ],
});
`;
}

function rolesSchema(): string {
  return `import { schema, table, text } from ${pg};
import { materializedView } from ${view};
const tasks = table("tasks", { id: text().primaryKey(), title: text() });
export const app = schema({
  tables: [tasks],
  views: [
    materializedView("sums", {
      columns: [
        { name: "id", type: "text" },
        { name: "title", type: "text" },
      ],
      query: "SELECT id, title FROM tasks",
      indexes: [{ columns: ["id"], unique: true }],
    }),
  ],
});
`;
}

function rolesConfig(mig: string, app: string, report: string): string {
  return `roles: {
    migration: ${JSON.stringify(mig)},
    app: ${JSON.stringify(app)},
    reporting: ${JSON.stringify(report)},
    managed: [
      { name: ${JSON.stringify(mig)} },
      { name: ${JSON.stringify(app)} },
      { name: ${JSON.stringify(report)} },
    ],
  },`;
}

function project(url: string, source: string, roles?: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-p88-"));
  writeFileSync(join(cwd, "schema.ts"), source);
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: ${JSON.stringify(url)},`,
      roles ?? "",
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}

async function cycle(cwd: string): Promise<string> {
  const lines: string[] = [];
  const stdout = (text: string): void => {
    lines.push(text);
  };
  await run(["generate", "init"], { cwd, stdout });
  await run(["migrate", "apply"], { cwd, stdout });
  await run(["migrate", "check"], { cwd, stdout });
  await run(["check"], { cwd, stdout });
  return lines.join("");
}

function roleName(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function dropRoles(names: readonly string[]): Promise<void> {
  const admin = openPostgres();
  try {
    for (const name of names) {
      await admin.unsafe(`drop role if exists ${quoteIdent(name)}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}
