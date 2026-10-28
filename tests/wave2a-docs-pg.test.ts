/**
 * Operations and migration handbook fences that touch Postgres.
 *
 * Rehearsal is `okm migrate apply --target rehearsal` on a clone of production.
 * This job has no production database to clone, so that fence is not executed.
 */

import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, withPostgres } from "../packages/harness/src/postgres.js";
import { sqlStatements } from "../src/tooling/migrate/sql-lex.js";

const root = join(import.meta.dir, "..");
const cli = join(root, "src/tooling/cli.ts");
const gate = await loadPostgresGate();

const imports: readonly (readonly [string, string])[] = [
  ["okmodel/pg/postgresjs", join(root, "src/runtime/pg/postgresjs.ts")],
  ["okmodel/testing", join(root, "src/tooling/testing/index.ts")],
  ["okmodel/migrate", join(root, "src/tooling/migrate/index.ts")],
  ["okmodel/pg", join(root, "src/dialects/pg/index.ts")],
];

function fence(text: string, lang: string, title: string): string {
  const pattern = new RegExp(
    `\`\`\`${lang} title="${title.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\n([\\s\\S]*?)\`\`\``,
  );
  const body = pattern.exec(text)?.[1];
  if (body === undefined) throw new Error(`missing ${lang} fence ${title}`);
  return body;
}

function writeFence(cwd: string, name: string, body: string): void {
  let next = body;
  for (const [specifier, path] of imports) {
    next = next.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(path)}`);
  }
  writeFileSync(join(cwd, name), next.endsWith("\n") ? next : `${next}\n`);
}

function cliProc(
  cwd: string,
  argv: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync("bun", [cli, ...argv], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function spawnOk(cwd: string, name: string, body: string): void {
  writeFence(cwd, name, body);
  const proc = spawnSync("bun", [join(cwd, name)], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  expect(proc.status, `${name}\n${proc.stderr}`).toBe(0);
}

postgresTest(
  gate,
  "production apply then connect({ requireMeta: true })",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-wave2a-prod-"));
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;
    const checklist = await Bun.file(
      join(root, "site/content/docs/operate/production-checklist.mdx"),
    ).text();
    try {
      writeFence(cwd, "schema.ts", fence(checklist, "ts", "schema.ts"));
      writeFence(cwd, "okmodel.config.ts", fence(checklist, "ts", "okmodel.config.ts"));
      const generated = cliProc(cwd, ["generate", "init"]);
      expect(generated.status, generated.stderr).toBe(0);
      const applied = cliProc(cwd, ["migrate", "apply", "--target", "production"]);
      expect(applied.status, applied.stderr).toBe(0);
      expect(fence(checklist, "sh", "apply.sh").trim()).toBe(
        "okm migrate apply --target production",
      );
      spawnOk(cwd, "connect.ts", fence(checklist, "ts", "connect.ts"));
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "the testing fence creates a row and counts one statement",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-wave2a-test-"));
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;
    const testing = await Bun.file(join(root, "site/content/docs/operate/testing.mdx")).text();
    try {
      spawnOk(cwd, "factories.ts", fence(testing, "ts", "factories.ts"));
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "the agent role recipe grants read-all and schema CREATE",
  async () => {
    const page = await Bun.file(
      join(root, "site/content/docs/operate/protected-targets-and-roles.mdx"),
    ).text();
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const reader = `okm_reader_${suffix}`;
    const migrator = `okm_migrator_${suffix}`;
    await withPostgres(async (sql) => {
      try {
        for (const title of ["reader.sql", "migrator.sql"]) {
          const rewritten = fence(page, "sql", title)
            .replaceAll("okm_agent_reader", reader)
            .replaceAll("okm_agent_migrator", migrator);
          for (const statement of sqlStatements(rewritten)) await sql.unsafe(statement);
        }
        const rows = await sql.unsafe(
          `select pg_has_role('${reader}', 'pg_read_all_data', 'member') as reader_member,
                  pg_has_role('${migrator}', 'pg_read_all_data', 'member') as migrator_member,
                  has_schema_privilege('${reader}', 'public', 'CREATE') as reader_create,
                  has_schema_privilege('${migrator}', 'public', 'CREATE') as migrator_create`,
        );
        const row = rows[0] as
          | {
              reader_member: boolean;
              migrator_member: boolean;
              reader_create: boolean;
              migrator_create: boolean;
            }
          | undefined;
        expect(row?.reader_member).toBe(true);
        expect(row?.migrator_member).toBe(true);
        expect(row?.reader_create).toBe(false);
        expect(row?.migrator_create).toBe(true);
      } finally {
        await sql.unsafe(`revoke all on schema public from ${migrator}`).catch(() => undefined);
        await sql.unsafe(`drop role if exists ${migrator}`);
        await sql.unsafe(`drop role if exists ${reader}`);
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "the backfill update and the declared probe run on Postgres",
  async () => {
    const database = await createIsolatedDatabase();
    const backfill = await Bun.file(join(root, "site/content/docs/migrations/backfill.mdx")).text();
    const failures = await Bun.file(join(root, "site/content/docs/migrations/failures.mdx")).text();
    const update = sqlStatements(fence(backfill, "sql", "backfill.sql")).at(-1);
    const probeBody = fence(failures, "sql", "probe.sql");
    const probeLine = probeBody.split("\n").find((line) => line.startsWith("-- probe: "));
    const create = sqlStatements(probeBody).at(-1);
    if (update === undefined || probeLine === undefined || create === undefined) {
      throw new Error("backfill or probe fence has no statement");
    }
    const probe = probeLine.slice("-- probe: ".length);
    try {
      await withPostgres(async (sql) => {
        await sql.unsafe(
          `create table "public"."tasks" (id bigint generated always as identity primary key, status text)`,
        );
        await sql.unsafe(`insert into "public"."tasks" (status) values ('a'), ('b')`);
        await sql.unsafe(update, [null, null]);
        const rows = await sql<
          { status: string }[]
        >`select status from "public"."tasks" order by id`;
        expect(rows.map((row) => row.status)).toEqual(["b", "b"]);
        const absent = await sql.unsafe(probe);
        expect(Object.values(absent[0] ?? {})[0]).toBe(false);
        await sql.unsafe(create);
        const present = await sql.unsafe(probe);
        expect(Object.values(present[0] ?? {})[0]).toBe(true);
      }, database.url);
    } finally {
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "preview apply installs the head snapshot on an empty database",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-wave2a-preview-"));
    const previous = process.env.PREVIEW_DATABASE_URL;
    process.env.PREVIEW_DATABASE_URL = database.url;
    const environments = await Bun.file(
      join(root, "site/content/docs/migrations/environments.mdx"),
    ).text();
    try {
      expect(fence(environments, "sh", "preview.sh").trim()).toBe(
        "okm migrate apply --target preview",
      );
      expect(fence(environments, "sh", "rehearsal.sh").trim()).toBe(
        "okm migrate apply --target rehearsal",
      );
      writeFence(cwd, "schema.ts", fence(environments, "ts", "schema.ts"));
      writeFence(cwd, "okmodel.config.ts", fence(environments, "ts", "okmodel.config.ts"));
      const generated = cliProc(cwd, ["generate", "init"]);
      expect(generated.status, generated.stderr).toBe(0);
      const applied = cliProc(cwd, ["migrate", "apply", "--target", "preview"]);
      expect(applied.status, applied.stderr).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.PREVIEW_DATABASE_URL;
      else process.env.PREVIEW_DATABASE_URL = previous;
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);
