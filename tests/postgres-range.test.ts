/**
 * PostgreSQL 15 is the floor. A later integer major is accepted.
 * The tested list is not a ceiling.
 */

import { expect, test } from "bun:test";

import { POSTGRES_VERSIONS } from "../packages/harness/src/version.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { EXT_PACKS } from "../src/dialects/pg/ext/versions.js";
import { packVersion } from "../src/dialects/pg/ext/versions.js";
import { POSTGRES_FLOOR } from "../src/dialects/pg/floor.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { describe } from "../src/tooling/migrate/index.js";
import { serverFinding } from "../src/tooling/migrate/doctor-production.js";
import { createClient } from "../src/runtime/client.js";

const notes = table("notes", { id: t.identity(), name: t.text() });
const sessions = table("sessions", { id: t.id({ default: "uuidv7" }), name: t.text() });
const newest = Number(POSTGRES_VERSIONS[POSTGRES_VERSIONS.length - 1]);
if (!Number.isInteger(newest)) throw new Error("tested majors are empty");

/**
 * Server version integer Postgres reports, `major * 10000`.
 *
 * @param major - Major to report
 * @returns The `server_version_num` text
 */
function serverVersion(major: number): string {
  return `${String(major)}0000`;
}

test("connect refuses a major below the floor and accepts the floor and later majors", async () => {
  const refused = await settled(
    createClient(schema({ tables: [notes] }), fakePool(serverVersion(POSTGRES_FLOOR - 1)), {
      ownsPool: false,
    }),
  );
  expect(refused).toMatchObject({ code: "OKM1803" });

  for (const major of [POSTGRES_FLOOR, newest, newest + 1, newest + 6]) {
    const client = createClient(schema({ tables: [notes] }), fakePool(serverVersion(major)), {
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

  const low = capture(() => schema({ minPostgres: POSTGRES_FLOOR - 1, tables: [notes] } as never));
  expect(low.code).toBe("OKM1060");
  expect(low.message).toContain(`${String(POSTGRES_FLOOR)} or later`);
  const fraction = capture(() => schema({ minPostgres: 17.2, tables: [notes] } as never));
  expect(fraction.code).toBe("OKM1060");
  expect(fraction.message).toContain(`${String(POSTGRES_FLOOR)} or later`);
});

test("describe accepts the newest tested major and later majors", () => {
  const app = schema({ tables: [notes] });
  expect(describe({ catalog: app.catalog, minPostgres: newest }).minPostgres).toBe(newest);
  expect(describe({ catalog: app.catalog, minPostgres: newest + 1 }).minPostgres).toBe(newest + 1);
  expect(describe({ catalog: app.catalog, minPostgres: newest + 6 }).minPostgres).toBe(newest + 6);
  expect(() => describe({ catalog: app.catalog, minPostgres: POSTGRES_FLOOR - 1 })).toThrow(
    new RegExp(`${String(POSTGRES_FLOOR)} or later`),
  );
});

test("doctor on a major past the tested list is informational and not a warning", () => {
  for (const major of [newest + 1, newest + 6]) {
    const finding = serverFinding(major, undefined);
    expect(finding.severity).toBe("ok");
    expect(finding.summary).toContain(
      `newer than the tested range ${String(POSTGRES_FLOOR)} to ${String(newest)}; accepted`,
    );
    expect(finding.summary).toContain(`PostgreSQL ${String(major)}`);
  }
  expect(serverFinding(POSTGRES_FLOOR - 1, undefined)).toMatchObject({
    severity: "fail",
    code: "OKM1803",
  });
  expect(serverFinding(newest, undefined).severity).toBe("ok");
  expect(serverFinding(newest, undefined).summary).not.toContain("newer than the tested range");
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
