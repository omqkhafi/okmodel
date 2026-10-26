/**
 * `orderBy` on a relation: a to-one column, or `count` on a to-many.
 *
 * An unknown relation, a column that is not orderable, a morph, and an include
 * order are type errors.
 */

import {
  many,
  manyThrough,
  morph,
  morphMany,
  one,
  schema,
  table,
  text,
  uuid,
} from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";

const projects = table(
  "projects",
  {
    id: text().primaryKey(),
    name: text(),
    secret: text().hidden(),
    code: text().nullable().hidden({ filterable: true }),
  },
  { relations: { tasks: many("tasks") } },
);

const tasks = table(
  "tasks",
  {
    id: text().primaryKey(),
    title: text(),
    projectId: text().nullable().references("projects"),
  },
  { relations: { project: one("projects", "projectId"), notes: many("notes") } },
);

const notes = table(
  "notes",
  {
    id: text().primaryKey(),
    taskId: text().references("tasks"),
    body: text(),
  },
  { relations: { task: one("tasks", "taskId") } },
);

const labels = table(
  "labels",
  { id: text().primaryKey(), name: text() },
  { relations: { tasks: manyThrough("tasks", { through: "taskLabels" }) } },
);

const taskLabels = table("taskLabels", {
  id: text().primaryKey(),
  taskId: text().references("tasks"),
  labelId: text().references("labels"),
});

const owners = table(
  "owners",
  { id: text().primaryKey(), title: text() },
  { relations: { comments: morphMany("comments", "commentable") } },
);

const comments = table(
  "comments",
  {
    id: text().primaryKey(),
    body: text(),
    commentableType: text(),
    commentableId: uuid(),
  },
  { relations: { commentable: morph("commentable", ["owners"]) } },
);

const app = schema({
  tables: [projects, tasks, notes, labels, taskLabels, owners, comments],
});

declare const db: Connected<typeof app>;

void db.tasks.find({ orderBy: { project: { name: "asc" } }, limit: 1 });
void db.tasks.find({
  orderBy: { project: { name: { dir: "asc", nulls: "first" } } },
  limit: 1,
});
void db.tasks.find({ orderBy: { project: { code: "asc" } }, limit: 1 });
void db.tasks.find({ orderBy: { notes: { count: "desc" } }, limit: 1 });
void db.tasks.find({ orderBy: { notes: { count: { dir: "desc", nulls: "last" } } }, limit: 1 });
void db.labels.find({ orderBy: { tasks: { count: "asc" } }, limit: 1 });
void db.tasks.one({ orderBy: { project: { name: "desc" } } });
void db.tasks.page({ orderBy: { notes: { count: "desc" } }, limit: 2 });
void db.tasks.find({ orderBy: { title: "asc", project: { name: "asc" } }, limit: 1 });

// @ts-expect-error an unknown relation is not an order
void db.tasks.find({ orderBy: { nope: { name: "asc" } }, limit: 1 });
// @ts-expect-error a hidden related column is not orderable
void db.tasks.find({ orderBy: { project: { secret: "asc" } }, limit: 1 });
// @ts-expect-error an unknown related column is not orderable
void db.tasks.find({ orderBy: { project: { missing: "asc" } }, limit: 1 });
// @ts-expect-error a to-many relation orders by count
void db.tasks.find({ orderBy: { notes: { body: "asc" } }, limit: 1 });
// @ts-expect-error count orders a to-many relation
void db.tasks.find({ orderBy: { project: { count: "asc" } }, limit: 1 });
// @ts-expect-error a morph is not an order
void db.comments.find({ orderBy: { commentable: { title: "asc" } }, limit: 1 });
// @ts-expect-error morphMany is not a count
void db.owners.find({ orderBy: { comments: { count: "desc" } }, limit: 1 });
declare const noteByTask: { readonly task: { readonly title: "asc" } };
void db.tasks.find({
  include: {
    notes: {
      limit: 1,
      // @ts-expect-error include orderBy stays a column of the related row
      orderBy: noteByTask,
    },
  },
  limit: 1,
});
// @ts-expect-error aggregate does not order by a relation
void db.tasks.aggregate({ count: true, orderBy: { project: { name: "asc" } } });
