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

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
      { value: TENANT },
    ),
  );
  expect(error.code).toBe("OKM1120");
  expect(accepted(error.message)).toBe("subject");
  expect(accepted(error.message)).not.toContain("tenantId");
  expect(accepted(error.message)).not.toContain("id");
  expect(accepted(error.message)).not.toContain("rank");
});

const countries = table("countries", {
  code: text().primaryKey(),
  name: text(),
});
const atlas = schema({ tables: [countries] });

test("insert lists a primary key the caller sets, update leaves it out", async () => {
  const insert = await refused(() =>
    explainWrite(atlas, "insert", "countries", { code: "NO", nmae: "Norway" }, {}, {}),
  );
  expect(insert.code).toBe("OKM1120");
  expect(accepted(insert.message)).toBe("code, name");
  const update = await refused(() =>
    explainWrite(
      atlas,
      "update",
      "countries",
      { where: { code: "NO" }, set: { nmae: "N" } },
      {},
      {},
    ),
  );
  expect(update.code).toBe("OKM1120");
  expect(accepted(update.message)).toBe("name");
});

test("a guarded field named in allow is an accepted name", async () => {
  const error = await refused(() =>
    explainWrite(
      tenant,
      "insert",
      "tenant_tickets",
      { subject: "hi", nope: 1 },
      { allow: ["rank"] },
      {},
      undefined,
      { value: TENANT },
    ),
  );
  expect(error.code).toBe("OKM1120");
  expect(accepted(error.message)).toBe("rank, subject");
});

test("a table whose columns are all guarded still lists (none)", async () => {
  const error = await refused(() =>
    explainWrite(allGuarded, "insert", "sealed_rows", { nope: 1 }, {}, {}),
  );
  expect(error.code).toBe("OKM1120");
  expect(accepted(error.message)).toBe("(none)");
});
