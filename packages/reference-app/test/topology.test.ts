/**
 * The tracker on the CI topology: one primary and two hot standbys.
 *
 * The app connects as its application role. Board reads go to a replica,
 * a board read right after a move sees the move while both replicas are
 * paused, and the report stays on a replica.
 */

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../../harness/src/postgres-test.js";
import { openPostgres } from "../../harness/src/postgres.js";
import {
  pauseWalReplay,
  readInsertLsn,
  resumeWalReplay,
  waitForReplayLsn,
  withReplicationLock,
} from "../../harness/src/replication.js";
import { replicaUrl, type ReplicaName } from "../../harness/src/topology.js";
import { appRoleUrl, asRole, loadApp, previewDatabase } from "./support.js";

const gate = await loadPostgresGate();

type Route = { readonly op: string; readonly endpoint: string; readonly reason: string };

postgresTest(
  gate,
  "board reads use a replica, a move is read back with replay paused, and the report stays on a replica",
  () =>
    withReplicationLock(async () => {
      const app = await loadApp();
      const { database } = await previewDatabase();
      const admin = openPostgres(database.url);
      const routes: Route[] = [];
      try {
        const name = new URL(database.url).pathname;
        const replica = (which: ReplicaName) => {
          const url = new URL(replicaUrl(which));
          url.pathname = name;
          return { name: which, url: asRole(url.href) };
        };
        const db = await app.openTopology(
          await appRoleUrl(database.url),
          [replica("a"), replica("b")],
          {
            onRoute: (event) => {
              routes.push({ op: event.op, endpoint: event.endpoint, reason: event.reason });
            },
          },
        );
        try {
          const { owner, db: scoped } = await app.createWorkspace(db, {
            name: "Acme",
            slug: "acme",
            owner: { email: "ada@acme.test", name: "Ada" },
          });
          const project = await app.addProject(scoped, {
            name: "Launch",
            slug: "launch",
            ownerId: owner.id,
          });
          const [task] = await app.addTasks(scoped, project.id, [
            { title: "Write the brief" },
            { title: "Book the venue" },
          ]);
          if (task === undefined) throw new Error("addTasks returned no rows");
          await caughtUp(admin);

          routes.length = 0;
          await app.board(scoped, project.id, { limit: 10 });
          expect(routes).toHaveLength(1);
          expect(["a", "b"]).toContain(routes[0]?.endpoint ?? "");
          expect(routes[0]?.reason ?? "").toStartWith("auto:");

          await pauseWalReplay("a");
          await pauseWalReplay("b");
          await app.moveTask(scoped, task.id, "done");
          routes.length = 0;
          const after = await app.board(scoped, project.id, { limit: 10 });
          expect(after.items.find((item) => item.id === task.id)?.status).toBe("done");
          expect(routes).toEqual([{ op: "read", endpoint: "primary", reason: "fallback:behind" }]);

          await resumeWalReplay("a");
          await resumeWalReplay("b");
          await caughtUp(admin);
          routes.length = 0;
          const summary = await app.report(scoped);
          expect(routes.map((route) => route.endpoint).every((e) => e === "a" || e === "b")).toBe(
            true,
          );
          expect(routes).toHaveLength(2);
          expect(summary.byStatus).toContainEqual({
            projectId: project.id,
            status: "done",
            count: 1,
          });
        } finally {
          await db.close();
        }
      } finally {
        await resumeWalReplay("a").catch(() => undefined);
        await resumeWalReplay("b").catch(() => undefined);
        await admin.end({ timeout: 5 });
        await database.close();
      }
    }),
  90_000,
);

async function caughtUp(admin: ReturnType<typeof openPostgres>): Promise<void> {
  const mark = await readInsertLsn(admin);
  await waitForReplayLsn("a", mark);
  await waitForReplayLsn("b", mark);
}
