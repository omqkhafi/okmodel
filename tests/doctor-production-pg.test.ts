/**
 * `okm doctor --production` against real Postgres: one login role per case,
 * the exit code, the finding ids, a read-only proof, and a scan that no output
 * names the URL, host, user, or password.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect } from "bun:test";

import { open } from "../src/adapters/pg/postgresjs.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  openPostgres,
  type IsolatedDatabase,
} from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import {
  productionReport,
  readOnly,
  type ProductionReport,
} from "../src/tooling/migrate/doctor-production.js";
import { listTargets } from "../src/tooling/migrate/policy.js";
import { openProject } from "../src/tooling/migrate/project.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 10);

type Envelope = {
  readonly ok: boolean;
  readonly exit: number;
  readonly errors: readonly { readonly code: string; readonly summary: string }[];
  readonly warnings: readonly { readonly code?: string; readonly place?: string }[];
  readonly data: { readonly production?: ProductionReport };
};

type Login = { readonly name: string; readonly password: string };

type Fixture = {
  readonly applied: IsolatedDatabase;
  readonly empty: IsolatedDatabase;
  readonly owned: IsolatedDatabase;
  readonly roles: ReadonlyMap<string, Login>;
};

const ROLES: Readonly<Record<string, string>> = {
  app: "login",
  timed: "login",
  superuser: "login superuser",
  bypass: "login bypassrls",
  owner: "login",
};

let fixture: Promise<Fixture> | undefined;
const cleanup: (() => Promise<void>)[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const step of cleanup.reverse()) await step();
});

function fixtures(): Promise<Fixture> {
  fixture ??= build();
  return fixture;
}

async function build(): Promise<Fixture> {
  const admin = openPostgres();
  const roles = new Map<string, Login>();
  cleanup.push(async () => {
    for (const login of roles.values()) {
      await admin.unsafe(`drop role if exists ${login.name}`);
    }
    await admin.end({ timeout: 5 });
  });
  for (const [kind, attributes] of Object.entries(ROLES)) {
    const login = { name: `zq_x4_${kind}_${tag}`, password: `zqpw_${kind}_${tag}` };
    roles.set(kind, login);
    await admin.unsafe(`create role ${login.name} ${attributes} password '${login.password}'`);
  }
  const timed = roles.get("timed");
  await admin.unsafe(
    `alter role ${timed?.name ?? ""} set lock_timeout = '7s'; alter role ${timed?.name ?? ""} set statement_timeout = '30s'`,
  );
  const applied = await createIsolatedDatabase();
  cleanup.push(() => applied.close());
  const empty = await createIsolatedDatabase();
  cleanup.push(() => empty.close());
  const owned = await createIsolatedDatabase();
  cleanup.push(() => owned.close());
  await applyTo(applied.url, plainSchema());
  await applyTo(owned.url, plainSchema());
  const ownerName = roles.get("owner")?.name ?? "";
  const ownerDb = openPostgres(owned.url);
  await ownerDb.unsafe(`alter table public.users owner to ${ownerName}`);
  await ownerDb.end({ timeout: 5 });
  return { applied, empty, owned, roles };
}

function login(fx: Fixture, kind: string, databaseUrl: string): { url: string; secrets: string[] } {
  const who = fx.roles.get(kind);
  if (who === undefined) throw new Error(`no role ${kind}`);
  const url = new URL(databaseUrl);
  url.username = who.name;
  url.password = who.password;
  return { url: url.href.replace(/\/$/, ""), secrets: [who.name, who.password] };
}

async function applyTo(url: string, schemaSource: string): Promise<void> {
  const dir = projectDir(schemaSource, `database: { url: ${JSON.stringify(url)} },`);
  expect(okm(["generate", "init"], dir).code).toBe(0);
  const applied = okm(["migrate", "apply"], dir);
  expect(applied.code).toBe(0);
}

function projectDir(schemaSource: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "okm-doctor-prod-"));
  dirs.push(dir);
  writeFileSync(join(dir, "schema.ts"), schemaSource);
  writeFileSync(
    join(dir, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  ${body}`,
      "});",
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "migrations"));
  return dir;
}

function targetsProject(
  targets: Readonly<Record<string, { url: string; protected?: boolean }>>,
  extra = "",
  schemaSource: string = plainSchema(),
): string {
  return projectDir(schemaSource, `targets: ${JSON.stringify(targets)},\n  ${extra}`);
}

function okm(args: readonly string[], cwd: string) {
  const proc = spawnSync("bun", [join(root, "src/tooling/cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
  });
  return { code: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr };
}

function production(
  dir: string,
  args: readonly string[],
  secrets: readonly string[],
): { code: number; envelope: Envelope; text: string; report: ProductionReport } {
  const json = okm(["doctor", "--production", "--json", ...args], dir);
  const human = okm(["doctor", "--production", ...args], dir);
  expect(human.code).toBe(json.code);
  const everything = `${json.stdout}\n${json.stderr}\n${human.stdout}\n${human.stderr}`;
  for (const secret of [...secrets, "127.0.0.1", "postgres://", "postgresql://"]) {
    expect(everything).not.toContain(secret);
  }
  const envelope = JSON.parse(json.stdout) as Envelope;
  expect(envelope.exit).toBe(json.code);
  const report = envelope.data.production;
  if (report === undefined) throw new Error(`no report: ${json.stdout}`);
  return { code: json.code, envelope, text: human.stdout, report };
}

function find(report: ProductionReport, id: string) {
  const found = report.findings.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no finding ${id}`);
  return found;
}

postgresTest(
  gate,
  "a protected target and an ordinary app role with timeouts set exits 0",
  async () => {
    const fx = await fixtures();
    const who = login(fx, "timed", fx.applied.url);
    const dir = targetsProject({ production: { url: who.url, protected: true } });
    const run = production(dir, [], who.secrets);
    expect(run.code).toBe(0);
    expect(run.envelope.ok).toBe(true);
    expect(run.report.target).toBe("production");
    expect(run.report.findings.map((item) => item.id)).toEqual([
      "target-protection",
      "pooler",
      "okm-meta",
      "role-privilege",
      "role-owns-tables",
      "lock-timeout",
      "statement-timeout",
      "server-version",
      "extensions",
    ]);
    expect(run.report.summary).toEqual({ fail: 0, warn: 0, ok: 9 });
    expect(find(run.report, "lock-timeout").summary).toContain("7000 ms");
    expect(find(run.report, "statement-timeout").summary).toContain("30000 ms");
    expect(run.text.startsWith("target `production`\n")).toBe(true);
    expect(run.text).toContain("0 fail, 0 warn, 9 ok");
    expect(run.envelope.errors).toEqual([]);
  },
  120_000,
);

postgresTest(
  gate,
  "an unprotected target fails with OKM2202 and exits 1, whatever its name",
  async () => {
    const fx = await fixtures();
    const who = login(fx, "app", fx.applied.url);
    const dir = targetsProject({ production: { url: who.url } });
    const run = production(dir, [], who.secrets);
    expect(run.code).toBe(1);
    expect(run.envelope.ok).toBe(false);
    expect(run.envelope.errors[0]?.code).toBe("OKM2204");
    expect(find(run.report, "target-protection")).toMatchObject({
      severity: "fail",
      code: "OKM2202",
    });
    expect(run.report.summary.fail).toBe(1);
    expect(run.envelope.warnings.some((item) => item.place === "target-protection")).toBe(true);
  },
  120_000,
);

postgresTest(
  gate,
  "a superuser login fails with OKM1707",
  async () => {
    const fx = await fixtures();
    const who = login(fx, "superuser", fx.applied.url);
    const dir = targetsProject({ production: { url: who.url, protected: true } });
    const run = production(dir, [], who.secrets);
    expect(run.code).toBe(1);
    expect(find(run.report, "role-privilege")).toMatchObject({ severity: "fail", code: "OKM1707" });
    expect(find(run.report, "role-privilege").summary).toContain("superuser");
  },
  120_000,
);

postgresTest(
  gate,
  "a BYPASSRLS login fails with OKM1707",
  async () => {
    const fx = await fixtures();
    const who = login(fx, "bypass", fx.applied.url);
    const dir = targetsProject({ production: { url: who.url, protected: true } });
    const run = production(dir, [], who.secrets);
    expect(run.code).toBe(1);
    expect(find(run.report, "role-privilege")).toMatchObject({ severity: "fail", code: "OKM1707" });
    expect(find(run.report, "role-privilege").summary).toContain("BYPASSRLS");
  },
  120_000,
);

postgresTest(
  gate,
  "a role that owns the tables warns and still exits 0",
  async () => {
    const fx = await fixtures();
    const who = login(fx, "owner", fx.owned.url);
    const dir = targetsProject({ production: { url: who.url, protected: true } });
    const run = production(dir, [], who.secrets);
    expect(run.code).toBe(0);
    const owner = find(run.report, "role-owns-tables");
    expect(owner.severity).toBe("warn");
    expect(owner.summary).toContain("fine for the migrator");
    expect(find(run.report, "role-privilege").severity).toBe("ok");
    expect(run.text).toContain("fix:");
    const plain = login(fx, "app", fx.applied.url);
    const other = production(
      targetsProject({ production: { url: plain.url, protected: true } }),
      [],
      plain.secrets,
    );
    expect(find(other.report, "role-owns-tables").severity).toBe("ok");
  },
  120_000,
);

postgresTest(
  gate,
  "timeouts at 0 warn with OKM2201, and set timeouts do not",
  async () => {
    const fx = await fixtures();
    const bare = login(fx, "app", fx.applied.url);
    const dir = targetsProject(
      { production: { url: bare.url, protected: true } },
      "timeouts: { lock: 0 },",
    );
    const zero = production(dir, [], bare.secrets);
    expect(zero.code).toBe(0);
    expect(find(zero.report, "lock-timeout")).toMatchObject({ severity: "warn", code: "OKM2201" });
    expect(find(zero.report, "lock-timeout").summary).toContain("lock_timeout to 0");
    expect(find(zero.report, "statement-timeout")).toMatchObject({
      severity: "warn",
      code: "OKM2201",
    });
    expect(zero.envelope.warnings.filter((item) => item.code === "OKM2201")).toHaveLength(2);

    const timed = login(fx, "timed", fx.applied.url);
    const set = production(
      targetsProject({ production: { url: timed.url, protected: true } }),
      [],
      timed.secrets,
    );
    expect(find(set.report, "lock-timeout").severity).toBe("ok");
    expect(find(set.report, "statement-timeout").severity).toBe("ok");
  },
  120_000,
);

postgresTest(
  gate,
  "a missing okm_meta fails with OKM1520 and says it cannot see connect()",
  async () => {
    const fx = await fixtures();
    const who = login(fx, "timed", fx.empty.url);
    const dir = targetsProject({ production: { url: who.url, protected: true } });
    const run = production(dir, [], who.secrets);
    expect(run.code).toBe(1);
    const meta = find(run.report, "okm-meta");
    expect(meta).toMatchObject({ severity: "fail", code: "OKM1520" });
    expect(meta.summary).toContain("cannot see connect() options");
    const present = production(
      targetsProject({
        production: { url: login(fx, "timed", fx.applied.url).url, protected: true },
      }),
      [],
      who.secrets,
    );
    expect(find(present.report, "okm-meta").severity).toBe("ok");
  },
  120_000,
);

postgresTest(
  gate,
  "a pooler-looking URL warns, and fails when --allow-pooler is passed",
  async () => {
    const fx = await fixtures();
    const who = login(fx, "timed", fx.applied.url);
    const pooled = `${who.url}?pgbouncer=true`;
    const dir = targetsProject({ production: { url: pooled, protected: true } });
    const warned = production(dir, [], who.secrets);
    expect(warned.code).toBe(0);
    expect(find(warned.report, "pooler")).toMatchObject({ severity: "warn", code: "OKM2203" });
    const allowed = production(dir, ["--allow-pooler"], who.secrets);
    expect(allowed.code).toBe(1);
    expect(find(allowed.report, "pooler")).toMatchObject({ severity: "fail", code: "OKM2203" });
    const configured = production(
      targetsProject({ production: { url: pooled, protected: true } }, "allowPooler: true,"),
      [],
      who.secrets,
    );
    expect(find(configured.report, "pooler").severity).toBe("fail");
  },
  120_000,
);

postgresTest(
  gate,
  "several targets and no --target is a usage error, not a skip",
  async () => {
    const fx = await fixtures();
    const a = login(fx, "timed", fx.applied.url);
    const b = login(fx, "timed", fx.empty.url);
    const dir = targetsProject({
      production: { url: a.url, protected: true },
      staging: { url: b.url },
    });
    const secrets = [...a.secrets, "127.0.0.1"];
    const refused = okm(["doctor", "--production", "--json"], dir);
    expect(refused.code).toBe(2);
    const envelope = JSON.parse(refused.stdout) as Envelope;
    expect(envelope.errors[0]?.code).toBe("OKM1853");
    for (const secret of secrets) expect(refused.stdout + refused.stderr).not.toContain(secret);
    const picked = production(dir, ["--target", "production"], secrets);
    expect(picked.code).toBe(0);
    expect(picked.report.target).toBe("production");
    const staging = production(dir, ["--target", "staging"], secrets);
    expect(staging.code).toBe(1);
    expect(staging.report.target).toBe("staging");
  },
  120_000,
);

postgresTest(
  gate,
  "an unreachable target exits 5 and prints no host, user, or password",
  async () => {
    const dir = targetsProject({
      production: {
        url: `postgres://zq_unreach_${tag}:zqpw_unreach_${tag}@127.0.0.1:1/zq_db_${tag}`,
        protected: true,
      },
    });
    const json = okm(["doctor", "--production", "--json"], dir);
    const human = okm(["doctor", "--production"], dir);
    expect(json.code).toBe(5);
    expect(human.code).toBe(5);
    const everything = `${json.stdout}${json.stderr}${human.stdout}${human.stderr}`;
    for (const secret of [`zq_unreach_${tag}`, `zqpw_unreach_${tag}`, "127.0.0.1", "postgres://"]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).toContain("Could not read target `production`");
  },
  60_000,
);

postgresTest(
  gate,
  "a role named in the config that does not exist fails role-config",
  async () => {
    const fx = await fixtures();
    const who = login(fx, "timed", fx.applied.url);
    const missing = `zq_missing_${tag}`;
    const dir = targetsProject(
      { production: { url: who.url, protected: true } },
      `roles: { migration: ${JSON.stringify(who.secrets[0])}, app: ${JSON.stringify(missing)} },`,
    );
    const run = production(dir, [], who.secrets);
    expect(run.code).toBe(1);
    const roles = find(run.report, "role-config");
    expect(roles.severity).toBe("fail");
    expect(roles.summary).toContain(missing);
  },
  120_000,
);

postgresTest(
  gate,
  "required extensions are listed with their version, or fail with OKM1811",
  async () => {
    const fx = await fixtures();
    const db = await createIsolatedDatabase();
    cleanup.push(() => db.close());
    const sql = openPostgres(db.url);
    try {
      const available = await sql<{ ok: number }[]>`
        select 1 as ok from pg_available_extensions where name = 'pg_trgm'
      `;
      if (available.length > 0) {
        await sql.unsafe("create extension pg_trgm");
        const who = login(fx, "timed", db.url);
        const dir = targetsProject(
          { production: { url: who.url, protected: true } },
          "",
          trigramSchema(),
        );
        const run = production(dir, [], who.secrets);
        expect(find(run.report, "extensions").severity).toBe("ok");
        expect(find(run.report, "extensions").summary).toMatch(/pg_trgm \d+\.\d+/);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
    const owner = openPostgres(fx.empty.url);
    try {
      await owner.unsafe("drop extension if exists vector");
    } finally {
      await owner.end({ timeout: 5 });
    }
    const empty = login(fx, "timed", fx.empty.url);
    const dir = targetsProject(
      { production: { url: empty.url, protected: true } },
      "",
      vectorSchema(),
    );
    // An empty migrations directory is the initial migration, which does not
    // refuse an extension the server can create. This migration does not create vector.
    writeFileSync(join(dir, "migrations", "0001_present.sql"), "-- class: expand\n-- no steps\n");
    writeFileSync(
      join(dir, "migrations", "0001_present.catalog.json"),
      '{"version":1,"objects":[]}\n',
    );
    const failing = production(dir, [], empty.secrets);
    expect(failing.code).toBe(1);
    expect(find(failing.report, "extensions")).toMatchObject({ severity: "fail", code: "OKM1811" });
  },
  120_000,
);

postgresTest(
  gate,
  "the server version finding reports a major inside the window",
  async () => {
    const fx = await fixtures();
    const who = login(fx, "timed", fx.applied.url);
    const run = production(
      targetsProject({ production: { url: who.url, protected: true } }),
      [],
      who.secrets,
    );
    const server = find(run.report, "server-version");
    expect(server.severity).toBe("ok");
    expect(server.summary).toMatch(/PostgreSQL 1[5-8], inside the supported window 15-18/);
  },
  120_000,
);

postgresTest(
  gate,
  "every statement runs in one READ ONLY transaction and nothing is written",
  async () => {
    const fx = await fixtures();
    const who = login(fx, "timed", fx.applied.url);
    const dir = targetsProject({ production: { url: who.url, protected: true } });
    const opened = await openProject(dir);
    const target = listTargets(opened.config)[0];
    if (target === undefined) throw new Error("no target");

    const admin = openPostgres(fx.applied.url);
    const digest = async (): Promise<string> => {
      const rows = await admin<{ d: string }[]>`
        select md5(
          (select coalesce(string_agg(relname || ':' || relowner::text || ':' || relkind::text, ',' order by relname), '')
             from pg_class where relnamespace = 'public'::regnamespace)
          || (select coalesce(string_agg(id || catalog_hash || migration_id, ',' order by id), '') from public.okm_meta)
          || (select count(*)::text from pg_roles)
          || (select count(*)::text from pg_namespace)
        ) as d
      `;
      return rows[0]?.d ?? "";
    };
    const before = await digest();
    const statements: string[] = [];
    const report = await productionReport(
      opened,
      { target, config: opened.config, allowPooler: false },
      {
        wrap: (connection) => ({
          ...connection,
          execute: (text, params, options) => {
            statements.push(text.trim().toLowerCase());
            return connection.execute(text, params, options);
          },
          batch: () => {
            throw new Error("the doctor never batches");
          },
          release: () => connection.release(),
        }),
      },
    );
    try {
      expect(await digest()).toBe(before);
    } finally {
      await admin.end({ timeout: 5 });
    }
    expect(report.summary.fail).toBe(0);
    expect(statements[0]).toBe("begin read only");
    expect(statements[statements.length - 1]).toBe("commit");
    expect(statements.filter((text) => text === "begin read only")).toHaveLength(1);
    const reads = statements.slice(1, -1);
    expect(reads.length).toBeGreaterThan(3);
    for (const text of reads) expect(text).toMatch(/^select\b/);
    for (const text of statements) {
      expect(text).not.toMatch(
        /\b(insert|update|delete|create|alter|drop|grant|revoke|truncate)\b/,
      );
    }
  },
  120_000,
);

postgresTest(
  gate,
  "the read-only wrapper refuses a write with SQLSTATE 25006 and rolls back",
  async () => {
    const fx = await fixtures();
    const pool = open({ url: fx.applied.url, max: 1 });
    const connection = await pool.reserve?.();
    if (connection === undefined) throw new Error("no connection");
    try {
      let failure: unknown;
      try {
        await readOnly(connection, (runner) =>
          runner.execute(`create table zq_probe_${tag} (id int)`),
        );
      } catch (error) {
        failure = error;
      }
      expect(String((failure as { message?: string } | undefined)?.message ?? failure)).toMatch(
        /read-only/i,
      );
      const check = await connection.execute(`select to_regclass('zq_probe_${tag}')::text`);
      expect(check.rows[0]?.[0]).toBeNull();
    } finally {
      await connection.release();
      await pool.close();
    }
  },
  60_000,
);

function plainSchema(): string {
  return [
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    'const users = table("users", { id: t.id(), name: t.text() });',
    "export const app = schema({ tables: [users] });",
    "",
  ].join("\n");
}

function vectorSchema(): string {
  return [
    `import { extension } from ${JSON.stringify(join(root, "src/dialects/pg/ext/index.ts"))};`,
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    'const users = table("users", { id: t.id() });',
    'export const app = schema({ tables: [users], extensions: [extension("vector")] });',
    "",
  ].join("\n");
}

function trigramSchema(): string {
  return [
    `import { pgTrgm } from ${JSON.stringify(join(root, "src/dialects/pg/ext/pg-trgm.ts"))};`,
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    "const trgm = pgTrgm();",
    'const docs = table("docs", { id: t.id(), body: t.text() }, { indexes: (c) => [trgm.gin(c.body.name)] });',
    "export const app = schema({ tables: [docs], extensions: [trgm] });",
    "",
  ].join("\n");
}
