import { db } from "./db.ts";

const acme = await db.tenants.one({ where: { name: "Acme" } });
if (!acme) throw new Error("run the seed first");
const plan = await db
  .for({ tenantId: acme.id })
  .tickets.page({ orderBy: { subject: "asc", id: "asc" }, limit: 2 })
  .sql();
console.log(plan.text);
console.log(JSON.stringify(plan.params));
await db.close();
