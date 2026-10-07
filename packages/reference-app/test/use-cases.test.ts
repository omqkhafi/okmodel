/**
 * Every use case on real Postgres through `okmodel/testing`.
 *
 * One isolated database per run. The board and the report are held to their
 * statement counts, and `isolation()` checks every tenant table.
 */

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../../harness/src/postgres-test.js";
import { createIsolatedDatabase } from "../../harness/src/postgres.js";
import { loadApp } from "./support.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "the tracker runs every use case, keeps the board and the report to their statements, and isolates tenants",
  async () => {
    const app = await loadApp();
    const database = await createIsolatedDatabase();
    const harness = await app.testing(app.app, { driver: app.open({ url: database.url }) });
    try {
      const { workspace, owner, db } = await app.createWorkspace(harness.db, {
        name: "Acme",
        slug: "acme",
        owner: { email: "ada@acme.test", name: "Ada" },
      });
      expect(workspace.slug).toBe("acme");
      expect(owner.workspaceId).toBe(workspace.id);

      const launch = await app.addProject(db, {
        name: "Launch",
        slug: "launch",
        ownerId: owner.id,
      });
      const tasks = await app.addTasks(db, launch.id, [
        { title: "Write the brief", assigneeId: owner.id },
        { title: "Book the venue", status: "doing" },
        { title: "Print the badges", status: "done" },
      ]);
      expect(tasks.map((task) => task.status)).toEqual(["todo", "doing", "done"]);
      expect(tasks.every((task) => typeof task.publicId === "string")).toBe(true);
      for (const body of ["first", "second", "third", "fourth"]) {
        await app.addComment(db, { taskId: tasks[0]!.id, authorId: owner.id, body });
      }

      expect(await app.moveTask(db, tasks[0]!.id, "doing")).toEqual({ count: 1 });

      const first = await counted(harness, 1, () => app.board(db, launch.id, { limit: 2 }));
      expect(first.items.map((task) => task.title)).toEqual(["Book the venue", "Write the brief"]);
      expect(first.items[0]?.assignee).toBeNull();
      expect(first.items[0]?.comments).toEqual([]);
      expect(first.items[1]?.assignee).toEqual({ id: owner.id, name: "Ada" });
      expect(first.items[1]?.comments).toEqual([
        { body: "fourth" },
        { body: "third" },
        { body: "second" },
      ]);
      expect(first.next).not.toBeNull();
      const second = await app.board(db, launch.id, { limit: 2, after: first.next });
      expect(second.items.map((task) => task.title)).toEqual(["Print the badges"]);
      expect(second.next).toBeNull();

      const summary = await counted(harness, 2, () => app.report(db));
      expect(summary.byStatus).toEqual([
        { projectId: launch.id, status: "doing", count: 2 },
        { projectId: launch.id, status: "done", count: 1 },
      ]);
      expect(summary.open).toEqual([
        { workspaceId: workspace.id, projectId: launch.id, openTasks: "2" },
      ]);

      const archiveId = await app.archiveProject(db, launch.id);
      expect(await db.projects.count()).toBe(0);
      expect(await db.tasks.count()).toBe(0);
      expect(await db.views.activeProjects.find({ limit: 10 })).toEqual([]);
      expect(await app.restoreProject(db, archiveId)).toEqual({ count: 1 });
      expect(await db.tasks.count()).toBe(3);
      expect(await db.views.activeProjects.find({ limit: 10, select: ["name"] })).toEqual([
        { name: "Launch" },
      ]);

      const other = await app.createWorkspace(harness.db, {
        name: "Globex",
        slug: "globex",
        owner: { email: "hank@globex.test", name: "Hank" },
      });
      expect(await other.db.tasks.count()).toBe(0);
      const crossed = await app.moveTask(other.db, tasks[0]!.id, "done").then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(crossed).toMatchObject({ code: "not_found", table: "tasks" });

      const report = await harness.isolation();
      expect([...report.checked]).toEqual(["members", "projects", "tasks", "comments"]);
      expect(report.skipped).toEqual([{ table: "workspaces", reason: "workspace directory" }]);
    } finally {
      await harness.close();
      await database.close();
    }
  },
  60_000,
);

/** Runs `run` under `expectQueries(count)` and returns what it returned. */
async function counted<T>(
  harness: { expectQueries(count: number, run: () => Promise<unknown>): Promise<void> },
  count: number,
  run: () => Promise<T>,
): Promise<T> {
  const results: T[] = [];
  await harness.expectQueries(count, async () => {
    results.push(await run());
  });
  const [result] = results;
  if (results.length !== 1 || result === undefined) throw new Error("run did not return once");
  return result;
}
