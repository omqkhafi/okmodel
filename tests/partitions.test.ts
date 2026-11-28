/**
 * Partition rules compile without a database.
 *
 * Bounds for America/New_York are checked as instants. Asia/Riyadh has no
 * daylight saving, so the transitions are this zone.
 */

import { expect, test } from "bun:test";

import { DriverError } from "../src/adapters/error.js";
import { OkmError } from "../src/contracts/error.js";
import { mapPostgresError } from "../src/dialects/pg/errors.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { warningRule } from "../src/runtime/warnings/catalog.js";
import { ruleFires } from "../src/runtime/warnings/evaluate.js";

const march = "2026-03-01 05:00:00+00";
const april = "2026-04-01 04:00:00+00";
const november = "2026-11-01 04:00:00+00";
const december = "2026-12-01 05:00:00+00";

test("a timestamptz month rule writes both daylight transitions as instants", () => {
  const app = schema({
    tables: [
      table(
        "events",
        { id: t.integer(), occurredAt: t.timestamptz(), body: t.text() },
        {
          primaryKey: ["id", "occurredAt"],
          partition: {
            by: "range",
            key: "occurredAt",
            every: "month",
            at: "America/New_York",
            from: "2026-01-01",
            ahead: 3,
          },
        },
      ),
    ],
  });
  const stored = app.catalog.objects.find((object) => object.kind === "table");
  if (stored?.kind !== "table") throw new Error("missing table");
  const children = stored.definition.partition?.children ?? [];
  const bound = (suffix: string): { kind: "range"; from: string; to: string } => {
    const child = children.find((item) => item.suffix === suffix);
    if (child?.bound.kind !== "range") throw new Error(`missing ${suffix}`);
    return child.bound;
  };
  expect(bound("2026_03")).toEqual({ kind: "range", from: march, to: april });
  expect(bound("2026_11")).toEqual({ kind: "range", from: november, to: december });
});

test("keep.then detach is the detach action, and another word is refused", () => {
  const app = schema({
    tables: [
      table(
        "events",
        { id: t.integer(), occurredAt: t.timestamptz() },
        {
          primaryKey: ["id", "occurredAt"],
          partition: {
            by: "range",
            key: "occurredAt",
            every: "month",
            at: "UTC",
            from: "2026-01-01",
            ahead: 1,
            // oxlint-disable-next-line unicorn/no-thenable -- keep.then names the action, not a thenable
            keep: { for: "13 months", then: "detach" },
          },
        },
      ),
    ],
  });
  const stored = app.catalog.objects.find((object) => object.kind === "table");
  if (stored?.kind !== "table") throw new Error("missing table");
  expect(stored.definition.partition?.rule?.keepThen).toBe("detach");
  expect(
    () =>
      schema({
        tables: [
          table(
            "events",
            { id: t.integer(), occurredAt: t.timestamptz() },
            {
              primaryKey: ["id", "occurredAt"],
              partition: {
                by: "range",
                key: "occurredAt",
                every: "month",
                at: "UTC",
                from: "2026-01-01",
                ahead: 1,
                // oxlint-disable-next-line unicorn/no-thenable -- keep.then names the action, not a thenable
                keep: { for: "13 months", then: "archive" as "drop" },
              },
            },
          ),
        ],
      }).catalog,
  ).toThrow(/keep\.then must be detach or drop/);
});

test("a timestamptz rule without at is refused", () => {
  expect(
    () =>
      schema({
        tables: [
          table(
            "events",
            { id: t.integer(), at: t.timestamptz() },
            {
              primaryKey: ["id", "at"],
              partition: { by: "range", key: "at", every: "month", from: "2026-01-01", ahead: 1 },
            },
          ),
        ],
      }).catalog,
  ).toThrow(/partition\.at/);
});

test("a hash count, a list default, and an external parent compile", () => {
  const app = schema({
    tables: [
      table(
        "tenants",
        { id: t.integer(), tenantId: t.integer() },
        { primaryKey: ["id", "tenantId"], partition: { by: "hash", key: "tenantId", count: 8 } },
      ),
      table(
        "regions",
        { id: t.integer(), region: t.text() },
        {
          primaryKey: ["id", "region"],
          partition: { by: "list", key: "region" },
          partitions: { eu: { in: ["eu", "uk"] }, rest: { default: true } },
        },
      ),
      table(
        "owned",
        { id: t.integer(), at: t.timestamptz() },
        {
          primaryKey: ["id", "at"],
          partition: { by: "range", key: "at", at: "UTC", children: "external" },
        },
      ),
    ],
  });
  const ownership = (name: string): string | undefined => {
    const object = app.catalog.objects.find(
      (item) => item.kind === "table" && item.identity.name === name,
    );
    return object?.kind === "table" ? object.definition.partition?.ownership : undefined;
  };
  expect(ownership("tenants")).toBe("managed");
  expect(ownership("regions")).toBe("managed");
  expect(ownership("owned")).toBe("external");
});

test("a primary key that omits the partition column is OKM1932", () => {
  expect(
    () =>
      schema({
        tables: [
          table(
            "events",
            { id: t.integer().primaryKey(), at: t.timestamptz() },
            {
              partition: {
                by: "range",
                key: "at",
                every: "month",
                at: "UTC",
                from: "2026-01-01",
                ahead: 1,
              },
            },
          ),
        ],
      }).catalog,
  ).toThrow(OkmError);
});

test("a foreign key that omits the partition column is OKM1932", () => {
  expect(
    () =>
      schema({
        tables: [
          table(
            "events",
            { id: t.integer(), at: t.timestamptz() },
            {
              primaryKey: ["id", "at"],
              partition: {
                by: "range",
                key: "at",
                every: "month",
                at: "UTC",
                from: "2026-01-01",
                ahead: 1,
              },
            },
          ),
          table(
            "notes",
            { id: t.integer().primaryKey(), eventId: t.integer() },
            {
              foreignKeys: () => ({
                event: { columns: ["eventId"], references: { table: "events", columns: ["id"] } },
              }),
            },
          ),
        ],
      }).catalog,
  ).toThrow(/without partition column/);
});

test("23514 without a constraint name is check no_partition", () => {
  const mapped = mapPostgresError(
    new DriverError("no partition of relation found for row", {
      sqlstate: "23514",
      table: "events",
      detail: "Partition key of the failing row contains (occurred_at) = (2030-06-01 00:00:00+00).",
    }),
  );
  expect(mapped.kind).toBe("check");
  expect(mapped.fieldReason).toBe("no_partition");
  expect(mapped.fix?.summary).toBe("Run okm partitions maintain.");
});

test("a query that omits the partition key is OKM2130", () => {
  const app = schema({
    tables: [
      table(
        "events",
        { id: t.integer(), occurredAt: t.timestamptz() },
        {
          primaryKey: ["id", "occurredAt"],
          partition: {
            by: "range",
            key: "occurredAt",
            every: "month",
            at: "UTC",
            from: "2026-01-01",
            ahead: 1,
          },
        },
      ),
    ],
  });
  const rule = warningRule("partition");
  if (rule === undefined) throw new Error("missing rule");
  const model = app as unknown as { readonly model: unknown };
  expect(ruleFires(rule, model as never, { op: "findMany", table: "events" })).toBe(true);
  expect(
    ruleFires(rule, model as never, {
      op: "findMany",
      table: "events",
      where: { occurredAt: { gte: "2026-03-01" } },
    }),
  ).toBe(false);
});

test("a default partition is OKM2130", () => {
  const app = schema({
    tables: [
      table(
        "regions",
        { id: t.integer(), region: t.text() },
        {
          primaryKey: ["id", "region"],
          partition: { by: "list", key: "region" },
          partitions: { eu: { in: ["eu"] }, rest: { default: true } },
        },
      ),
    ],
  });
  const child = app.catalog.objects.find((object) => object.kind === "table");
  if (child?.kind !== "table") throw new Error("missing");
  expect(child.definition.partition?.children?.some((item) => item.bound.kind === "default")).toBe(
    true,
  );
});
