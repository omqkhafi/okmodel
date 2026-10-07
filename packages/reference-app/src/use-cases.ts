/**
 * What the project tracker does, one function per use case.
 *
 * Each function takes a client and returns plain rows. There is no server and
 * no UI: the tests and CI call these directly.
 */

import type { AppDb, WorkspaceDb } from "./db.js";
import type { TASK_STATUSES } from "./schema.js";

/** A task state. */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Comments shown on each board card. */
export const BOARD_COMMENTS = 3;

/**
 * Creates a workspace and its first member.
 *
 * @param db - Unscoped client
 * @param input - Workspace name and slug, and the owner
 * @returns The workspace and the owner, with a client scoped to the workspace
 */
export async function createWorkspace(
  db: AppDb,
  input: {
    readonly name: string;
    readonly slug: string;
    readonly owner: { readonly email: string; readonly name: string };
  },
) {
  const workspace = await db.workspaces.insert({ name: input.name, slug: input.slug });
  const scoped = db.for({ workspaceId: workspace.id });
  const owner = await scoped.members.insert(input.owner);
  return { workspace, owner, db: scoped };
}

/**
 * Adds a project.
 *
 * @param db - Workspace client
 * @param input - Name, slug, and owning member
 * @returns The project
 */
export function addProject(
  db: WorkspaceDb,
  input: { readonly name: string; readonly slug: string; readonly ownerId: string },
) {
  return db.projects.insert(input);
}

/**
 * Adds tasks to a project in one statement.
 *
 * @param db - Workspace client
 * @param projectId - Project the tasks belong to
 * @param tasks - Titles, with an optional state (default `todo`) and assignee
 * @returns The tasks, in input order
 */
export function addTasks(
  db: WorkspaceDb,
  projectId: string,
  tasks: readonly {
    readonly title: string;
    readonly status?: TaskStatus;
    readonly assigneeId?: string;
  }[],
) {
  return db.tasks.insert(
    tasks.map((task) => ({
      projectId,
      title: task.title,
      status: task.status ?? "todo",
      ...(task.assigneeId === undefined ? {} : { assigneeId: task.assigneeId }),
    })),
  );
}

/**
 * Comments on a task.
 *
 * @param db - Workspace client
 * @param input - Task, author, and text
 * @returns The comment
 */
export function addComment(
  db: WorkspaceDb,
  input: { readonly taskId: string; readonly authorId: string; readonly body: string },
) {
  return db.comments.insert(input);
}

/**
 * Moves a task to another column of the board.
 *
 * @param db - Workspace client
 * @param taskId - Task to move
 * @param status - New state
 * @returns `{ count: 1 }`
 * @throws OkmError when the task is not in this workspace
 */
export async function moveTask(db: WorkspaceDb, taskId: string, status: TaskStatus) {
  return await db.tasks.update({ where: { id: taskId }, set: { status } }).expect(1);
}

/**
 * Archives a project and its tasks under one `archiveId`.
 *
 * @param db - Workspace client
 * @param projectId - Project to archive
 * @returns The `archiveId` to restore with
 */
export async function archiveProject(db: WorkspaceDb, projectId: string): Promise<string> {
  const archived = await db.projects.archive({ where: { id: projectId } });
  return archived.archiveId;
}

/**
 * Restores a project and the tasks archived with it.
 *
 * @param db - Workspace client
 * @param archiveId - The value {@link archiveProject} returned
 * @returns `{ count }` of restored projects
 */
export function restoreProject(db: WorkspaceDb, archiveId: string) {
  return db.projects.onlyArchived().restore({ archiveId });
}

/**
 * One page of a project board: tasks with the assignee and the latest comments.
 *
 * Tasks are in board order: by state (`todo`, `doing`, `done`), then title.
 * One statement. Pass the previous `next` as `after` for the following page.
 *
 * @param db - Workspace client
 * @param projectId - Project whose board this is
 * @param options - Page size, and the cursor of the page before
 * @returns `{ items, next }`
 */
export function board(
  db: WorkspaceDb,
  projectId: string,
  options: { readonly limit: number; readonly after?: string | null },
) {
  return db.tasks.page({
    where: { projectId },
    orderBy: { status: "asc", title: "asc" },
    limit: options.limit,
    after: options.after ?? null,
    include: {
      assignee: { select: ["id", "name"] },
      comments: { limit: BOARD_COMMENTS, orderBy: { createdAt: "desc" }, select: ["body"] },
    },
  });
}

/**
 * The workspace report, read from a replica.
 *
 * Two statements: task counts per project and state, and the `open_tasks` view.
 * `route: "replica"` never falls back to the primary.
 *
 * @param db - Workspace client
 * @returns Counts by project and state, and open tasks per project
 */
export async function report(db: WorkspaceDb) {
  const byStatus = await db.tasks.aggregate({
    count: true,
    groupBy: ["projectId", "status"],
    limit: 500,
    route: "replica",
  });
  const open = await db.views.openTasks.find({ limit: 500, route: "replica" });
  return { byStatus, open };
}
