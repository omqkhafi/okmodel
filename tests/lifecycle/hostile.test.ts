/**
 * Hostile dimensions the lifecycle grammar draws, without a database.
 */

import { lstatSync } from "node:fs";

import fc from "fast-check";
import { expect, test } from "bun:test";

import { openLifecycleProject } from "../../packages/harness/src/lifecycle-project.js";
import { replicaUrl } from "../../packages/harness/src/topology.js";
import { deterministicName } from "../../src/contracts/catalog/identifier.js";
import { repoRoot } from "../../scripts/root.js";
import { lifecycleCaseArb } from "./grammar.js";
import { clashIndexName, replicaOf } from "./hostile.js";
import type { SchemaModel } from "./model.js";

const root = repoRoot();

test("twenty cases from seed 20261024 cover role, start, place, and namespace", () => {
  const roles = new Set<string>();
  const starts = new Set<string>();
  const places = new Set<string>();
  const namespaces = new Set<string>();
  fc.assert(
    fc.property(lifecycleCaseArb, (item) => {
      roles.add(item.role);
      starts.add(item.start);
      places.add(item.place);
      namespaces.add(item.initial.namespace ?? "public");
      expect(item.tags).toContain(`role-${item.role}`);
      expect(item.tags).toContain(`start-${item.start}`);
      expect(item.tags).toContain(`place-${item.place}`);
      expect(item.tags).toContain(
        item.initial.namespace === undefined ? "namespace-public" : "namespace-other",
      );
      if (item.start === "clash") expect(item.tags).toContain(`clash-${item.clash}`);
    }),
    { numRuns: 20, seed: 20261024 },
  );
  expect([...roles].sort()).toEqual(["creator", "owner", "replica", "superuser"]);
  expect([...starts].sort()).toEqual(["clash", "empty", "foreign", "rows"]);
  expect([...places].sort()).toEqual(["plain", "spaces", "symlink"]);
  expect(namespaces.has("public")).toBe(true);
  expect(namespaces.has("appns")).toBe(true);
});

test("the planted index name matches the compiler", () => {
  const model: SchemaModel = {
    casing: "snake",
    tenancy: false,
    trgm: false,
    tables: [
      {
        key: "tasks",
        name: "Tasks",
        columns: [
          {
            key: "code",
            name: "code",
            type: "text",
            nullable: false,
            primaryKey: false,
            unique: false,
            defaultKind: "none",
          },
        ],
        indexes: [{ columns: ["code"], unique: true, usingTrgm: false }],
        checks: [],
        archive: false,
        versioned: false,
      },
    ],
    triggers: [],
    views: [],
  };
  expect(clashIndexName(model)).toBe(
    deterministicName({ parent: "tasks", purpose: "index", nameKey: "code" }),
  );
  expect(clashIndexName({ ...model, tenancy: true })).toBe(
    deterministicName({ parent: "tasks", purpose: "index", nameKey: "tenant_id_code" }),
  );
});

test("a replica URL keeps the login and the database", () => {
  const got = new URL(replicaOf("postgres://okm_owner:p%40ss@127.0.0.1:55432/db_1"));
  const replica = new URL(replicaUrl("a"));
  expect(got.username).toBe("okm_owner");
  expect(decodeURIComponent(got.password)).toBe("p@ss");
  expect(got.pathname).toBe("/db_1");
  expect(got.port).toBe(replica.port);
});

test("a lifecycle project can live on a symlink or a path with a space", () => {
  const link = openLifecycleProject(root, "place-link", "symlink");
  try {
    expect(lstatSync(link.cwd).isSymbolicLink()).toBe(true);
    link.writeSchema("export const app = 1;\n");
  } finally {
    link.close();
  }
  const spaced = openLifecycleProject(root, "place-space", "spaces");
  try {
    expect(spaced.cwd.includes(" ")).toBe(true);
    spaced.writeSchema("export const app = 1;\n");
  } finally {
    spaced.close();
  }
});
