import { schema, table, t } from "okmodel/pg";
import { columnTenancy, global } from "okmodel/tenancy";

// The companies that use Deskline. Shared, so no tenant key.
const tenants = table(
  "tenants",
  { id: t.id(), name: t.text().unique() },
  { tenancy: global("tenant directory") },
);

// One row per API key. Only the sha256 hash is stored.
const apiKeys = table(
  "api_keys",
  { id: t.id(), keyHash: t.text().unique(), tenantId: t.uuid().references("tenants") },
  { tenancy: global("keys are looked up before the tenant is known") },
);

// Each company's tickets. columnTenancy adds tenantId.
const tickets = table("tickets", {
  id: t.id(),
  subject: t.text().unique(),
});

export const app = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [tenants, apiKeys, tickets],
});
