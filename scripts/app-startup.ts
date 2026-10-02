/**
 * A small application used to measure a tree-shaken startup bundle.
 *
 * Ten tables and eight column types. Imports are the builders the tables use,
 * plus `OkmError` from the package entry, so unused column modules can be dropped.
 * `schema()` runs at import, which is what a process pays before the first query.
 */

import { OkmError } from "../src/contracts/index.js";
import {
  boolean,
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
});

/** Keeps the contracts entry in the bundle. Tree-shaking drops the unused exports. */
export const startupError = OkmError;
