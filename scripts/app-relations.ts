/**
 * The startup app with `manyThrough`, `page` and `aggregate` in use.
 *
 * Reported beside the featureless fixture. Not a gate. The relation carries its
 * emitter, so it is in this bundle; the `page` and `aggregate` planners stay lazy
 * chunks because the calls sit in a function that is not run at import.
 */

import { OkmError } from "../src/contracts/index.js";
import {
  boolean,
  eq,
  id,
  integer,
  has,
  jsonb,
  manyThrough,
  numeric,
  schema,
  table,
  text,
  timestamptz,
  uuid,
} from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const users = table("users", {
  id: id(),
  email: text(),
  name: text(),
  active: boolean(),
});

const orgs = table("orgs", {
  id: id(),
  name: text(),
  seats: integer(),
});

const tasks = table(
  "tasks",
  {
    id: id(),
    ownerId: uuid().references("users"),
    orgId: uuid().references("orgs"),
    title: text(),
    due: timestamptz().nullable(),
    status: text(),
  },
  { relations: { tags: manyThrough("tags", { through: "task_tags" }) } },
);

const notes = table("notes", {
  id: id(),
  taskId: uuid().references("tasks"),
  body: text(),
});

const tags = table("tags", {
  id: id(),
  label: text(),
});

const taskTags = table("task_tags", {
  taskId: uuid().references("tasks"),
  tagId: uuid().references("tags"),
});

const invoices = table("invoices", {
  id: id(),
  orgId: uuid().references("orgs"),
  total: numeric(12, 2),
  paid: boolean(),
});

const events = table("events", {
  id: id(),
  at: timestamptz(),
  payload: jsonb(),
});

const files = table("files", {
  id: id(),
  ownerId: uuid().references("users"),
  bytes: integer(),
  name: text(),
});

const sessions = table("sessions", {
  id: id(),
  userId: uuid().references("users"),
  seen: timestamptz(),
});

/** Schema built when this module is imported. */
export const app = schema({
  tables: [users, orgs, tasks, notes, tags, taskTags, invoices, events, files, sessions],
});

/** Keeps the contracts entry in the bundle. Tree-shaking drops the unused exports. */
export const startupError = OkmError;

/**
 * A page, an aggregate, and a `manyThrough` include and filter. Not called at import.
 *
 * @param url - Postgres connection string
 * @returns The three calls
 */
export function readRelations(url: string) {
  const db = connect(url, { schema: app });
  return [
    db.tasks.page({ orderBy: { title: "asc" }, limit: 20 }),
    db.tasks.aggregate({ groupBy: ["status"], count: true, limit: 10 }),
    db.tasks.find({
      where: { tags: has({ label: "urgent" }) },
      include: { tags: { limit: 5 } },
      limit: 10,
    }),
  ] as const;
}

/**
 * One read through `connect`. Not called at import, so startup does not open a pool.
 *
 * @param url - Postgres connection string
 * @returns The first matching user
 */
export function readUser(url: string) {
  const db = connect(url, { schema: app });
  return db.users.find({ where: { email: eq("a@b.c") }, limit: 1 });
}
