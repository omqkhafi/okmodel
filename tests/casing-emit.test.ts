/**
 * Every emitter that spells a name, under each casing.
 *
 * The fixture builds one schema per casing. Each case reads the catalog the
 * compiler wrote, so a name that bypasses the resolver shows up as the wrong
 * spelling here. Postgres round trips are in `casing-pg.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import type { CatalogObject } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { fn } from "../src/dialects/pg/fn/index.js";
import { id, schema, table, t } from "../src/dialects/pg/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { timestamps } from "../src/runtime/traits/index.js";
import { columnFixture, rlsFixture, spell } from "./casing-fixture.js";

type Built = ReturnType<typeof columnFixture>;

function listed(app: { readonly catalog: { readonly objects: readonly CatalogObject[] } }) {
  return app.catalog.objects;
}

function names(app: Built, kind: CatalogObject["kind"], parent?: string): string[] {
  return listed(app)
    .filter((object) => object.kind === kind)
    .filter((object) => {
      if (parent === undefined) return true;
      const identity = object.identity as { readonly parent?: { readonly name: string } };
      return identity.parent?.name === parent;
    })
    .map((object) => (object.identity as { readonly name: string }).name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const PAIRS = [
  ["snake", "user_accounts", "org_unit_id", "tenant_id", "email_url", "line2_text"],
  ["camel", "userAccounts", "orgUnitId", "tenantId", "emailUrl", "line2Text"],
] as const;

describe.each(PAIRS)("%s", (casing, accounts, orgUnit, tenant, email, line2) => {
  const app = columnFixture(casing);

  test("tables and columns", () => {
    expect(names(app, "table")).toEqual(
      [
        spell(casing, "accountNotes"),
        spell(casing, "auditEntries"),
        spell(casing, "boardCards"),
        spell(casing, "orgUnits"),
        spell(casing, "statusCodes"),
        spell(casing, "taskItems"),
        spell(casing, "userAccounts"),
      ].sort(),
    );
    expect(names(app, "column", accounts)).toEqual(
      [
        "id",
        orgUnit,
        email,
        line2,
        "status",
        "score",
        tenant,
        spell(casing, "archivedAt"),
        spell(casing, "archiveId"),
      ].sort(),
    );
  });

  test("the model keeps the field and records the SQL name", () => {
    const model = app.model.userAccounts;
    expect(model?.sql).toBe(accounts);
    const columns = Object.fromEntries((model?.columns ?? []).map((c) => [c.field, c.sql]));
    expect(columns.emailURL).toBe(email);
    expect(columns.orgUnitID).toBe(orgUnit);
    expect(columns.tenantID).toBe(tenant);
    expect(columns.line2Text).toBe(line2);
  });

  test("constraints", () => {
    expect(names(app, "constraint", accounts)).toEqual(
      [
        `${accounts}_pkey`,
        `${accounts}_${orgUnit}_${tenant}_fkey`,
        `${accounts}_score_positive_check`,
      ].sort(),
    );
    expect(names(app, "constraint", spell(casing, "taskItems"))).toEqual(
      [
        `${spell(casing, "taskItems")}_pkey`,
        `${spell(casing, "taskItems")}_${spell(casing, "unitID")}_fkey`,
      ].sort(),
    );
    expect(names(app, "constraint", spell(casing, "orgUnits"))).toEqual(
      [
        `${spell(casing, "orgUnits")}_pkey`,
        `${spell(casing, "orgUnits")}_id_key`,
        `${spell(casing, "orgUnits")}_id_${tenant}_key`,
      ].sort(),
    );
  });

  test("indexes, including the archive partials", () => {
    expect(names(app, "index", accounts)).toEqual(
      [
        `${accounts}_id_${tenant}_idx`,
        `${accounts}_${tenant}_${email}_idx`,
        `${accounts}_${tenant}_${line2}_idx`,
        `${accounts}_${tenant}_${orgUnit}_${email}_idx`,
      ].sort(),
    );
    const partial = listed(app).find(
      (object) =>
        object.kind === "index" && object.identity.name === `${accounts}_${tenant}_${email}_idx`,
    );
    const predicate = partial?.kind === "index" ? partial.definition.predicate : undefined;
    expect(predicate).toBe(
      `(${spell(casing, "archivedAt") === "archived_at" ? "archived_at" : '"archivedAt"'} IS NULL)`,
    );
    const cards = spell(casing, "boardCards");
    expect(names(app, "index", cards)).toEqual([
      `${cards}_${tenant}_${spell(casing, "laneID")}_position_idx`,
    ]);
  });

  test("identity sequence", () => {
    const entries = spell(casing, "auditEntries");
    const entry = spell(casing, "entryID");
    expect(names(app, "sequence")).toEqual([`${entries}_${entry}_seq`]);
  });

  test("timestamps trigger and its function are spelled from the column", () => {
    const units = spell(casing, "orgUnits");
    expect(names(app, "function")).toEqual(
      [`okm_touch_${spell(casing, "updatedAt")}`, "stamp_unit"].sort(),
    );
    expect(names(app, "trigger", units)).toEqual([`${units}_touch`, "org_units_stamp"].sort());
  });

  test("enum and domain types keep the name written, and the column is cased", () => {
    expect(names(app, "type")).toEqual(["account_status", "positive_score"]);
    const column = listed(app).find(
      (object) =>
        object.kind === "column" &&
        object.identity.parent.name === accounts &&
        object.identity.name === "status",
    );
    expect(column?.kind === "column" ? column.definition.dataType : "").toBe("account_status");
  });

  test("a trigger or function that names a column takes the SQL name", () => {
    const stamp = listed(app).find(
      (object) => object.kind === "function" && object.identity.name === "stamp_unit",
    );
    const targets = stamp?.kind === "function" ? stamp.dependencies.map((edge) => edge.target) : [];
    expect(targets).toEqual([
      expect.objectContaining({ kind: "column", name: spell(casing, "displayName") }),
    ]);
  });

  test("views read the cased names and keep their client keys", () => {
    const query = (name: string): string => {
      const found = listed(app).find(
        (object) => object.kind === "view" && object.identity.name === name,
      );
      return found?.kind === "view" ? found.definition.query : "";
    };
    expect(query("status_list")).toBe(
      `select "${spell(casing, "codeID")}", "label" from "${spell(casing, "statusCodes")}"`,
    );
    const model = app.model as unknown as Readonly<
      Record<
        string,
        { readonly columns: readonly { readonly field: string; readonly sql: string }[] }
      >
    >;
    expect(model.statusList?.columns.map((column) => column.field)).toEqual(["codeID", "label"]);
    expect(model.statusList?.columns.map((column) => column.sql)).toEqual([
      spell(casing, "codeID"),
      "label",
    ]);
    expect(model.accountEmails?.columns.map((column) => column.field)).toEqual([
      "emailUrl",
      "tenantID",
    ]);
    expect(model.accountEmails?.columns.map((column) => column.sql)).toEqual([email, tenant]);
  });

  test("archive model and cascade carry the SQL names", () => {
    const archive = (
      app.model.userAccounts as unknown as {
        readonly archive?: {
          readonly at: string;
          readonly id: string;
          readonly cascade: readonly {
            readonly sql: string;
            readonly local: readonly string[];
            readonly remote: readonly string[];
          }[];
        };
      }
    ).archive;
    expect(archive?.at).toBe(spell(casing, "archivedAt"));
    expect(archive?.id).toBe(spell(casing, "archiveId"));
    expect(archive?.cascade[0]?.sql).toBe(spell(casing, "accountNotes"));
    expect(archive?.cascade[0]?.local).toEqual([spell(casing, "accountID"), tenant]);
    expect(archive?.cascade[0]?.remote).toEqual(["id", tenant]);
  });

  test("the DDL renders and uses only the cased names", () => {
    const ddl = renderCatalog(app.catalog, "public").join("\n");
    expect(ddl).toContain(accounts);
    expect(ddl).not.toContain("user_i_d");
    if (casing === "snake") expect(ddl).not.toMatch(/"[a-z]+[A-Z]/);
  });

  test("row-level security policies", () => {
    const rls = rlsFixture(casing);
    const notes = spell(casing, "userNotes");
    const policies = listed(rls).filter((object) => object.kind === "policy");
    expect(policies.map((object) => object.identity.name).sort()).toEqual([
      `${notes}_tenant`,
      `${notes}_unscoped_select`,
    ]);
    const tenantPolicy = policies.find((object) => object.identity.name === `${notes}_tenant`);
    const expression = tenantPolicy?.kind === "policy" ? tenantPolicy.definition.expression : "";
    expect(expression).toContain(casing === "snake" ? "tenant_id" : '"tenantId"');
  });
});

describe("refusals at schema build", () => {
  test("two keys that collide after casing are OKM1023", () => {
    const failure = capture(
      () =>
        schema({
          casing: "snake",
          tables: [table("tasks", { userID: t.text(), user_id: t.text() })],
        }).catalog,
    );
    expect(failure.code).toBe("OKM1023");
    expect(failure.message).toContain("user_id");
    const camel = capture(
      () =>
        schema({
          casing: "camel",
          tables: [table("tasks", { user_id: t.text(), userId: t.text() })],
        }).catalog,
    );
    expect(camel.code).toBe("OKM1023");
    const tables = capture(
      () =>
        schema({
          casing: "camel",
          tables: [
            table("user_tasks", { id: id({ default: "none" }) }),
            table("userTasks", { id: id({ default: "none" }) }),
          ],
        }).catalog,
    );
    expect(tables.code).toBe("OKM1023");
  });

  test("a sqlName that collides with a cased name is OKM1023", () => {
    const failure = capture(
      () =>
        schema({
          casing: "snake",
          tables: [table("tasks", { userID: t.text(), other: t.text().sqlName("user_id") })],
        }).catalog,
    );
    expect(failure.code).toBe("OKM1023");
  });

  test("an empty name and a name over 63 bytes are OKM1122", () => {
    const long = `${"a".repeat(30)}${"B".repeat(2)}${"c".repeat(30)}`;
    for (const casing of ["snake", "camel"] as const) {
      expect(
        capture(() => schema({ casing, tables: [table("tasks", { "": t.text() })] })).code,
      ).toBe("OKM1122");
      expect(
        capture(() => schema({ casing, tables: [table("tasks", { [`${long}ID`]: t.text() })] }))
          .code,
      ).toBe("OKM1122");
      expect(
        capture(() => schema({ casing, tables: [table(`${long}ID`, { id: t.text() })] })).code,
      ).toBe("OKM1122");
    }
  });

  test("snake can push a key over 63 bytes that camel keeps under", () => {
    const key = `${"a".repeat(20)}AbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAb`;
    expect(Buffer.byteLength(key)).toBeLessThan(63);
    expect(
      capture(() => schema({ casing: "snake", tables: [table("tasks", { [key]: t.text() })] }))
        .code,
    ).toBe("OKM1122");
    expect(schema({ casing: "camel", tables: [table("tasks", { [key]: t.text() })] }).casing).toBe(
      "camel",
    );
  });

  test("an unknown casing names both spellings", () => {
    const failure = capture(() => schema({ casing: "kebab" as never, tables: [] }));
    expect(failure.code).toBe("OKM1060");
    expect(failure.message).toBe("schema() casing kebab must be snake or camel.");
  });
});

describe("omitted casing", () => {
  test("keeps every key as written, quoted", () => {
    const app = columnFixture(undefined);
    expect(names(app, "table")).toContain("userAccounts");
    expect(names(app, "column", "userAccounts")).toContain("emailURL");
    expect(names(app, "sequence")).toEqual(["auditEntries_entryID_seq"]);
    expect(names(app, "function")).toContain("okm_touch_updatedAt");
    expect(renderCatalog(app.catalog, "public").join("\n")).toContain('"userAccounts"');
  });
});

describe("timestamps without casing", () => {
  test("the trigger finds updatedAt through the resolver", () => {
    const items = table(
      "items",
      { id: id({ default: "none" }) },
      { traits: [timestamps({ enforce: "trigger" })] },
    );
    for (const [casing, column] of [
      [undefined, "updatedAt"],
      ["snake", "updated_at"],
      ["camel", "updatedAt"],
    ] as const) {
      const app = schema({ ...(casing === undefined ? {} : { casing }), tables: [items] });
      expect(names(app as never, "function")).toEqual([`okm_touch_${column}`]);
    }
  });

  test("a function declared outside the schema is not renamed", () => {
    const declared = fn("DoThing", { returns: "integer", language: "sql", body: "select 1" });
    expect(declared.name).toBe("DoThing");
  });
});

function capture(run: () => unknown): OkmError {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}
