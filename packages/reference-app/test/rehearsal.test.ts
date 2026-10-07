/**
 * The rehearsal workflow: expand and contract on a clone of a populated database.
 *
 * The original stands in for production: it is at `0001_init` and holds rows.
 * The clone is made with `CREATE DATABASE ... TEMPLATE`. `okm migrate check`
 * and `okm migrate apply` run on the clone; the original does not change. As a
 * protected target, the original is refused by `okm migrate check` before any
 * write.
 */

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../../harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../../harness/src/postgres.js";
import { okm, okmOk, projectAt, removeProject } from "./support.js";

const gate = await loadPostgresGate();

/** Tasks seeded on the original: four backfill batches of 500. */
const TASKS = 2_000;

postgresTest(
  gate,
  "a populated clone takes the expand and the contract, the original is untouched, and a protected original is refused",
  async () => {
    await withOriginal(async (original) => {
      const before = await fingerprint(original);
      expect(before.columns).toContain("share_token");
      expect(before.columns).not.toContain("public_id");
      await withClone(original, async (clone) => {
        const env = { REHEARSAL_DATABASE_URL: clone };
        expect(await okmOk(["migrate", "check", "--target", "rehearsal"], env)).toBe(
          "ok 3 migrations\n",
        );
        const applied = await okmOk(["migrate", "apply", "--target", "rehearsal"], env);
        expect(applied).toContain("applied 0002_public_id");
        expect(applied).toContain("applied 0003_drop_share_token");
        expect(await okmOk(["check", "--target", "rehearsal"], env)).toBe("ok\n");
        const after = await fingerprint(clone);
        expect(after.columns).toContain("public_id");
        expect(after.columns).not.toContain("share_token");
        expect(after.tasks).toBe(TASKS);
        expect(after.filled).toBe(TASKS);
        expect(after.history).toBeGreaterThan(before.history);
      });
      expect(await fingerprint(original)).toEqual(before);

      const refused = await okm(["migrate", "check", "--target", "production"], {
        PRODUCTION_DATABASE_URL: original,
      });
      expect(refused.code).not.toBe(0);
      expect(refused.stdout + refused.stderr).toContain("OKM1850");
      expect(await fingerprint(original)).toEqual(before);
    });
  },
  120_000,
);

postgresTest(
  gate,
  "okm migrate apply on a protected clone runs the expand DDL, then stops at the backfill with OKM1850",
  async () => {
    await withOriginal(async (original) => {
      await withClone(original, async (clone) => {
        const run = await okm(["migrate", "apply", "--target", "production"], {
          PRODUCTION_DATABASE_URL: clone,
        });
        expect(run.code).not.toBe(0);
        expect(run.stdout + run.stderr).toContain("OKM1850");
        const after = await fingerprint(clone);
        expect(after.columns).toContain("public_id");
        expect(after.columns).toContain("share_token");
        expect(after.filled).toBe(0);
      });
    });
  },
  120_000,
);

type Fingerprint = {
  readonly columns: string;
  readonly tasks: number;
  readonly filled: number;
  readonly history: number;
  readonly meta: string;
  readonly digest: string;
};

/**
 * Provisions a database at `0001_init`, seeds it, and passes its URL to `body`.
 */
async function withOriginal(body: (url: string) => Promise<void>): Promise<void> {
  const original = await createIsolatedDatabase();
  const project = projectAt(1);
  try {
    expect(
      await okmOk(["migrate", "apply", "--target", "dev"], { DATABASE_URL: original.url }, project),
    ).toContain("applied provisioned@0001_init");
    await seed(original.url);
    await body(original.url);
  } finally {
    removeProject(project);
    await original.close();
  }
}

/**
 * Clones `url` with `CREATE DATABASE ... TEMPLATE` and drops the clone after `body`.
 */
async function withClone(url: string, body: (clone: string) => Promise<void>): Promise<void> {
  const source = new URL(url).pathname.slice(1);
  const name = `${source}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = openPostgres();
  try {
    await admin.unsafe(`create database ${name} template ${source}`);
    const clone = new URL(url);
    clone.pathname = `/${name}`;
    try {
      await body(clone.href);
    } finally {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function seed(url: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    await sql.unsafe(`
      with workspace as (
        insert into workspaces (name, slug) values ('Acme', 'acme') returning id
      ), owner as (
        insert into members (workspace_id, email, name)
        select id, 'ada@acme.test', 'Ada' from workspace returning id, workspace_id
      ), project as (
        insert into projects (workspace_id, name, slug, owner_id)
        select workspace_id, 'Launch', 'launch', id from owner returning id, workspace_id
      )
      insert into tasks (workspace_id, project_id, title, status, share_token)
      select project.workspace_id, project.id, 'Task ' || n, 'todo', md5(n::text)
        from project, generate_series(1, ${String(TASKS)}) as n
    `);
    await sql.unsafe("analyze tasks");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function fingerprint(url: string): Promise<Fingerprint> {
  const sql = openPostgres(url);
  try {
    const columns = await sql<{ columns: string }[]>`
      select string_agg(column_name::text, ',' order by column_name) as columns
        from information_schema.columns
       where table_schema = 'public' and table_name = 'tasks'
    `;
    const list = columns[0]?.columns ?? "";
    const filled = list.includes("public_id")
      ? await sql.unsafe<{ n: number }[]>(
          "select count(*)::int as n from tasks where public_id is not null",
        )
      : [{ n: 0 }];
    const counts = await sql<{ tasks: number; history: number; meta: string; digest: string }[]>`
      select (select count(*)::int from tasks) as tasks,
             (select count(*)::int from okm_history) as history,
             (select catalog_hash from okm_meta) as meta,
             (select md5(string_agg(id::text || ':' || title, ',' order by id)) from tasks) as digest
    `;
    const row = counts[0];
    if (row === undefined) throw new Error("fingerprint read no row");
    return {
      columns: list,
      tasks: row.tasks,
      filled: filled[0]?.n ?? 0,
      history: row.history,
      meta: row.meta,
      digest: row.digest,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
