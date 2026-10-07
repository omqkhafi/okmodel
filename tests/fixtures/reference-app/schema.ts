/**
 * The schema shape the reference app (P65) checks and connects with.
 *
 * An enum, an archivable table with a unique column, a view, a function that
 * takes the enum, and a view that calls the function. `okmodel.config.ts`
 * adds the roles.
 */

import { fn } from "../../../src/dialects/pg/fn/index.js";
import { schema, t, table } from "../../../src/dialects/pg/index.js";
import { view } from "../../../src/dialects/pg/view/index.js";
import { columnTenancy, global } from "../../../src/runtime/tenancy/index.js";
import { archivable } from "../../../src/runtime/traits/index.js";

const workspaces = table(
  "workspaces",
  { id: t.id({ default: "uuidv4" }), name: t.text() },
  { tenancy: global("workspace directory") },
);

const projects = table(
  "projects",
  { id: t.id({ default: "uuidv4" }), name: t.text(), slug: t.text().unique() },
  { traits: [archivable()] },
);

const tasks = table("tasks", {
  id: t.id({ default: "uuidv4" }),
  projectId: t.uuid().references("projects"),
  title: t.text(),
  status: t.enum("task_status", ["todo", "doing", "done"]),
});

const taskIsOpen = fn("task_is_open", {
  arguments: [{ name: "status", type: "task_status" }],
  returns: "boolean",
  language: "sql",
  volatility: "immutable",
  body: "select status <> 'done'::task_status",
});

/** The reference schema. */
export const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "workspaceId", type: "uuid" }),
  tables: [workspaces, projects, tasks],
  functions: [taskIsOpen],
  views: [
    view("active_projects", {
      columns: [
        { name: "workspace_id", type: "uuid" },
        { name: "name", type: "text" },
      ],
      query: " SELECT workspace_id,\n    name\n   FROM projects\n  WHERE archived_at IS NULL;",
    }),
    view("open_tasks", {
      columns: [
        { name: "workspace_id", type: "uuid" },
        { name: "project_id", type: "uuid" },
        { name: "open_tasks", type: "bigint" },
      ],
      query:
        " SELECT workspace_id,\n    project_id,\n    count(*) AS open_tasks\n   FROM tasks\n  WHERE task_is_open(status)\n  GROUP BY workspace_id, project_id;",
    }),
  ],
});
