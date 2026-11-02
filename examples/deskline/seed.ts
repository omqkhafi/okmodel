import type { Testing } from "okmodel/testing";
import { hashKey } from "./src/hash.ts";

// Demo keys, for local use only. Real keys are random and shown once.
const companies = [
  { name: "Acme", key: "dl_acme_demo", subjects: ["Printer jam", "VPN drops", "Reset 2FA"] },
  { name: "Globex", key: "dl_globex_demo", subjects: ["Invoice wrong"] },
];

export default async function seed(t: Testing): Promise<void> {
  const f = t.factories({
    tenants: () => ({}),
    api_keys: () => ({}),
    tickets: () => ({}),
  });
  for (const company of companies) {
    const tenant = await f.tenants.create({ name: company.name });
    await f.api_keys.create({ keyHash: hashKey(company.key), tenantId: tenant.id });
    for (const subject of company.subjects) {
      await f.tickets.create({ tenantId: tenant.id, subject });
    }
  }
}
