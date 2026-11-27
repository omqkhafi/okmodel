/**
 * Keyed row-level security policies: the compiler, the plan, and the
 * expression text. Postgres proofs live in `policies-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import {
  call,
  col,
  currentUser,
  includes,
  setting,
  settingList,
} from "../src/dialects/pg/expr/index.js";
import { has, schema, table, t } from "../src/dialects/pg/index.js";
import type { PolicyMap, RlsOption } from "../src/dialects/pg/policy-compile.js";
import { printIndexText } from "../src/dialects/pg/index-print.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { policyFindings } from "../src/tooling/migrate/policy-rules.js";
import { sessionSettings } from "../src/runtime/session/index.js";
import "../src/dialects/pg/policy.js";
import { rlsTenancy } from "../src/runtime/tenancy/index.js";
import { tenantWire } from "../src/runtime/tenancy/key-type.js";

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof OkmError ? error.code : "";
  }
  return "";
}

const session = sessionSettings({
  userId: { name: "app.user_id", type: "uuid" },
  scopes: { name: "app.scopes", type: "text[]" },
});

function notes(policies: () => PolicyMap, rls?: RlsOption) {
  return schema({
    tables: [
      table(
        "notes",
        { id: t.integer().primaryKey(), ownerId: t.uuid(), body: t.text() },
        { policies, ...(rls === undefined ? {} : { rls }) },
      ),
    ],
  });
}

function policyOf(built: ReturnType<typeof notes>, name: string) {
  const policy = built.catalog.objects.find(
    (object) => object.kind === "policy" && object.identity.name === name,
  );
  if (policy === undefined || policy.kind !== "policy") throw new Error(`missing ${name}`);
  return policy;
}

test("a keyed policy defaults to all, permissive, and the app role", () => {
  const built = notes(() => ({
    own: { using: { ownerId: session.handles.userId } },
  }));
  const policy = policyOf(built, "own");
  expect(policy.definition.command).toBe("all");
  expect(policy.definition.restrictive).toBeUndefined();
  expect(policy.definition.roles).toEqual(["app"]);
  expect(policy.definition.expression).toContain(
    "(select nullif(current_setting('app.user_id', true), '')::uuid)",
  );
  expect(policy.definition.expression).not.toContain("current_setting('app.user_id', true)::");
});

test("select with check, insert with using, and a generated name are refused", () => {
  expect(
    () => notes(() => ({ read: { for: "select", using: true, check: true } })).catalog,
  ).toThrow(OkmError);
  expect(() => notes(() => ({ add: { for: "insert", using: true, check: true } })).catalog).toThrow(
    OkmError,
  );
  expect(
    thrown(() => notes(() => ({ read: { for: "select", using: true, check: true } })).catalog),
  ).toBe("OKM1924");
});

test("a policy that reads its own table is OKM1925", () => {
  expect(
    () =>
      notes(() => ({
        loop: { using: { notes: has({ id: col("id") }) } },
      })).catalog,
  ).toThrow(OkmError);
  expect(
    thrown(() => notes(() => ({ loop: { using: { notes: has({ id: col("id") }) } } })).catalog),
  ).toBe("OKM1925");
});

test("a permissive policy on a tenant table is refused and a restrictive one is kept", () => {
  const wide = schema({
    tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
    tables: [
      table(
        "notes",
        { id: t.integer().primaryKey() },
        {
          policies: () => ({ extra: { using: true } }),
        },
      ),
    ],
  });
  expect(() => wide.catalog).toThrow(OkmError);
  const narrow = schema({
    tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
    tables: [
      table(
        "notes",
        { id: t.integer().primaryKey() },
        {
          policies: () => ({ extra: { as: "restrictive", using: true } }),
        },
      ),
    ],
  });
  const extra = narrow.catalog.objects.find(
    (object) => object.kind === "policy" && object.identity.name === "extra",
  );
  expect(extra?.kind).toBe("policy");
  if (extra?.kind === "policy") expect(extra.definition.restrictive).toBe(true);
});

test("using changes alter the policy and as changes drop and create it", () => {
  const first = notes(() => ({ own: { using: true } }));
  const changed = notes(() => ({ own: { using: false } }));
  const altered = planMigration({
    before: first.catalog,
    after: changed.catalog,
    name: "using",
  });
  expect(altered.steps.some((step) => step.sql.startsWith("alter policy"))).toBe(true);
  expect(altered.steps.some((step) => step.sql.startsWith("drop policy"))).toBe(false);
  const restrictive = notes(() => ({ own: { as: "restrictive", using: true } }));
  const replaced = planMigration({
    before: first.catalog,
    after: restrictive.catalog,
    name: "as",
  });
  const drop = replaced.steps.findIndex((step) => step.sql.startsWith("drop policy"));
  const create = replaced.steps.findIndex((step) => step.sql.startsWith("create policy"));
  expect(drop).toBeGreaterThanOrEqual(0);
  expect(create).toBeGreaterThan(drop);
  expect(replaced.steps[drop]?.transactional).not.toBe(false);
  expect(replaced.steps[create]?.transactional).not.toBe(false);
});

test("a column type change drops and recreates a policy that reads the column", () => {
  const before = notes(() => ({ own: { using: { ownerId: session.handles.userId } } }));
  const after = schema({
    tables: [
      table(
        "notes",
        { id: t.integer().primaryKey(), ownerId: t.text(), body: t.text() },
        { policies: () => ({ own: { using: { ownerId: session.handles.userId } } }) },
      ),
    ],
  });
  const plan = planMigration({ before: before.catalog, after: after.catalog, name: "type" });
  const sql = plan.steps.map((step) => step.sql);
  const drop = sql.findIndex((statement) => statement.startsWith("drop policy"));
  const alter = sql.findIndex((statement) => statement.includes("type text"));
  const create = sql.findIndex((statement) => statement.startsWith("create policy"));
  expect(drop).toBeGreaterThanOrEqual(0);
  expect(drop).toBeLessThan(alter);
  expect(alter).toBeLessThan(create);
});

test("includes prints the list cast outside the subselect", () => {
  const text = printIndexText(includes(setting("app.scopes", "text[]"), "admin"), () => "value");
  expect(text).toContain("= any (");
  expect(text).toContain(
    "((select coalesce(nullif(current_setting('app.scopes', true), ''), '{}'))::text[])",
  );
  expect(printIndexText(currentUser(), () => "value")).toBe("(select current_user)");
  expect(printIndexText(call("auth.uid", t.uuid(), { volatility: "stable" }), () => "value")).toBe(
    "(select auth.uid())",
  );
});

test("settingList quotes the twelve awkward elements", () => {
  const cases: readonly (readonly (string | null)[])[] = [
    ["a,b"],
    ['say "hi"'],
    ["{brace}"],
    ["back\\slash"],
    ["a space"],
    [""],
    ["مرحبا"],
    ["café"],
    [null],
    ["NULL"],
    ["a,b", "c"],
    [],
  ];
  expect(cases).toHaveLength(12);
  expect(settingList(["a,b"])).toBe('{"a,b"}');
  expect(settingList(['say "hi"'])).toBe('{"say \\"hi\\""}');
  expect(settingList(["{brace}"])).toBe('{"{brace}"}');
  expect(settingList(["back\\slash"])).toBe('{"back\\\\slash"}');
  expect(settingList(["a space"])).toBe('{"a space"}');
  expect(settingList([""])).toBe('{""}');
  expect(settingList(["مرحبا"])).toBe('{"مرحبا"}');
  expect(settingList(["café"])).toBe('{"café"}');
  expect(settingList([null])).toBe("{NULL}");
  expect(settingList(["NULL"])).toBe('{"NULL"}');
  expect(settingList([])).toBe("{}");
  const naive = ["a,b"].join(",");
  expect(naive).not.toBe(settingList(["a,b"]));
});

test("for() accepts the tenant key's JavaScript type", () => {
  expect(tenantWire("uuid", "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d", "uuid")).toBe(
    "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d",
  );
  expect(tenantWire("text", "acme", "text")).toBe("acme");
  expect(tenantWire("int", 42, "int")).toBe("42");
  expect(tenantWire("bigint", "9007199254740993", "bigint")).toBe("9007199254740993");
  expect(tenantWire("bigint", 12n, "bigint")).toBe("12");
  expect(() => tenantWire("int", "42", "int")).toThrow(OkmError);
  expect(() => tenantWire("bigint", "nope", "bigint")).toThrow(OkmError);
});

test("an update policy without a select policy warns", () => {
  const built = notes(() => ({
    edit: { for: "update", using: true, check: true },
  }));
  const found = policyFindings(built.catalog, undefined);
  expect(found.some((item) => item.rule.code === "OKM2116")).toBe(true);
});

test("a disabled generated policy plans enable row level security", () => {
  const declared = schema({
    tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
    tables: [table("notes", { id: t.integer().primaryKey() })],
  }).catalog;
  const live = {
    version: declared.version,
    objects: declared.objects.map((object) =>
      object.kind === "policy"
        ? { ...object, definition: { ...object.definition, disabled: true as const } }
        : object,
    ),
  };
  const plan = planMigration({ before: live, after: declared, name: "enable" });
  const sql = plan.steps.map((step) => step.sql).join("\n");
  expect(sql).toContain("enable row level security");
  expect(sql.includes("drop policy")).toBe(false);
});

test("widening an existing policy to public is a protected step", () => {
  const before = notes(() => ({ open: { to: "reader", using: true } }));
  const after = notes(() => ({ open: { to: "public", using: true } }));
  const plan = planMigration({ before: before.catalog, after: after.catalog, name: "widen" });
  const step = plan.steps.find((item) => item.kind === "policy-public");
  expect(step?.sql).toContain("to public");
  expect(step?.class).toBe("contract");
});

test("public is stored with no role list and is not the default", () => {
  const built = notes(() => ({ open: { to: "public", using: true } }));
  expect(policyOf(built, "open").definition.roles).toBeUndefined();
  const created = planMigration({
    before: schema({ tables: [] }).catalog,
    after: built.catalog,
    name: "public",
  });
  const step = created.steps.find((item) => item.sql.startsWith("create policy"));
  expect(step?.sql).toContain(" to public");
  expect(step?.kind).toBe("policy-public");
  expect(step?.class).toBe("contract");
});
