/**
 * The startup app with validation enabled.
 *
 * Reported beside the featureless fixture. Not a gate. `insert.validate` is
 * not called here, so the engine stays a lazy chunk. `v` is imported because
 * a validating app names its rules.
 */

import { OkmError } from "../src/contracts/index.js";
import {
  boolean,
  eq,
  id,
  integer,
  jsonb,
  numeric,
  schema,
  table,
  text,
  timestamptz,
  uuid,
} from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { v } from "../src/runtime/validate/index.js";

const users = table("users", {
  id: id(),
  email: text().validate([v.trim(), v.lowercase()]),
  name: text(),
  active: boolean(),
});

const orgs = table("orgs", {
  id: id(),
  name: text(),
  seats: integer(),
});

const tasks = table("tasks", {
  id: id(),
  ownerId: uuid().references("users"),
  orgId: uuid().references("orgs"),
  title: text(),
  due: timestamptz().nullable(),
  status: text(),
});

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
  validation: true,
});

/** Keeps the contracts entry in the bundle. Tree-shaking drops the unused exports. */
export const startupError = OkmError;

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
