/**
 * Two catalogs on one Postgres database: export, external, and OKM1842.
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "identity and billing share one database and keep their own history",
  async () => {
    const database = await createIsolatedDatabase();
    const identity = project("identity");
    const billing = project("billing");
    try {
      writeIdentity(identity);
      writeConfig(identity, { url: database.url, namespace: "identity" });
      const plan = await cli(identity, ["migrate", "plan", "init"]);
      expect(plan).toContain('"identity"."users"');
      await cli(identity, ["generate", "init"]);
      await cli(identity, ["migrate", "apply"]);
      const exported = await cli(identity, ["catalog", "export", "--out", "identity.okm.json"]);
      const again = await cli(identity, ["catalog", "export", "--json"]);
      const file = readFileSync(join(identity, "identity.okm.json"), "utf8");
      expect(again).toBe(file);
      expect(exported).toBe("identity.okm.json\n");
      const snapshot = JSON.parse(file) as {
        catalogHash: string;
        logical: { namespace: string; name: string; format: number };
      };
      expect(snapshot.logical).toEqual({ namespace: "identity", name: "identity", format: 1 });

      writeBilling(billing, identity);
      writeConfig(billing, {
        url: database.url,
        namespace: "billing",
        external: [join(identity, "identity.okm.json")],
      });
      await cli(billing, ["generate", "init"]);
      const sql = readFileSync(migrationSql(billing), "utf8");
      expect(sql).toContain('references "identity"."users"');
      expect(sql).not.toContain('create table "identity"."users"');
      expect(sql).not.toContain('create table "billing"."users"');
      const before = await columns(database.url, "identity", "users");
      await cli(billing, ["migrate", "apply"]);
      expect(await columns(database.url, "identity", "users")).toEqual(before);
      expect(await cli(billing, ["migrate", "check"])).toBe("ok 1 migrations\n");
      const check = await cli(billing, ["check"]);
      expect(check).toContain("warning coupling");
      expect(check).toContain("identity.users");
      expect(await metaSchemas(database.url)).toEqual(["billing", "identity"]);

      await sqlOn(database.url, 'alter table "identity"."users" drop column "email"');
      const stale = await rejected(billing, ["check"]);
      expect(stale.code).toBe("OKM1841");
      expect(stale.message).toContain("stale");
    } finally {
      rmSync(identity, { recursive: true, force: true });
      rmSync(billing, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a stale snapshot, a missing file, and a missing table are OKM1841",
  async () => {
    const database = await createIsolatedDatabase();
    const identity = project("identity-gap");
    const billing = project("billing-gap");
    try {
      writeIdentity(identity);
      writeConfig(identity, { url: database.url, namespace: "identity" });
      await cli(identity, ["generate", "init"]);
      await cli(identity, ["migrate", "apply"]);
      await cli(identity, ["catalog", "export", "--out", "identity.okm.json"]);
      const snapshotPath = join(identity, "identity.okm.json");
      writeBilling(billing, identity);
      writeConfig(billing, {
        url: database.url,
        namespace: "billing",
        external: [snapshotPath],
      });
      await cli(billing, ["generate", "init"]);
      await cli(billing, ["migrate", "apply"]);

      const original = readFileSync(snapshotPath, "utf8");
      const edited = JSON.parse(original) as {
        tables: { columns: { type: string }[] }[];
      };
      const column = edited.tables[0]?.columns[1];
      if (column === undefined) throw new Error("snapshot has no email column");
      column.type = "integer";
      writeFileSync(snapshotPath, `${JSON.stringify(edited, null, 2)}\n`);
      const stale = await rejected(billing, ["check"]);
      expect(stale.code).toBe("OKM1841");
      expect(stale.message).toContain("stale");
      writeFileSync(snapshotPath, original);

      writeConfig(billing, {
        url: database.url,
        namespace: "billing",
        external: ["./missing.okm.json"],
      });
      const missing = await rejected(billing, ["migrate", "check"]);
      expect(missing.code).toBe("OKM1841");
      expect(missing.message).toContain("missing");

      writeConfig(billing, {
        url: database.url,
        namespace: "billing",
        external: [snapshotPath],
      });
      await sqlOn(database.url, 'drop table "identity"."users" cascade');
      const gone = await rejected(billing, ["check"]);
      expect(gone.code).toBe("OKM1841");
      expect(gone.message).toContain("missing");
    } finally {
      rmSync(identity, { recursive: true, force: true });
      rmSync(billing, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a foreign key into another database is OKM1842",
  async () => {
    const home = await createIsolatedDatabase();
    const other = await createIsolatedDatabase();
    const identity = project("identity-other");
    const billing = project("billing-other");
    try {
      writeIdentity(identity);
      writeConfig(identity, { url: home.url, namespace: "identity" });
      await cli(identity, ["generate", "init"]);
      await cli(identity, ["migrate", "apply"]);
      await cli(identity, ["catalog", "export", "--out", "identity.okm.json"]);
      writeBilling(billing, identity);
      writeConfig(billing, {
        url: other.url,
        namespace: "billing",
        external: [join(identity, "identity.okm.json")],
      });
      const error = await rejected(billing, ["check"]);
      expect(error.code).toBe("OKM1842");
      expect(error.kind).toBe("invalid");
    } finally {
      rmSync(identity, { recursive: true, force: true });
      rmSync(billing, { recursive: true, force: true });
      await home.close();
      await other.close();
    }
  },
  120_000,
);

function project(name: string): string {
  return mkdtempSync(join(tmpdir(), `okm-${name}-`));
}

function source(path: string): string {
  return JSON.stringify(join(root, path));
}

function writeIdentity(cwd: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      'export const users = table("users", {',
      "  id: t.uuid().primaryKey(),",
      "  email: t.text(),",
      "});",
      "export const app = schema({ tables: [users] });",
      "",
    ].join("\n"),
  );
}

function writeBilling(cwd: string, identity: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { external, schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      `import { users } from ${JSON.stringify(join(identity, "schema.ts"))};`,
      'const invoices = table("invoices", {',
      "  id: t.uuid().primaryKey(),",
      '  userId: t.uuid().references("users"),',
      "});",
      "export const app = schema({ tables: [external(users), invoices] });",
      "",
    ].join("\n"),
  );
}

function writeConfig(
  cwd: string,
  options: {
    readonly url: string;
    readonly namespace: string;
    readonly external?: readonly string[];
  },
): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  const external =
    options.external === undefined ? "" : `  external: ${JSON.stringify(options.external)},\n`;
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(options.url)},`,
      `  namespace: ${JSON.stringify(options.namespace)},`,
      external.trimEnd(),
      "});",
      "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

function migrationSql(cwd: string): string {
  const directory = join(cwd, "migrations");
  const name = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .at(-1);
  if (name === undefined) throw new Error(`no sql in ${directory}`);
  return join(directory, name);
}

async function columns(url: string, namespace: string, table: string): Promise<readonly string[]> {
  const sql = openPostgres(url);
  try {
    const rows = await sql<{ name: string }[]>`
      select a.attname as name
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${namespace} and c.relname = ${table}
        and a.attnum > 0 and not a.attisdropped
      order by a.attnum
    `;
    return rows.map((row) => row.name);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function metaSchemas(url: string): Promise<readonly string[]> {
  const sql = openPostgres(url);
  try {
    const rows = await sql<{ name: string }[]>`
      select n.nspname as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relname = 'okm_meta'
      order by n.nspname
    `;
    return rows.map((row) => row.name);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function sqlOn(url: string, statement: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  const result = await invoke(cwd, argv);
  if (result.code !== undefined) {
    throw new OkmError(result.code, result.message ?? "", {
      ...(result.kind === undefined ? {} : { kind: result.kind }),
      ...(result.fieldReason === undefined ? {} : { fieldReason: result.fieldReason }),
    });
  }
  return result.stdout;
}

async function rejected(cwd: string, argv: readonly string[]): Promise<OkmError> {
  const result = await invoke(cwd, argv);
  if (result.code === undefined) throw new Error(`${argv.join(" ")} should have failed`);
  return new OkmError(result.code, result.message ?? "", {
    ...(result.kind === undefined ? {} : { kind: result.kind }),
    ...(result.fieldReason === undefined ? {} : { fieldReason: result.fieldReason }),
  });
}

type InvokeResult = {
  readonly stdout: string;
  readonly code?: string;
  readonly message?: string;
  readonly kind?: OkmError["kind"];
  readonly fieldReason?: string;
};

async function invoke(cwd: string, argv: readonly string[]): Promise<InvokeResult> {
  const script = [
    `import { OkmError } from ${JSON.stringify(join(root, "src/contracts/error.ts"))};`,
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    "try {",
    `  await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "  process.stdout.write(JSON.stringify({ stdout: lines.join('') }));",
    "} catch (error) {",
    "  const mapped = OkmError.from(error);",
    "  process.stdout.write(JSON.stringify({ stdout: lines.join(''), code: mapped.code, message: mapped.message, kind: mapped.kind, fieldReason: mapped.fieldReason }));",
    "  process.exit(1);",
    "}",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (stdout.startsWith("{")) return JSON.parse(stdout) as InvokeResult;
  throw new Error(stderr.length > 0 ? stderr : `okm exited ${String(code)} with ${stdout}`);
}
