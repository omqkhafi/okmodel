/**
 * Every planner kind has one class. A kind missing from this list fails.
 *
 * `unclassified` is only `raw-sql`.
 */

import { expect, test } from "bun:test";

import { catalogHash, parseCatalog, serializeCatalog } from "../src/contracts/catalog/document.js";
import { catalog } from "../src/contracts/catalog/build.js";
import { roleObject } from "../src/contracts/catalog/privilege.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import {
  STEP_CLASS,
  STEP_KINDS,
  type MigrationClass,
  type StepKind,
} from "../src/tooling/migrate/classify.js";
import { formatPlan, parsePlan, planMigration } from "../src/tooling/migrate/plan.js";

const EXPECTED = [
  ["create-table", "expand"],
  ["drop-table", "contract"],
  ["add-column", "expand"],
  ["add-column-required", "contract"],
  ["drop-column", "contract"],
  ["set-column-type", "contract"],
  ["set-not-null", "contract"],
  ["drop-not-null", "expand"],
  ["set-default", "expand"],
  ["drop-default", "contract"],
  ["add-identity", "expand"],
  ["drop-identity", "contract"],
  ["set-identity-always", "contract"],
  ["set-identity-by-default", "expand"],
  ["add-constraint", "expand"],
  ["validate-constraint", "expand"],
  ["drop-constraint", "contract"],
  ["drop-not-null-check", "expand"],
  ["rename-constraint", "contract"],
  ["widen-check", "expand"],
  ["narrow-check", "contract"],
  ["create-index", "expand"],
  ["drop-index", "contract"],
  ["rename-index", "contract"],
  ["create-sequence", "expand"],
  ["drop-sequence", "contract"],
  ["create-enum", "expand"],
  ["recreate-enum", "contract"],
  ["add-enum-value", "expand"],
  ["rename-enum", "contract"],
  ["drop-enum", "contract"],
  ["set-enum-column", "contract"],
  ["create-domain", "expand"],
  ["drop-domain", "contract"],
  ["add-domain-check", "expand"],
  ["validate-domain-check", "expand"],
  ["drop-domain-check", "contract"],
  ["rename-domain-check", "expand"],
  ["create-extension", "expand"],
  ["drop-extension", "contract"],
  ["update-extension", "expand"],
  ["move-extension", "contract"],
  ["create-function", "expand"],
  ["drop-function", "contract"],
  ["replace-function", "expand"],
  ["create-trigger", "expand"],
  ["drop-trigger", "contract"],
  ["create-view", "expand"],
  ["drop-view", "contract"],
  ["replace-view", "expand"],
  ["create-matview", "expand"],
  ["drop-matview", "contract"],
  ["refresh-matview", "expand"],
  ["create-role", "expand"],
  ["alter-role", "contract"],
  ["grant", "expand"],
  ["revoke", "contract"],
  ["grant-default", "expand"],
  ["revoke-default", "contract"],
  ["rename-table", "contract"],
  ["rename-column", "contract"],
  ["backfill-expand", "expand"],
  ["backfill-contract", "contract"],
  ["raw-sql", "unclassified"],
] as const satisfies readonly (readonly [StepKind, MigrationClass])[];

test("every step kind has one class and raw SQL is the only unclassified kind", () => {
  expect(EXPECTED.map((row) => row[0])).toEqual([...STEP_KINDS]);
  for (const [kind, classification] of EXPECTED) {
    expect(STEP_CLASS[kind]).toBe(classification);
  }
  expect(STEP_KINDS.filter((kind) => STEP_CLASS[kind] === "unclassified")).toEqual(["raw-sql"]);
});

test("okm migrate plan prints each step's class and lock", () => {
  const plan = planMigration({
    before: catalog([]),
    after: schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] }).catalog,
    name: "create",
  });
  const text = formatPlan(plan);
  expect(text.startsWith("-- class: expand\n")).toBe(true);
  expect(plan.steps.length).toBeGreaterThan(0);
  for (const step of plan.steps) {
    expect(step.kind).toBeDefined();
    if (step.kind !== undefined) expect(step.class).toBe(STEP_CLASS[step.kind]);
    expect(text).toContain(`-- class: ${step.class}`);
    expect(text).toContain(`-- kind: ${step.kind ?? ""}`);
    expect(text).toContain(`-- lock: ${step.lock}`);
  }
  const parsed = parsePlan(text);
  expect(parsed.steps.map((step) => step.kind)).toEqual(plan.steps.map((step) => step.kind));
  expect(parsed.steps.map((step) => step.class)).toEqual(plan.steps.map((step) => step.class));
  expect(parsed.steps.map((step) => step.lock)).toEqual(plan.steps.map((step) => step.lock));
});

test("a statement with no class comment is raw SQL", () => {
  const parsed = parsePlan("-- class: expand\n-- name: hand\n\nselect 1;\n");
  expect(parsed.steps[0]?.kind).toBe("raw-sql");
  expect(parsed.steps[0]?.class).toBe("unclassified");
  expect(parsed.class).toBe("unclassified");
});

test("a required column, a dropped default, and a dropped identity are contract", () => {
  const base = schema({
    tables: [table("tasks", { id: t.identity(), note: t.text().default("x") })],
  });
  const required = schema({
    tables: [table("tasks", { id: t.identity(), note: t.text().default("x"), extra: t.text() })],
  });
  const added = planMigration({
    before: base.catalog,
    after: required.catalog,
    name: "required",
  });
  const column = added.steps.find((step) => step.sql.includes("add column"));
  expect(column?.kind).toBe("add-column-required");
  expect(column?.class).toBe("contract");
  expect(column?.sql).toContain("add column");

  const droppedDefault = schema({
    tables: [table("tasks", { id: t.identity(), note: t.text() })],
  });
  const withoutDefault = planMigration({
    before: base.catalog,
    after: droppedDefault.catalog,
    name: "drop-default",
  });
  const dropDefault = withoutDefault.steps.find((step) => step.sql.includes("drop default"));
  expect(dropDefault?.kind).toBe("drop-default");
  expect(dropDefault?.class).toBe("contract");

  const plain = schema({
    tables: [table("tasks", { id: t.bigint(), note: t.text().default("x") })],
  });
  const dropIdentity = planMigration({
    before: base.catalog,
    after: plain.catalog,
    name: "drop-identity",
  });
  const identity = dropIdentity.steps.find((step) => step.sql.includes("drop identity"));
  expect(identity?.kind).toBe("drop-identity");
  expect(identity?.class).toBe("contract");
  expect(dropIdentity.steps.map((step) => step.sql).join("\n")).not.toContain("drop sequence");
});

test("setting identity to always is contract and by default is expand", () => {
  const source = schema({ tables: [table("tasks", { id: t.identity() })] });
  const text = serializeCatalog(source.catalog);
  expect(text).toContain('"always":true');
  const byDefault = parseCatalog(text.replace('"always":true', '"always":false'));
  const loosened = planMigration({
    before: source.catalog,
    after: byDefault,
    name: "by-default",
  });
  expect(loosened.steps.map((step) => step.sql).join("\n")).toContain("set generated by default");
  expect(loosened.steps[0]?.kind).toBe("set-identity-by-default");
  expect(loosened.steps[0]?.class).toBe("expand");

  const tightened = planMigration({
    before: byDefault,
    after: source.catalog,
    name: "always",
  });
  expect(tightened.steps[0]?.kind).toBe("set-identity-always");
  expect(tightened.steps[0]?.class).toBe("contract");
  expect(catalogHash(source.catalog)).not.toBe(catalogHash(byDefault));
});

test("altering a managed role is contract and creating one is expand", () => {
  const provenance = { origin: "file" as const, name: "roles" };
  const before = catalog([
    roleObject({ name: "mig", login: false, inherit: true, owner: "managed", provenance }),
  ]);
  const after = catalog([
    roleObject({ name: "mig", login: true, inherit: true, owner: "managed", provenance }),
  ]);
  const changed = planMigration({ before, after, name: "login" });
  expect(changed.steps.map((step) => step.sql)).toEqual(['alter role "mig" with inherit login']);
  expect(changed.steps[0]?.kind).toBe("alter-role");
  expect(changed.steps[0]?.class).toBe("contract");

  const tasks = table("tasks", { id: t.text().primaryKey() });
  const created = planMigration({
    before: catalog([]),
    after: attachRoles(schema({ tables: [tasks] }).catalog, {
      migration: "mig",
      app: "app",
      managed: [{ name: "mig" }],
    }),
    name: "roles",
  });
  const role = created.steps.find((step) => step.sql.startsWith("create role"));
  expect(role?.kind).toBe("create-role");
  expect(role?.class).toBe("expand");
});

test("a nullable column on an existing table stays expand", () => {
  const before = schema({ tables: [table("tasks", { id: t.identity() })] });
  const after = schema({
    tables: [table("tasks", { id: t.identity(), note: t.text().nullable() })],
  });
  const plan = planMigration({ before: before.catalog, after: after.catalog, name: "add" });
  const column = plan.steps.find((step) => step.sql.includes("add column"));
  expect(column?.kind).toBe("add-column");
  expect(column?.class).toBe("expand");
  expect(plan.class).toBe("expand");
});
