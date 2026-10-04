/**
 * Projects and labels joined by a table, on two tenants, with archivable labels.
 *
 * `taskLabels` is the join table. Tasks carry a score and a due date for paging and
 * aggregates. `ledger` holds amounts that a JavaScript number would round.
 */

import {
  bigint,
  id,
  integer,
  many,
  manyThrough,
  numeric,
  one,
  schema,
  table,
  text,
  timestamptz,
  uuid,
} from "../src/dialects/pg/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";

/** Tenant A. */
export const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d01";

/** Tenant B. */
export const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d02";

const labels = table(
  "labels",
  { id: id({ default: "none" }), name: text() },
  {
    traits: [archivable()],
    relations: { tasks: manyThrough("tasks", { through: "taskLabels" }) },
  },
);

const tasks = table(
  "tasks",
  {
    id: id({ default: "none" }),
    title: text(),
    score: integer().nullable().default(null),
    due: timestamptz().nullable().default(null),
    team: text().nullable().default(null),
  },
  {
    traits: [archivable()],
    relations: {
      labels: manyThrough("labels", { through: "taskLabels" }),
      links: many("taskLabels", "taskId"),
    },
  },
);

const taskLabels = table(
  "taskLabels",
  {
    id: id({ default: "none" }),
    taskId: uuid().references("tasks"),
    labelId: uuid().references("labels"),
  },
  {
    traits: [archivable()],
    relations: { task: one("tasks", "taskId"), label: one("labels", "labelId") },
  },
);

const ledger = table("ledger", {
  id: id({ default: "none" }),
  account: text(),
  amount: numeric(30, 2),
  big: bigint(),
  rate: numeric(10, 2, { as: "number" }),
});

/** Schema under test. */
export const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [labels, tasks, taskLabels, ledger],
});
