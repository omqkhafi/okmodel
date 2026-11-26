/**
 * Roles apply, SCRAM passwords, grant verification, and the pooler refusal
 * on Postgres. Passwords are generated in the process and must not appear
 * in command text, status JSON, or the server log.
 */

import { randomBytes } from "node:crypto";

import { expect } from "bun:test";
import pg from "pg";
import postgres from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import { quoteIdent } from "../src/dialects/pg/ddl.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { probeConcurrent } from "../src/tooling/migrate/pooler-probe.js";
import type { MigrateConfig } from "../src/tooling/migrate/config.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { applyRoles, roleStatus, setRolePassword } from "../src/tooling/migrate/roles-cmd.js";
import { scramFromStored } from "../src/tooling/migrate/scram.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "a client SCRAM verifier logs in and roles apply leaves the password",
  async () => {
    const password = randomBytes(24).toString("base64url");
    const next = randomBytes(24).toString("base64url");
    const migration = roleName("mig");
    const name = roleName("login");
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    const adminEnv = "OKM_ROLES_ADMIN_TEST";
    const roleEnv = "OKM_ROLES_LOGIN_TEST";
    try {
      process.env[adminEnv] = database.url;
      process.env[roleEnv] = urlAs(database.url, name, password);
      const config = rolesConfig(migration, name, roleEnv);
      const created = await applyRoles(config, adminEnv, {}, false);
      expect(created).toContain(`created ${name}`);
      expect(created).not.toContain(password);
      const stored = await readPassword(admin, name);
      expect(stored.startsWith("SCRAM-SHA-256$")).toBe(true);
      expect(scramFromStored(password, stored)).toBe(stored);
      await loginPostgresJs(process.env[roleEnv] ?? "");
      await loginNodePostgres(process.env[roleEnv] ?? "");
      const again = await applyRoles(config, adminEnv, {}, false);
      expect(again).toContain(`exists ${name}`);
      expect(again).not.toContain(password);
      expect(await readPassword(admin, name)).toBe(stored);
      const held = postgres(process.env[roleEnv] ?? "", { max: 1 });
      try {
        await held`select 1 as n`;
        process.env[roleEnv] = urlAs(database.url, name, next);
        const text = await setRolePassword(config, name, adminEnv, {}, false);
        expect(text).not.toContain(password);
        expect(text).not.toContain(next);
        await held`select 1 as n`;
      } finally {
        await held.end({ timeout: 5 });
      }
      const replaced = await readPassword(admin, name);
      expect(scramFromStored(next, replaced)).toBe(replaced);
      expect(replaced).not.toContain(next);
      await expectAbsent(admin, database.url, password, next);
      const status = await roleStatus(config, database.url);
      expect(JSON.stringify(status)).not.toContain(password);
      expect(JSON.stringify(status)).not.toContain(next);
      expect(status.rows.find((row) => row.name === name)?.scope).toBe("managed");
      expect(status.rows.some((row) => row.scope === "unmanaged")).toBe(true);
    } finally {
      delete process.env[adminEnv];
      delete process.env[roleEnv];
      await admin.end({ timeout: 5 });
      await database.close();
      await dropRole(name);
      await dropRole(migration);
    }
  },
  60_000,
);

postgresTest(
  gate,
  "format quoting keeps a password that contains a quote",
  async () => {
    const password = `a'b\\c${randomBytes(12).toString("base64url")}`;
    const migration = roleName("mig");
    const name = roleName("quote");
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    const adminEnv = "OKM_ROLES_ADMIN_QUOTE";
    const roleEnv = "OKM_ROLES_QUOTE";
    try {
      process.env[adminEnv] = database.url;
      process.env[roleEnv] = urlAs(database.url, name, password);
      await applyRoles(rolesConfig(migration, name, roleEnv), adminEnv, {}, false);
      await loginPostgresJs(process.env[roleEnv] ?? "");
      const stored = await readPassword(admin, name);
      expect(scramFromStored(password, stored)).toBe(stored);
    } finally {
      delete process.env[adminEnv];
      delete process.env[roleEnv];
      await admin.end({ timeout: 5 });
      await database.close();
      await dropRole(name);
      await dropRole(migration);
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a CREATEROLE login cannot alter a role it did not create",
  async () => {
    const maker = roleName("maker");
    const victim = roleName("victim");
    const migration = roleName("mig");
    const makerPassword = randomBytes(18).toString("base64url");
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    const adminEnv = "OKM_ROLES_ADMIN_LIMITED";
    try {
      const databaseName = new URL(database.url).pathname.slice(1);
      await admin.unsafe(
        `create role ${quoteIdent(maker)} login password ${quoteLiteral(makerPassword)} nosuperuser nocreatedb createrole`,
      );
      await admin.unsafe(
        `grant connect on database ${quoteIdent(databaseName)} to ${quoteIdent(maker)}`,
      );
      await admin.unsafe(`create role ${quoteIdent(victim)} nologin`);
      process.env[adminEnv] = urlAs(database.url, maker, makerPassword);
      let caught: unknown;
      try {
        await applyRoles(
          {
            schema: "./schema.ts",
            roles: {
              migration: { name: migration },
              app: { name: victim, connectionLimit: 4 },
            },
          },
          adminEnv,
          {},
          false,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OkmError);
      expect((caught as OkmError).code).toBe("OKM1914");
      expect((caught as OkmError).message).toContain("did not create");
      const limit = await admin<{ rolconnlimit: number }[]>`
        select rolconnlimit from pg_roles where rolname = ${victim}
      `;
      expect(limit[0]?.rolconnlimit).toBe(-1);
    } finally {
      delete process.env[adminEnv];
      await admin.end({ timeout: 5 });
      await database.close();
      await dropRole(victim);
      await dropRole(maker);
      await dropRole(migration);
    }
  },
  60_000,
);

postgresTest(
  gate,
  "membership options follow the server major",
  async () => {
    const parent = roleName("parent");
    const child = roleName("child");
    const migration = roleName("mig");
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    const adminEnv = "OKM_ROLES_ADMIN_MEMBER";
    try {
      await admin.unsafe(`create role ${quoteIdent(parent)} nologin`);
      process.env[adminEnv] = database.url;
      const version = await admin<{ v: string }[]>`
        select current_setting('server_version_num') as v
      `;
      const major = Number(version[0]?.v ?? 0);
      const config: MigrateConfig = {
        schema: "./schema.ts",
        roles: {
          migration: { name: migration },
          parent: { name: parent },
          app: {
            name: child,
            memberOf: [{ role: parent, inherit: false, set: true, admin: false }],
          },
        },
      };
      if (major < 160000) {
        let caught: unknown;
        try {
          await applyRoles(config, adminEnv, {}, false);
        } catch (error) {
          caught = error;
        }
        expect((caught as OkmError).code).toBe("OKM1914");
        const rows = await admin<{ n: number }[]>`
          select count(*)::int as n from pg_roles where rolname = ${child}
        `;
        expect(rows[0]?.n).toBe(0);
        return;
      }
      await applyRoles(config, adminEnv, {}, false);
      const member = await admin<{ inherit: boolean }[]>`
        select m.inherit_option as inherit
        from pg_auth_members m
        join pg_roles r on r.oid = m.roleid
        join pg_roles u on u.oid = m.member
        where r.rolname = ${parent} and u.rolname = ${child}
      `;
      expect(member[0]?.inherit).toBe(false);
    } finally {
      delete process.env[adminEnv];
      await admin.end({ timeout: 5 });
      await database.close();
      await dropRole(child);
      await dropRole(parent);
      await dropRole(migration);
    }
  },
  60_000,
);

postgresTest(
  gate,
  "revoke of another grantor's privilege is an error and public stays",
  async () => {
    const mig = roleName("mig");
    const app = roleName("app");
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe(`create role ${quoteIdent(mig)} nologin`);
      await sql.unsafe(`create role ${quoteIdent(app)} nologin`);
      await sql.unsafe(`grant create, usage on schema public to ${quoteIdent(mig)}`);
      await sql.unsafe(`create table tasks (id text primary key)`);
      await sql.unsafe(`grant select on tasks to ${quoteIdent(app)}`);
      await sql.unsafe(`grant select on tasks to ${quoteIdent(mig)} with grant option`);
      await sql.unsafe(`grant select on tasks to public`);
      const owner = decodeURIComponent(new URL(database.url).username);
      let caught: unknown;
      try {
        await applyTarget({
          url: database.url,
          target: "default",
          protected: false,
          migrationRole: mig,
          migrations: [
            {
              id: "0001_revoke",
              catalogHash: "revoke",
              steps: [
                {
                  sql: `revoke select on table "public"."tasks" from ${quoteIdent(app)}`,
                  class: "expand",
                  action: "ddl",
                  lock: "share",
                  transactional: true,
                },
              ],
            },
          ],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OkmError);
      expect((caught as OkmError).code).toBe("OKM1913");
      expect((caught as OkmError).message).toContain(owner);
      expect((caught as OkmError).message).toContain("GRANTED BY");
      const still = await sql<{ app: boolean; pub: boolean }[]>`
        select has_table_privilege(${app}, 'tasks', 'select') as app,
               has_table_privilege('public', 'tasks', 'select') as pub
      `;
      expect(still[0]?.app).toBe(true);
      expect(still[0]?.pub).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      await dropRole(app);
      await dropRole(mig);
    }
  },
  60_000,
);

postgresTest(
  gate,
  "grants round-trip through aclexplode with no further steps",
  async () => {
    const mig = roleName("mig");
    const app = roleName("app");
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe(`create role ${quoteIdent(mig)} nologin`);
      await sql.unsafe(`grant create, usage on schema public to ${quoteIdent(mig)}`);
      await sql.unsafe(`create role ${quoteIdent(app)} nologin`);
      const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
      const declared = attachRoles(schema({ tables: [tasks] }).catalog, {
        migration: { name: mig },
        app: { name: app },
      });
      await applyTarget({
        url: database.url,
        target: "default",
        protected: false,
        migrationRole: mig,
        migrations: [
          {
            id: "0001_grants",
            catalogHash: "grants",
            steps: planMigration({ before: catalog([]), after: declared, name: "grants" }).steps,
          },
        ],
      });
      const live = await introspectSchema(queryOf(sql), "public", "public", {
        managedRoles: [mig, app],
      });
      const again = planMigration({ before: live, after: declared, name: "again" }).steps.filter(
        (step) => /grant|revoke/i.test(step.sql),
      );
      expect(again).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      await dropRole(app);
      await dropRole(mig);
    }
  },
  60_000,
);

postgresTest(
  gate,
  "eight overlapping clients on a direct server keep one pid each",
  async () => {
    const database = await createIsolatedDatabase();
    try {
      const found = await probeConcurrent(database.url);
      expect(found.provenDirect).toBe(true);
      expect(found.pooled).toBe(false);
    } finally {
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a session step is refused when the URL matches a pooler signal",
  async () => {
    const database = await createIsolatedDatabase();
    const user = decodeURIComponent(new URL(database.url).username);
    const hinted = `${database.url}${database.url.includes("?") ? "&" : "?"}pgbouncer=true`;
    try {
      let caught: unknown;
      try {
        await applyTarget({
          url: hinted,
          target: "default",
          protected: false,
          allowPooler: true,
          migrationRole: user,
          migrations: [
            {
              id: "0001_concurrent",
              catalogHash: "concurrent",
              steps: [
                {
                  sql: "create index concurrently tasks_id on tasks (id)",
                  class: "expand",
                  action: "ddl",
                  lock: "share",
                  transactional: true,
                },
              ],
            },
          ],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OkmError);
      expect((caught as OkmError).code).toBe("OKM1854");
      expect((caught as OkmError).message).toContain("pgbouncer=true");
      expect((caught as OkmError).message).toContain("direct URL");
    } finally {
      await database.close();
    }
  },
  60_000,
);

function rolesConfig(migration: string, name: string, env: string): MigrateConfig {
  return {
    schema: "./schema.ts",
    roles: {
      migration: { name: migration },
      app: { name, env },
    },
  };
}

function roleName(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function urlAs(base: string, user: string, password: string): string {
  const url = new URL(base);
  return `${url.protocol}//${encodeUserinfo(user)}:${encodeUserinfo(password)}@${url.host}${url.pathname}`;
}

function encodeUserinfo(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value)) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9._~-]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readPassword(sql: ReturnType<typeof openPostgres>, name: string): Promise<string> {
  const rows = await sql<{ rolpassword: string }[]>`
    select rolpassword from pg_authid where rolname = ${name}
  `;
  return rows[0]?.rolpassword ?? "";
}

async function loginPostgresJs(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    await sql`select 1 as n`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function loginNodePostgres(url: string): Promise<void> {
  const Client = (
    pg as unknown as {
      Client: new (config: { connectionString: string }) => {
        connect(): Promise<void>;
        query(sql: string): Promise<unknown>;
        end(): Promise<void>;
      };
    }
  ).Client;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("select 1");
  } finally {
    await client.end();
  }
}

async function expectAbsent(
  sql: ReturnType<typeof openPostgres>,
  url: string,
  ...secrets: readonly string[]
): Promise<void> {
  const database = new URL(url).pathname.slice(1);
  await sql.unsafe(`alter database ${quoteIdent(database)} set log_statement = 'ddl'`);
  try {
    await sql`select 1`;
  } catch {
    // The setting applies to the next connection.
  }
  let statements = "";
  try {
    await sql.unsafe("create extension if not exists pg_stat_statements");
    const rows = await sql<{ query: string }[]>`select query from pg_stat_statements`;
    statements = rows.map((row) => row.query).join("\n");
  } catch {
    statements = "";
  }
  const logs = await dockerLogs();
  const haystack = `${statements}\n${logs}`;
  for (const secret of secrets) expect(haystack.includes(secret)).toBe(false);
  await sql.unsafe(`alter database ${quoteIdent(database)} reset log_statement`);
}

async function dockerLogs(): Promise<string> {
  const proc = Bun.spawn(["docker", "logs", "okmodel-primary-1", "--since", "5m"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([stdout, stderr]) => `${stdout}\n${stderr}`);
  await proc.exited;
  return text;
}

async function dropRole(name: string): Promise<void> {
  const sql = openPostgres();
  try {
    await sql.unsafe(`drop role if exists ${quoteIdent(name)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function queryOf(sql: ReturnType<typeof openPostgres>): CatalogQuery {
  return {
    async query(text: string, params?: readonly unknown[]) {
      const rows = await sql.unsafe(text, params as never[]);
      return rows as readonly Record<string, unknown>[];
    },
  };
}
