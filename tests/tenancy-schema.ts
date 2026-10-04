/**
 * Column-tenancy schema shared by the unit and Postgres tests.
 *
 * Two tenant tables share ids. One unique is widened. One unique stays global.
 * Countries are shared.
 */

import { id, index, many, one, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { columnTenancy, global } from "../src/runtime/tenancy/index.js";

/** One tenant. */
export const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";

/** The other tenant. Same org and task ids live here too. */
export const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";

/** Org id used by both tenants. */
export const ORG = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c01";

/** Task id used by both tenants. */
export const TASK = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02";

/** An org that exists only for tenant B. */
export const ORG_B_ONLY = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c03";

/** A shared country. */
export const COUNTRY = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c04";

const orgs = table(
  "orgs",
  {
    id: id({ default: "none" }),
    name: text(),
  },
  { relations: { tasks: many("tasks", "orgId") } },
);

const tasks = table(
  "tasks",
  {
    id: id({ default: "none" }),
    title: text().unique(),
    code: text().unique({ global: "shared codes" }),
    orgId: uuid().references("orgs"),
  },
  {
    relations: { org: one("orgs", "orgId") },
    indexes: (columns) => {
      const handles = columns as typeof columns & { readonly tenantId: (typeof columns)["title"] };
      return [index(handles.tenantId, handles.title)];
    },
  },
);

const countries = table(
  "countries",
  { id: id({ default: "none" }), name: text() },
  { tenancy: global("shared reference data") },
);

/** Schema under test. */
export const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [orgs, tasks, countries],
});
