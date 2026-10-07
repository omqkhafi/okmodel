/**
 * The preview workflow: a database per job, provisioned from the head snapshot.
 *
 * Two jobs run at the same time, as two pull requests would. Each creates its
 * own database, runs `okm migrate apply`, checks it, and runs the use cases as
 * the application role. Neither job sees the other's rows.
 */

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../../harness/src/postgres-test.js";
import { openPostgres } from "../../harness/src/postgres.js";
import { appRoleUrl, loadApp, okmOk, previewDatabase } from "./support.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "two preview jobs run at once on their own databases and share no data",
  async () => {
    const app = await loadApp();
    const job = async (name: string) => {
      const { database, applied } = await previewDatabase();
      try {
        const env = { PREVIEW_DATABASE_URL: database.url };
        expect(applied).toContain("applied provisioned@0003_drop_share_token");
        expect(await okmOk(["check", "--target", "preview"], env)).toBe("ok\n");
        expect(await okmOk(["migrate", "status", "--target", "preview"], env)).toContain(
          "0003_drop_share_token",
        );
        const db = app.openPrimary(await appRoleUrl(database.url), { max: 2 });
        try {
          const { owner, db: scoped } = await app.createWorkspace(db, {
            name: name,
            slug: name,
            owner: { email: `owner@${name}.test`, name: "Owner" },
          });
          const project = await app.addProject(scoped, {
            name: "Board",
            slug: "board",
            ownerId: owner.id,
          });
          await app.addTasks(scoped, project.id, [{ title: `${name} task` }]);
          const page = await app.board(scoped, project.id, { limit: 10 });
          expect(page.items.map((task) => task.title)).toEqual([`${name} task`]);
        } finally {
          await db.close();
        }
        return database;
      } catch (error) {
        await database.close();
        throw error;
      }
    };

    const settled = await Promise.allSettled([job("job-a"), job("job-b")]);
    const databases = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    try {
      for (const result of settled) if (result.status === "rejected") throw result.reason;
      const [a, b] = databases;
      if (a === undefined || b === undefined) throw new Error("two jobs expected");
      expect(a.url).not.toBe(b.url);
      expect(await workspaceSlugs(a.url)).toEqual(["job-a"]);
      expect(await workspaceSlugs(b.url)).toEqual(["job-b"]);
      expect(await taskTitles(a.url)).toEqual(["job-a task"]);
      expect(await taskTitles(b.url)).toEqual(["job-b task"]);
      expect(
        await okmOk(["migrate", "check", "--provision", "--target", "preview"], {
          PREVIEW_DATABASE_URL: a.url,
        }),
      ).toBe("ok 3 migrations\n");
    } finally {
      await Promise.all(databases.map((database) => database.close()));
    }
  },
  90_000,
);

async function workspaceSlugs(url: string): Promise<string[]> {
  const sql = openPostgres(url);
  try {
    const rows = await sql<{ slug: string }[]>`select slug from workspaces order by slug`;
    return rows.map((row) => row.slug);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function taskTitles(url: string): Promise<string[]> {
  const sql = openPostgres(url);
  try {
    const rows = await sql<{ title: string }[]>`select title from tasks order by title`;
    return rows.map((row) => row.title);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
