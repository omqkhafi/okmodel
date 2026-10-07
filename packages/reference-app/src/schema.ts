/**
 * The project tracker schema.
 *
 * A workspace is the tenant. Every other table carries `workspaceId` through
 * column tenancy, and every read and write is scoped by `db.for({ workspaceId })`.
 */

import { fn } from "okmodel/fn";
import { many, one, schema, table, t } from "okmodel/pg";
import { columnTenancy, global } from "okmodel/tenancy";
import { archivable, timestamps } from "okmodel/traits";
import { view } from "okmodel/view";

/** Task states, in board order. */
export const TASK_STATUSES = ["todo", "doing", "done"] as const;

/** The tenant directory. Its `id` is the value passed to `for({ workspaceId })`. */
const workspaces = table(
  "workspaces",
  { id: t.id({ default: "uuidv4" }), name: t.text(), slug: t.text().unique() },
  { tenancy: global("workspace directory"), traits: [timestamps()] },
);

/** People in one workspace. */
const members = table(
  "members",
  { id: t.id({ default: "uuidv4" }), email: t.text().unique(), name: t.text() },
  { traits: [timestamps()] },
);

/** Projects. Archiving one archives its tasks with the same `archiveId`. */
const projects = table(
  "projects",
  {
    id: t.id({ default: "uuidv4" }),
    name: t.text(),
    slug: t.text().unique(),
    ownerId: t.uuid().references("members"),
  },
  {
    traits: [timestamps(), archivable({ cascade: ["tasks"] })],
    relations: { owner: one("members", "ownerId"), tasks: many("tasks", "projectId") },
  },
);

/** Tasks on a project board. */
const tasks = table(
  "tasks",
  {
    id: t.id({ default: "uuidv4" }),
    projectId: t.uuid().references("projects"),
    title: t.text(),
    status: t.enum("task_status", TASK_STATUSES),
    assigneeId: t.uuid().nullable().references("members"),
    publicId: t.uuid().defaultSql("gen_random_uuid()"),
  },
  {
    traits: [timestamps(), archivable()],
    relations: {
      project: one("projects", "projectId"),
      assignee: one("members", "assigneeId"),
      comments: many("comments", "taskId"),
    },
  },
);

/** Comments on a task. */
const comments = table(
  "comments",
  {
    id: t.id({ default: "uuidv4" }),
    taskId: t.uuid().references("tasks"),
    authorId: t.uuid().references("members"),
    body: t.text(),
  },
  {
    traits: [timestamps()],
    relations: { task: one("tasks", "taskId"), author: one("members", "authorId") },
  },
);

/** True for a task that still belongs on the board. */
const taskIsOpen = fn("task_is_open", {
  arguments: [{ name: "status", type: "task_status" }],
  returns: "boolean",
  language: "sql",
  volatility: "immutable",
  body: "select status <> 'done'::task_status",
});

/** Projects that are not archived. */
const activeProjects = view("active_projects", {
  columns: [
    { name: "workspace_id", type: "uuid" },
    { name: "id", type: "uuid" },
    { name: "name", type: "text" },
  ],
  query: " SELECT workspace_id,\n    id,\n    name\n   FROM projects\n  WHERE archived_at IS NULL;",
});

/** Open tasks per project, through `task_is_open`. */
const openTasks = view("open_tasks", {
  columns: [
    { name: "workspace_id", type: "uuid" },
    { name: "project_id", type: "uuid" },
    { name: "open_tasks", type: "bigint" },
  ],
  query:
    " SELECT workspace_id,\n    project_id,\n    count(*) AS open_tasks\n   FROM tasks\n  WHERE task_is_open(status) AND archived_at IS NULL\n  GROUP BY workspace_id, project_id;",
});

/** The application schema. */
export default schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "workspaceId", type: "uuid" }),
  tables: [workspaces, members, projects, tasks, comments],
  functions: [taskIsOpen],
  views: [activeProjects, openTasks],
});
