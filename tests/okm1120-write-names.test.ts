/**
 * OKM1120 accepted names on a write omit the tenant key.
 *
 * Reads keep it. Hint candidates still include it. `toHttp().body.fields` stays empty.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { id, one, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy, compositeTenancy, via } from "../src/runtime/tenancy/index.js";
import "../src/runtime/validate/index.js";

const NOTE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c41";
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const notes = table("notes", {
  id: id({ default: "none" }),
  title: text(),
});
const checked = table(
  "checked",
  {
    id: id({ default: "none" }),
    title: text(),
  },
  { validation: true },
);
const orgs = table("orgs", { id: id({ default: "none" }), name: text() });
const projects = table(
  "projects",
  {
    id: id({ default: "none" }),
    name: text(),
    organizationId: uuid().references("orgs"),
  },
  {
    tenancy: via("organization"),
    relations: { organization: one("orgs", "organizationId") },
  },
);

const column = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [notes, orgs, projects],
});
const validating = schema({
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [checked],
  validation: true,
});
const composite = schema({
  tenancy: compositeTenancy({ key: ["orgId", "teamId"], type: "uuid" }),
  tables: [notes],
});

const pool = {
  capabilities: {
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
  },
  execute: () => Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

async function refused(run: () => unknown): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    return error as OkmError;
  }
  throw new Error("expected a refusal");
}

function accepted(message: string): string {
  const from = message.indexOf("Accepted names: ");
  expect(from).toBeGreaterThan(-1);
  return message.slice(from + "Accepted names: ".length).split(".")[0] ?? "";
}

test("write OKM1120 omits the tenant key and a read keeps it", async () => {
  const db = connect(pool, { schema: column });
  await db.connected;
  const scoped = db.for({ tenantId: TENANT });

  const insert = await refused(() =>
    scoped.notes.insert({ id: NOTE, title: "a", tenatId: "x" } as never).sql(),
  );
  expect(insert.code).toBe("OKM1120");
  expect(accepted(insert.message)).not.toContain("tenantId");
  expect(insert.message).toContain("Did you mean `tenantId`");
  expect(insert.toHttp().body.fields).toEqual({});

  const update = await refused(() =>
    scoped.notes.update({ where: { id: NOTE }, set: { nope: 1 } as never }).sql(),
  );
  expect(accepted(update.message)).not.toContain("tenantId");

  const upsert = await refused(() =>
    scoped.notes
      .insert({ id: NOTE, title: "c" }, { onConflict: { on: "id", update: ["titl"] } } as never)
      .sql(),
  );
  expect(accepted(upsert.message)).not.toContain("tenantId");
  expect(upsert.message).toContain("Did you mean `title`");

  const first = await refused(() =>
    scoped.notes
      .insert({ id: NOTE, title: "d", extra: true } as never, {
        onConflict: { on: "id", return: true },
      })
      .sql(),
  );
  expect(accepted(first.message)).not.toContain("tenantId");

  const validatedDb = connect(pool, { schema: validating }).for({ tenantId: TENANT });
  const validated = await refused(() =>
    validatedDb.checked.insert.validate({ id: NOTE, title: "a", nope: 1 } as never),
  );
  expect(accepted(validated.message)).not.toContain("tenantId");
  expect(validated.message).toContain("checked");

  const read = await refused(() =>
    scoped.notes.find({ where: { nope: 1 }, limit: 1 } as never).sql(),
  );
  expect(read.code).toBe("OKM1120");
  expect(accepted(read.message)).toContain("tenantId");

  const viaWrite = await refused(() =>
    scoped.projects.insert({ id: NOTE, name: "p", nope: 1 } as never).sql(),
  );
  expect(accepted(viaWrite.message)).toContain("organizationId");
  expect(accepted(viaWrite.message)).not.toContain("tenantId");

  const both = connect(pool, { schema: composite }).for({ orgId: TENANT, teamId: OTHER });
  const compositeInsert = await refused(() =>
    both.notes.insert({ id: NOTE, title: "a", nope: 1 } as never).sql(),
  );
  const listed = accepted(compositeInsert.message);
  expect(listed).not.toContain("orgId");
  expect(listed).not.toContain("teamId");
});
