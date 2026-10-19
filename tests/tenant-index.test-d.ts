/**
 * Tenant index options stay on the table type and the tenancy config (Q3).
 */

import { index, table, t } from "../src/dialects/pg/index.js";
import { columnTenancy, compositeTenancy, rlsTenancy } from "../src/runtime/tenancy/index.js";

columnTenancy({ key: "tenantId", type: "uuid", indexes: true });
columnTenancy({ key: "tenantId", type: "uuid", indexes: false });
compositeTenancy({
  key: ["organizationId", "workspaceId"],
  type: "uuid",
  indexes: false,
});
rlsTenancy({ key: "tenantId", type: "uuid", indexes: true });

table(
  "notes",
  { title: t.text() },
  {
    tenantIndexes: false,
    indexes: (columns) => [
      index(columns.title).global("shared lookup").unique(),
      index(columns.title).scoped(),
    ],
  },
);

// @ts-expect-error indexes is true or false
columnTenancy({ key: "tenantId", type: "uuid", indexes: "no" });

table(
  "notes",
  { title: t.text() },
  {
    // @ts-expect-error tenantIndexes is true or false
    tenantIndexes: "no",
  },
);
