/**
 * Event-trigger declarations, without a server.
 *
 * The function shape, login, tags, enableRls, and plan order are checked
 * here. Firing is in the Postgres file.
 */

import { expect, test } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import "../src/dialects/pg/event/index.js";
import { auditDdl, enableRls, guardDdl, notifyDdl } from "../src/dialects/pg/event/index.js";
import {
  eventTriggerType,
  fn,
  trigger,
  triggerType,
  voidType,
} from "../src/dialects/pg/fn/index.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import "../src/dialects/pg/policy.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { schemaAdvice } from "../src/tooling/migrate/schema-rules.js";

test("login and a shared-object tag are OKM1931", () => {
  const fnName = fn("nope", {
    returns: eventTriggerType,
    language: "plpgsql",
    body: "begin end",
  });
  expect(capture(() => trigger("locks", { event: "login", calls: fnName })).message).toContain(
    "BUG #19488",
  );
  expect(
    capture(() =>
      trigger("roles", { event: "ddl_command_end", tags: ["CREATE ROLE"], calls: fnName }),
    ).message,
  ).toContain("0A000");
});

test("an event trigger function must be plpgsql, with no arguments, returning event_trigger", () => {
  const sqlFn = fn("not_plpgsql", {
    returns: eventTriggerType,
    language: "sql",
    body: "begin atomic select 1; end",
  });
  const args = fn("with_args", {
    returns: eventTriggerType,
    language: "plpgsql",
    arguments: [{ name: "n", type: t.integer() }],
    body: "begin end",
  });
  const wrong = fn("returns_void", {
    returns: voidType,
    language: "plpgsql",
    dependsOn: [],
    body: "begin end",
  });
  const good = fn("good_evt", {
    returns: "event_trigger",
    language: "plpgsql",
    body: "begin end",
  });
  const built = schema({
    tables: [],
    functions: [sqlFn, args, good],
    triggers: [trigger("uses_good", { event: "ddl_command_end", calls: good })],
  }).catalog;
  expect(built.objects.some((object) => object.kind === "eventTrigger")).toBe(true);
  expect(
    capture(
      () =>
        schema({
          tables: [],
          functions: [sqlFn],
          triggers: [trigger("uses_sql", { event: "ddl_command_end", calls: sqlFn })],
        }).catalog,
    ).message,
  ).toContain("plpgsql");
  expect(
    capture(
      () =>
        schema({
          tables: [],
          functions: [args],
          triggers: [trigger("uses_args", { event: "ddl_command_end", calls: args })],
        }).catalog,
    ).message,
  ).toContain("42P13");
  expect(
    capture(
      () =>
        schema({
          tables: [],
          functions: [wrong],
          triggers: [trigger("uses_void", { event: "ddl_command_end", calls: wrong })],
        }).catalog,
    ).message,
  ).toContain("42P17");
});

test("a tag the event cannot see is OKM2129", () => {
  const good = fn("tag_fn", {
    returns: eventTriggerType,
    language: "plpgsql",
    body: "begin end",
  });
  const built = schema({
    tables: [],
    functions: [good],
    triggers: [
      trigger("drop_only", {
        event: "sql_drop",
        tags: ["CREATE TABLE"],
        calls: good,
      }),
    ],
  });
  const advice = schemaAdvice({ catalog: built.catalog, model: built.model }, [], {});
  expect(advice.advice.some((item) => item.code === "OKM2129")).toBe(true);
});

test("enableRls defaults rls on and refuses rls false", () => {
  const notes = table("notes", { id: t.identity() });
  const covered = schema({
    tables: [notes],
    triggers: [enableRls({ schemas: ["public"] })],
  }).catalog;
  const tableObject = covered.objects.find((object) => object.kind === "table");
  expect(tableObject?.kind === "table" && tableObject.definition.rowSecurity?.enable).toBe(true);
  const blocked = table("blocked", { id: t.identity() }, { rls: false });
  expect(
    capture(
      () =>
        schema({
          tables: [blocked],
          triggers: [enableRls({ schemas: ["public"] })],
        }).catalog,
    ).message,
  ).toContain("rls: false");
});

test("event triggers are created last and dropped first", () => {
  const notes = table("notes", { id: t.identity(), title: t.text() });
  const good = fn("plan_fn", {
    returns: eventTriggerType,
    language: "plpgsql",
    body: "begin end",
  });
  const trig = trigger("plan_evt", { event: "ddl_command_end", calls: good });
  const after = schema({ tables: [notes], functions: [good], triggers: [trig] }).catalog;
  const created = planMigration({ before: catalog([]), after, name: "add" });
  const kinds = created.steps.map((step) => step.kind);
  expect(kinds.indexOf("create-function")).toBeLessThan(kinds.indexOf("create-event-trigger"));
  expect(kinds.indexOf("create-event-trigger")).toBe(kinds.lastIndexOf("create-event-trigger"));
  expect(kinds.at(-1) === "create-event-trigger" || kinds.at(-2) === "create-event-trigger").toBe(
    true,
  );
  const dropped = planMigration({ before: after, after: catalog([]), name: "remove" });
  expect(dropped.steps[0]?.kind).toBe("drop-event-trigger");
});

test("enabled is an alter and a body change is drop plus create", () => {
  const good = fn("mode_fn", {
    returns: eventTriggerType,
    language: "plpgsql",
    body: "begin end",
  });
  const on = schema({
    tables: [],
    functions: [good],
    triggers: [trigger("mode_evt", { event: "ddl_command_end", calls: good, enabled: true })],
  }).catalog;
  const off = schema({
    tables: [],
    functions: [good],
    triggers: [trigger("mode_evt", { event: "ddl_command_end", calls: good, enabled: false })],
  }).catalog;
  const altered = planMigration({ before: on, after: off, name: "disable" });
  expect(altered.steps.map((step) => step.kind)).toContain("alter-event-trigger");
  expect(altered.steps.some((step) => step.kind === "drop-event-trigger")).toBe(false);
  const other = fn("other_fn", {
    returns: eventTriggerType,
    language: "plpgsql",
    body: "begin end",
  });
  const moved = schema({
    tables: [],
    functions: [good, other],
    triggers: [trigger("mode_evt", { event: "sql_drop", calls: other })],
  }).catalog;
  const replaced = planMigration({ before: on, after: moved, name: "swap" });
  const replacedKinds = replaced.steps.map((step) => step.kind);
  expect(replacedKinds).toContain("drop-event-trigger");
  expect(replacedKinds).toContain("create-event-trigger");
});

test("presets compile and auditDdl has no keep scheduler", () => {
  const notes = table("notes", { id: t.identity() });
  const audit = auditDdl();
  const built = schema({
    tables: [notes, audit.transactions, audit.commands],
    triggers: [
      guardDdl({ block: "manual", allow: ["migration"] }),
      guardDdl({ block: ["drops", "rewrites"] }),
      notifyDdl({ channel: "schema_changed", tags: ["ALTER TABLE"] }),
      audit,
    ],
  }).catalog;
  const names = built.objects
    .filter((object) => object.kind === "eventTrigger")
    .map((object) => object.identity.name)
    .sort();
  expect(names).toEqual([
    "okm_audit_drop",
    "okm_audit_end",
    "okm_guard_drops",
    "okm_guard_manual",
    "okm_guard_rewrites",
    "okm_notify_ddl",
  ]);
  const fnBody = built.objects.find(
    (object) => object.kind === "function" && object.identity.name === "okm_audit_ddl",
  );
  expect(fnBody?.kind === "function" && fnBody.definition.security).toBe("definer");
  expect(fnBody?.kind === "function" && fnBody.definition.body.includes("pg_cron")).toBe(false);
});

test("transition tables are after, statement, one event", () => {
  const notes = table("notes", { id: t.identity() });
  const rowFn = fn("row_fn", {
    returns: triggerType,
    language: "plpgsql",
    dependsOn: [notes],
    body: "begin return null; end",
  });
  expect(
    capture(
      () =>
        schema({
          tables: [notes],
          functions: [rowFn],
          triggers: [
            trigger("bad_ref", {
              on: notes,
              timing: "before",
              events: ["insert"],
              level: "statement",
              referencing: { new: "new_rows" },
              calls: rowFn,
            }),
          ],
        }).catalog,
    ).code,
  ).toBe("OKM1931");
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
