/**
 * Provenance records a source location and stays out of the catalog hash.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { catalog } from "../src/contracts/catalog/build.js";
import { catalogHash, serializeCatalog } from "../src/contracts/catalog/document.js";
import { staticNamespace } from "../src/contracts/catalog/identity.js";
import { table as catalogTable } from "../src/contracts/catalog/object.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";
import { formatFailure } from "../src/tooling/migrate/commands.js";

const location = /provenance\.test\.ts:\d+/;

test("a table records its source and the catalog hash ignores it", () => {
  const users = table("users", { id: t.identity() });
  const built = schema({ tables: [users] });
  const object = built.catalog.objects.find((item) => item.kind === "table");
  expect(object?.provenance).toMatchObject({ origin: "file", name: "users" });
  expect(object?.provenance.source).toMatch(location);
  expect(serializeCatalog(built.catalog)).not.toContain("provenance.test.ts");

  const namespace = staticNamespace("public");
  const hashed = (source: string) =>
    catalogHash(
      catalog([
        catalogTable({
          namespace,
          name: "users",
          provenance: { origin: "file", name: "users", source },
        }),
      ]),
    );
  expect(hashed("a.ts:1")).toBe(hashed("b.ts:9"));
});

test("a duplicate table error names the source okm prints", () => {
  const first = table("users", { id: t.identity() });
  const again = table("users", { id: t.identity() });
  let caught: unknown;
  try {
    schema({ tables: [first, again] });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OkmError);
  if (!(caught instanceof OkmError)) return;
  expect(caught.code).toBe("OKM1023");
  expect(caught.message).toMatch(location);
  expect(formatFailure(caught)).toContain(caught.message);
  expect(formatFailure(caught).startsWith("error OKM1023:")).toBe(true);
});

test("inspect shows the table source on catalog rules", () => {
  const users = table("users", { id: t.identity(), name: t.text() });
  const app = schema({ tables: [users] });
  const db = createClient(app, fakePool(), { ownsPool: false });
  const inspected = db.users.find({ where: { name: "a" }, limit: 1 }).inspect();
  expect(inspected).not.toBeInstanceOf(Promise);
  if (inspected instanceof Promise) return;
  const catalogRules = inspected.rules.filter((rule) => rule.contribution === "catalog");
  expect(catalogRules.length).toBeGreaterThan(0);
  for (const rule of catalogRules) expect(rule.source).toMatch(location);
  expect(inspected.rules.find((rule) => rule.contribution === "planner")?.source).toBeUndefined();
  expect(inspected.rules.find((rule) => rule.rule === "filter")?.provenance).toBe("caller");
});

function fakePool(): DriverPool {
  return {
    capabilities: {
      transactions: "none",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "none",
      describe: false,
    },
    execute() {
      return Promise.resolve({
        rows: [["170000", "PostgreSQL 17", null]],
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
