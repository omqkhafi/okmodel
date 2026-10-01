/**
 * Random presets, traits, and filters. Accepted queries keep every safety rule.
 * Rule order does not change the verdict. A requested rule is not dropped.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import { compose } from "./compose.js";
import { SafetyError, violationKey } from "./errors.js";
import {
  type ArchiveMode,
  type BoolExpr,
  type Catalog,
  type LogicalQuery,
  type QueryOp,
  tableByName,
} from "./model.js";
import { plan } from "./plan.js";
import { PRESET_NAMES, type PresetName, catalogFor } from "./sample.js";
import { collectViolations, verify, walkPredicates } from "./verify.js";

const INPUTS = ["title", "role", "secret", "token", "createdAt", "tenantId", "id"] as const;
const TRAITS = ["timestamps", "archivable"] as const;

test("random compositions cannot bypass a rule or drop one, and order does not matter", () => {
  fc.assert(
    fc.property(draftArb, (shape) => {
      const catalog = catalogFor({
        tenancy: shape.tenancy,
        traits: shape.traits,
        hidden: shape.hidden,
        sensitive: shape.sensitive,
      });
      let query: LogicalQuery;
      try {
        query = compose(toDraft(shape), catalog);
      } catch (error) {
        expect(error).toBeInstanceOf(SafetyError);
        return;
      }
      expect(new Set(query.requested)).toEqual(new Set(query.contributions.map((item) => item.id)));
      for (const name of shape.presets) {
        expect(
          query.contributions.some(
            (item) => item.provenance.kind === "preset" && item.provenance.name === name,
          ),
        ).toBe(true);
      }
      for (const contribution of query.contributions) {
        if (contribution.effect.kind !== "predicate") {
          continue;
        }
        const expected = contribution.effect.predicate;
        expect(
          walkPredicates(query.where).some(
            (predicate) =>
              predicate.table === expected.table &&
              predicate.column === expected.column &&
              predicate.op === expected.op &&
              predicate.parameter === expected.parameter &&
              predicate.provenance.kind === expected.provenance.kind,
          ),
        ).toBe(true);
      }
      const verdict = verdictOf(query, catalog);
      expect(verdictOf(reverseQuery(query), catalog)).toEqual(verdict);
      if (shape.unscoped !== undefined && shape.unscoped.trim().length === 0) {
        expect(verdict.ok).toBe(false);
        expect(verdict.rules.some((rule) => rule.includes("escape"))).toBe(true);
      }
      if (!verdict.ok) {
        expect(() => plan(query as never, catalog)).toThrow(SafetyError);
        return;
      }
      assertAccepted(query, catalog, shape);
      const verified = verify(query, catalog);
      const planned = plan(verified, catalog);
      expect(planned.statements).toBe(1);
      expect(planned.text).not.toContain("drop table");
      expect(plan(verify(reverseQuery(query), catalog), catalog).text).toBe(planned.text);
    }),
    { numRuns: 80, seed: 1 },
  );
});

type Shape = {
  readonly tenancy: "column" | "global";
  readonly traits: readonly ("timestamps" | "archivable")[];
  readonly presets: readonly PresetName[];
  readonly op: QueryOp;
  readonly limit: number | undefined;
  readonly archive: ArchiveMode;
  readonly input: readonly string[];
  readonly select: "default" | "explicit";
  readonly unscoped: string | undefined;
  readonly all: string | undefined;
  readonly allow: readonly string[];
  readonly touchLists: boolean;
  readonly filter: boolean;
  readonly hidden: boolean;
  readonly sensitive: boolean;
};

const draftArb: fc.Arbitrary<Shape> = fc.record({
  tenancy: fc.constantFrom("column", "global"),
  traits: fc.subarray([...TRAITS]),
  presets: fc.subarray([...PRESET_NAMES]),
  op: fc.constantFrom("find", "insert", "update", "delete"),
  limit: fc.option(fc.integer({ min: 1, max: 40 }), { nil: undefined }),
  archive: fc.constantFrom("active", "withArchived", "onlyArchived"),
  input: fc.subarray([...INPUTS]),
  select: fc.constantFrom("default", "explicit"),
  unscoped: fc.option(fc.constantFrom("nightly report", "", "   "), { nil: undefined }),
  all: fc.option(fc.constantFrom("export", ""), { nil: undefined }),
  allow: fc.subarray(["role", "createdAt"]),
  touchLists: fc.boolean(),
  filter: fc.boolean(),
  hidden: fc.boolean(),
  sensitive: fc.boolean(),
});

function toDraft(shape: Shape) {
  const escapes = [];
  if (shape.unscoped !== undefined) {
    escapes.push({ hatch: "unscoped" as const, reason: shape.unscoped });
  }
  if (shape.all !== undefined) {
    escapes.push({ hatch: "all" as const, reason: shape.all });
  }
  if (shape.allow.length > 0) {
    escapes.push({ hatch: "allow" as const, fields: shape.allow });
  }
  return {
    op: shape.op,
    table: "tasks",
    presets: shape.presets,
    input: shape.input,
    ...(shape.limit !== undefined ? { limit: shape.limit } : {}),
    archive: shape.archive,
    touched: shape.touchLists ? ["lists"] : [],
    select:
      shape.select === "explicit" ? (["id", "title", "secret"] as const) : ("default" as const),
    escapes,
    ...(shape.filter
      ? {
          filters: {
            allow: { title: ["eq", "startsWith"] },
            payload: { where: { title: { op: "startsWith", value: "Work" } } },
          },
        }
      : {}),
  };
}

function assertAccepted(query: LogicalQuery, catalog: Catalog, shape: Shape): void {
  const tasks = tableByName(catalog, "tasks");
  if (tasks === undefined) {
    throw new Error("missing tasks");
  }
  const trusted = hatch(query, "trusted");
  const unscoped = hatch(query, "unscoped");
  if (tasks.tenancy === "column" && !trusted && !unscoped) {
    if (query.op === "insert") {
      expect(
        query.values.some(
          (value) =>
            value.column === "tenantId" &&
            value.parameter === "$tenant" &&
            value.provenance.kind === "tenancy",
        ),
      ).toBe(true);
      expect(query.input.includes("tenantId")).toBe(false);
    } else {
      expect(direct(query, "tasks", "tenantId", "eq", "$tenant", "tenancy")).toBe(true);
    }
  }
  if (shape.touchLists && !trusted && !unscoped) {
    expect(direct(query, "lists", "tenantId", "eq", "$tenant", "tenancy")).toBe(true);
  }
  if (
    tasks.traits.includes("archivable") &&
    query.op !== "insert" &&
    !trusted &&
    query.archive === "active"
  ) {
    expect(direct(query, "tasks", "archivedAt", "isNull", undefined, "archive")).toBe(true);
  }
  if (query.select === "default" && shape.hidden) {
    expect(query.projection).not.toContain("secret");
  }
  if (shape.sensitive) {
    expect(query.redacted).toContain("token");
  }
  const allowed = new Set(
    query.escapes.flatMap((escape) => (escape.hatch === "allow" ? escape.fields : [])),
  );
  for (const column of query.input) {
    const field = tasks.fields.find((entry) => entry.name === column);
    if (
      field?.guarded === true &&
      field.tenantKey !== true &&
      (query.op === "insert" || query.op === "update")
    ) {
      expect(allowed.has(column)).toBe(true);
    }
  }
}

function direct(
  query: LogicalQuery,
  table: string,
  column: string,
  op: string,
  parameter: string | undefined,
  kind: string,
): boolean {
  const args = query.where.kind === "and" ? query.where.args : [query.where];
  return args.some(
    (child) =>
      child.kind === "pred" &&
      child.predicate.table === table &&
      child.predicate.column === column &&
      child.predicate.op === op &&
      child.predicate.parameter === parameter &&
      child.predicate.provenance.kind === kind,
  );
}

function hatch(query: LogicalQuery, name: "unscoped" | "trusted"): boolean {
  return query.escapes.some((escape) => escape.hatch === name && escape.reason.trim().length > 0);
}

function verdictOf(
  query: LogicalQuery,
  catalog: Catalog,
): { readonly ok: boolean; readonly rules: readonly string[] } {
  const rules = collectViolations(query, catalog).map(violationKey);
  return { ok: rules.length === 0, rules };
}

function reverseQuery(query: LogicalQuery): LogicalQuery {
  return {
    ...query,
    where: reverseExpr(query.where),
    contributions: [...query.contributions].reverse(),
  };
}

function reverseExpr(expr: BoolExpr): BoolExpr {
  switch (expr.kind) {
    case "pred":
      return expr;
    case "and":
    case "or":
      return { kind: expr.kind, args: [...expr.args].reverse().map((child) => reverseExpr(child)) };
    default: {
      const unreachable: never = expr;
      return unreachable;
    }
  }
}
