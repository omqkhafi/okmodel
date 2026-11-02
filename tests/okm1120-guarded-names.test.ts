/**
 * OKM1120 accepted names omit columns a write would refuse with OKM1190.
 *
 * Identity defaults, generated/guarded fields, and the tenant key stay out of
 * the list so it only names fields the caller may set.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { explainWrite } from "../src/runtime/write.js";

const tickets = table("tickets", {
  id: id(),
  subject: text(),
});
const desk = schema({ tables: [tickets] });

const tenantTickets = table("tenant_tickets", {
  id: id(),
  subject: text(),
  rank: text().guarded(),
});
const tenant = schema({
  tables: [tenantTickets],
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
});

const sealed = table("sealed_rows", {
  id: id(),
  secret: text().guarded(),
});
const allGuarded = schema({ tables: [sealed] });

async function refused(run: () => Promise<unknown>): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function accepted(message: string): string {
  const from = message.indexOf("Accepted names: ");
  expect(from).toBeGreaterThan(-1);
  return message.slice(from + "Accepted names: ".length).split(".")[0] ?? "";
}

test("Deskline-shaped insert omits the identity id from accepted names", async () => {
  const error = await refused(() =>
    explainWrite(desk, "insert", "tickets", { subject: "hi", priority: 1 }, {}, {}),
  );
  expect(error.code).toBe("OKM1120");
  expect(accepted(error.message)).toBe("subject");
  expect(error.message).not.toContain("Accepted names: id");
});

test("tenant write omits tenant key, identity, and guarded columns", async () => {
  const error = await refused(() =>
    explainWrite(
      tenant,
      "insert",
      "tenant_tickets",
      { subject: "hi", priority: 1 },
      {},
      {},
      undefined,
      { tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ),
  );
  expect(error.code).toBe("OKM1120");
  expect(accepted(error.message)).toBe("subject");
  expect(accepted(error.message)).not.toContain("tenantId");
  expect(accepted(error.message)).not.toContain("id");
  expect(accepted(error.message)).not.toContain("rank");
});

test("a table whose columns are all guarded still lists (none)", async () => {
  const error = await refused(() =>
    explainWrite(allGuarded, "insert", "sealed_rows", { nope: 1 }, {}, {}),
  );
  expect(error.code).toBe("OKM1120");
  expect(accepted(error.message)).toBe("(none)");
});
