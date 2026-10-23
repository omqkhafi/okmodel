/**
 * One schema that touches every emitter that spells a name, built under any casing.
 *
 * The keys use acronyms and digits on purpose: `tenantID`, `emailURL`,
 * `line2Text`. `n()` is what the compiler must produce, so the fixture can write
 * the SQL names a function body, a trigger, or a view query needs.
 */

import { fn, trigger } from "../src/dialects/pg/fn/index.js";
import { caseName, type Casing } from "../src/dialects/pg/casing.js";
import { id, index, one, schema, sql, table, t } from "../src/dialects/pg/index.js";
import { materializedView, view } from "../src/dialects/pg/view/index.js";
import { archivable, sortable, timestamps } from "../src/runtime/traits/index.js";
import { columnTenancy, global, rlsTenancy, via } from "../src/runtime/tenancy/index.js";

/**
 * The SQL spelling of a key under `casing`.
 *
 * @param casing - Schema casing
 * @param key - TypeScript key
 * @returns What the compiler writes
 */
export function spell(casing: Casing | undefined, key: string): string {
  return casing === undefined ? key : caseName(casing, key);
}

/**
 * Column-tenancy schema with path tenancy, traits, and every derived name.
 *
 * @param casing - Schema casing, or `undefined` for keys as written
 * @returns The built schema
 */
export function columnFixture(casing: Casing | undefined) {
  const n = (key: string): string => spell(casing, key);
  const orgUnits = table(
    "orgUnits",
    {
      id: id({ default: "none" }),
      displayName: t.text(),
      apiURL: t.text().nullable(),
    },
    { traits: [timestamps({ enforce: "trigger" })] },
  );
  const userAccounts = table(
    "userAccounts",
    {
      id: id({ default: "none" }),
      orgUnitID: t.uuid().references("orgUnits"),
      emailURL: t.text(),
      line2Text: t.text().nullable(),
      status: t.enum("account_status", ["on", "off"]),
      score: t.domain("positive_score", t.integer(), "VALUE > 0"),
    },
    {
      traits: [archivable({ cascade: ["accountNotes"] })],
      unique: { byEmail: ["emailURL"] },
      indexes: (columns) => [index(columns.orgUnitID, columns.emailURL), index(columns.line2Text)],
      checks: {
        score_positive: (columns) => sql`${columns.score} > 0`,
      },
    },
  );
  const accountNotes = table(
    "accountNotes",
    {
      id: id({ default: "none" }),
      accountID: t.uuid().references("userAccounts"),
      htmlBody: t.text(),
    },
    { traits: [archivable()] },
  );
  const taskItems = table(
    "taskItems",
    {
      id: id({ default: "none" }),
      unitID: t.uuid().references("orgUnits"),
      htmlTitle: t.text(),
    },
    {
      tenancy: via("unit"),
      relations: { unit: one("orgUnits", "unitID") },
    },
  );
  const boardCards = table(
    "boardCards",
    {
      id: id({ default: "none" }),
      laneID: t.text(),
      label: t.text(),
    },
    { traits: [sortable("laneID")] },
  );
  const auditEntries = table(
    "auditEntries",
    {
      entryID: t.identity(),
      note: t.text(),
    },
    { tenancy: global("audit rows belong to nobody") },
  );
  const statusCodes = table(
    "statusCodes",
    { codeID: t.text().primaryKey(), label: t.text() },
    {
      tenancy: global("lookup rows are shared"),
      reference: {
        key: "codeID",
        rows: [
          { codeID: "ok", label: "Fine" },
          { codeID: "bad", label: "Broken" },
        ],
      },
    },
  );
  const stamp = fn("stamp_unit", {
    returns: "trigger",
    language: "plpgsql",
    body: `begin new."${n("displayName")}" = upper(new."${n("displayName")}"); return new; end`,
    dependsOn: [{ table: orgUnits, column: n("displayName") }],
  });
  return schema({
    ...(casing === undefined ? {} : { casing }),
    tenancy: columnTenancy({ key: "tenantID", type: "uuid" }),
    tables: [
      orgUnits,
      userAccounts,
      accountNotes,
      taskItems,
      boardCards,
      auditEntries,
      statusCodes,
    ],
    functions: [stamp],
    triggers: [
      trigger("org_units_stamp", {
        on: orgUnits,
        timing: "before",
        events: ["update"],
        level: "row",
        updateOf: [n("displayName")],
        calls: stamp,
      }),
    ],
    views: [
      view("status_list", (q) =>
        q.from(statusCodes, ["codeID", "label"]).tenancy(global("lookup rows are shared")),
      ),
      view("account_emails", {
        columns: [
          { name: n("emailURL"), type: "text" },
          { name: n("tenantID"), type: "uuid" },
        ],
        query: `select "${n("emailURL")}", "${n("tenantID")}" from "${n("userAccounts")}"`,
      }),
      materializedView("unit_names", {
        columns: [
          { name: n("displayName"), type: "text" },
          { name: n("tenantID"), type: "uuid" },
        ],
        query: `select "${n("displayName")}", "${n("tenantID")}" from "${n("orgUnits")}"`,
      }),
    ],
  });
}

/**
 * Row-level-security schema: policies on a table with acronym and digit keys.
 *
 * @param casing - Schema casing, or `undefined` for keys as written
 * @returns The built schema
 */
export function rlsFixture(casing: Casing | undefined) {
  const notes = table("userNotes", {
    id: id({ default: "none" }),
    bodyHTML: t.text(),
    line1Text: t.text().nullable(),
  });
  return schema({
    ...(casing === undefined ? {} : { casing }),
    tenancy: rlsTenancy({ key: "tenantID", type: "uuid" }),
    tables: [notes],
  });
}
