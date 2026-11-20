/**
 * PostgreSQL 15 is the floor. A later integer major is accepted.
 * The tested list is not a ceiling.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { EXT_PACKS } from "../src/dialects/pg/ext/versions.js";
import { packVersion } from "../src/dialects/pg/ext/versions.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { describe } from "../src/tooling/migrate/index.js";
import { serverFinding } from "../src/tooling/migrate/doctor-production.js";
import { createClient } from "../src/runtime/client.js";

const notes = table("notes", { id: t.identity(), name: t.text() });
const sessions = table("sessions", { id: t.id({ default: "uuidv7" }), name: t.text() });

test("connect refuses 14 and accepts 15, 19, 20, and 25", async () => {
  const refused = await settled(
    createClient(schema({ tables: [notes] }), fakePool("140000"), { ownsPool: false }),
  );
  expect(refused).toMatchObject({ code: "OKM1803" });

  for (const version of ["150000", "190000", "200000", "250000"]) {
    const client = createClient(schema({ tables: [notes] }), fakePool(version), {
      ownsPool: false,
    });
    await client.connected;
  }
});

test("minPostgres accepts 20 and 25, and 14 stays OKM1060", () => {
  expect(schema({ minPostgres: 20, tables: [notes] }).requires).toEqual({ postgres: ">=20" });
  expect(schema({ minPostgres: 25, tables: [notes] }).requires).toEqual({ postgres: ">=25" });
  expect(schema({ requires: { postgres: ">=20" }, tables: [notes] }).requires).toEqual({
    postgres: ">=20",
  });
  expect(schema({ minPostgres: 25, tables: [sessions] }).requires).toEqual({ postgres: ">=25" });

  const low = capture(() => schema({ minPostgres: 14, tables: [notes] } as never));
  expect(low.code).toBe("OKM1060");
  expect(low.message).toContain("15 or later");
  const fraction = capture(() => schema({ minPostgres: 17.2, tables: [notes] } as never));
  expect(fraction.code).toBe("OKM1060");
  expect(fraction.message).toContain("15 or later");
});

test("describe accepts minPostgres 19, 20, and 25", () => {
  const app = schema({ tables: [notes] });
  expect(describe({ catalog: app.catalog, minPostgres: 19 }).minPostgres).toBe(19);
  expect(describe({ catalog: app.catalog, minPostgres: 20 }).minPostgres).toBe(20);
  expect(describe({ catalog: app.catalog, minPostgres: 25 }).minPostgres).toBe(25);
  expect(() => describe({ catalog: app.catalog, minPostgres: 14 })).toThrow(/15 or later/);
});

test("doctor on 20 and 25 is informational and not a warning", () => {
  for (const major of [20, 25]) {
    const finding = serverFinding(major, undefined);
    expect(finding.severity).toBe("ok");
    expect(finding.summary).toContain("newer than the tested range 15 to 19; accepted");
    expect(finding.summary).toContain(`PostgreSQL ${String(major)}`);
  }
  expect(serverFinding(14, undefined)).toMatchObject({ severity: "fail", code: "OKM1803" });
  expect(serverFinding(19, undefined).severity).toBe("ok");
  expect(serverFinding(19, undefined).summary).not.toContain("newer than the tested range");
});

test("an extension pack above the known majors uses the highest known version", () => {
  const gist = EXT_PACKS.find((pack) => pack.name === "btree_gist");
  if (gist === undefined) throw new Error("btree_gist pack is missing");
  const lines: string[] = [];
  const write = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((part) => String(part)).join(" "));
  };
  try {
    expect(packVersion(gist, 25)).toBe(gist.versions[19]);
    expect(packVersion(gist, 19)).toBe(gist.versions[19]);
  } finally {
    console.error = write;
  }
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("25");
  expect(lines[0]).toContain("btree_gist");
});

function fakePool(versionNum: string): DriverPool {
  return {
    capabilities: { transactions: "none", stream: false, listen: false, cancel: false },
    execute() {
      return Promise.resolve({
        rows: [[versionNum, `PostgreSQL ${versionNum.slice(0, 2)}`, null]],
        count: 1,
        notices: [],
      });
    },
    batch() {
      return Promise.resolve([]);
    },
    stats() {
      return { size: 0, idle: 0, inflight: 0, waiting: 0 };
    },
    close() {
      return Promise.resolve();
    },
  };
}

async function settled(client: { readonly connected: Promise<unknown> }): Promise<unknown> {
  return client.connected.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

function capture(run: () => void): OkmError {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}
