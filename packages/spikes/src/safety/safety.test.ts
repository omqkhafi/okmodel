/**
 * Final safety verification over presets, traits, and filters.
 *
 * A physical plan is only built from a query the verifier accepted.
 */

import { expect, test } from "bun:test";

import { compose } from "./compose.js";
import { SafetyError, violationKey } from "./errors.js";
import { defineFilters } from "./filters.js";
import { type BoolExpr, type LogicalQuery, type Predicate, andExpr, predExpr } from "./model.js";
import { plan } from "./plan.js";
import { readFilterInput } from "./operators.js";
import { sampleCatalog, validFind } from "./sample.js";
import { collectViolations, verify, walkPredicates } from "./verify.js";

const catalog = sampleCatalog();

test("a verified find plans one statement and keeps the tenant and archive rules", () => {
  const query = compose(validFind(), catalog);
  const verified = verify(query, catalog);
  const planned = plan(verified, catalog);
  expect(planned.statements).toBe(1);
  expect(planned.text).toContain('"tasks"."tenantId" = $tenant');
  expect(planned.text).toContain('"tasks"."archivedAt" is null');
  expect(planned.text).toContain("limit 50");
  expect(planned.applied.length).toBe(query.requested.length);
  expect(planned.escapes).toEqual([]);
  expect(planned.text).not.toContain("secret");
});

test("a cast without the brand cannot be planned", () => {
  const query = compose(validFind(), catalog);
  expect(() => plan(query as never, catalog)).toThrow(/verified/);
});

test("stripping the tenant predicate fails closed", () => {
  const attacked = dropPredicates(
    compose(validFind(), catalog),
    (predicate) => predicate.provenance.kind === "tenancy",
  );
  const error = expectThrow(attacked);
  expect(error.violations.some((item) => item.rule === "tenant")).toBe(true);
  expect(error.code).toBe("OKM1190");
});

test("OR-wrapping the tenant predicate fails closed", () => {
  const query = compose(validFind(), catalog);
  const tautology = predExpr({
    table: "tasks",
    column: "id",
    op: "isNotNull",
    parameter: undefined,
    provenance: { kind: "caller", name: "true", location: "attack.ts:1" },
  });
  const wrapped: LogicalQuery = {
    ...query,
    where: { kind: "or", args: [query.where, tautology] },
  };
  expect(expectThrow(wrapped).violations.some((item) => item.rule === "tenant")).toBe(true);
});

test("a caller-stamped tenant comparison does not count", () => {
  const query = compose(validFind(), catalog);
  const forged = mapPredicates(query, (predicate) =>
    predicate.provenance.kind === "tenancy"
      ? {
          ...predicate,
          provenance: { kind: "caller" as const, name: "tenantId", location: "attack.ts:1" },
        }
      : predicate,
  );
  expect(expectThrow(forged).violations.some((item) => item.rule === "tenant")).toBe(true);
});

test("guarded input is rejected unless allow names the field", () => {
  const rejected = compose({ ...validFind(), op: "update", input: ["role"] }, catalog);
  expect(expectThrow(rejected).violations.some((item) => item.rule === "guarded")).toBe(true);
  const allowed = verify(
    compose(
      {
        ...validFind(),
        op: "update",
        input: ["role"],
        caller: [{ column: "title", op: "eq", parameter: "$title" }],
        escapes: [{ hatch: "allow", fields: ["role"] }],
      },
      catalog,
    ),
    catalog,
  );
  expect(plan(allowed, catalog).escapes[0]?.hatch).toBe("allow");
});

test("the tenant key cannot be set from input, including with allow", () => {
  const query = compose(
    {
      op: "insert",
      table: "tasks",
      input: ["title", "tenantId"],
      escapes: [{ hatch: "allow", fields: ["tenantId"] }],
    },
    catalog,
  );
  expect(expectThrow(query).violations.some((item) => item.rule === "tenant")).toBe(true);
});

test("update cannot change the tenant key", () => {
  const query = compose(
    {
      op: "update",
      table: "tasks",
      input: ["tenantId"],
      caller: [{ column: "title", op: "eq", parameter: "$title" }],
    },
    catalog,
  );
  expect(expectThrow(query).violations.some((item) => item.rule === "tenant")).toBe(true);
});

test("hidden fields stay out of the default projection and can be named explicitly", () => {
  const query = compose(validFind(), catalog);
  expect(query.projection).not.toContain("secret");
  const shown = verify(compose({ ...validFind(), select: ["id", "secret"] }, catalog), catalog);
  expect(shown.projection).toContain("secret");
  const leaked: LogicalQuery = { ...query, projection: [...query.projection, "secret"] };
  expect(expectThrow(leaked).violations.some((item) => item.rule === "hidden")).toBe(true);
});

test("sensitive fields are redacted in inspect and their values are not SQL", () => {
  const query = compose(
    {
      ...validFind(),
      filters: {
        allow: { token: ["eq"] },
        payload: { where: { token: "super-secret-value" } },
      },
    },
    catalog,
  );
  const planned = plan(verify(query, catalog), catalog);
  expect(planned.redacted).toContain("token");
  expect(planned.text).not.toContain("super-secret-value");
  expect(
    planned.inspect.some((line) => line.includes("token") && line.includes("[redacted]")),
  ).toBe(true);
  const cleared: LogicalQuery = { ...query, redacted: [] };
  expect(expectThrow(cleared).violations.some((item) => item.rule === "sensitive")).toBe(true);
});

test("unscoped with a reason is recorded and a blank reason is not a hatch", () => {
  const query = verify(
    compose(
      { ...validFind(), escapes: [{ hatch: "unscoped", reason: "nightly report" }] },
      catalog,
    ),
    catalog,
  );
  expect(
    walkPredicates(query.where).some((predicate) => predicate.provenance.kind === "tenancy"),
  ).toBe(false);
  expect(plan(query, catalog).escapes[0]?.hatch).toBe("unscoped");
  const blank = compose(
    { ...validFind(), escapes: [{ hatch: "unscoped", reason: "  " }] },
    catalog,
  );
  expect(expectThrow(blank).violations.some((item) => item.rule === "escape")).toBe(true);
  expect(
    walkPredicates(blank.where).some((predicate) => predicate.provenance.kind === "tenancy"),
  ).toBe(true);
});

test("reads need a bound and writes need a caller filter", () => {
  const read = compose({ op: "find", table: "tasks", presets: ["pending"] }, catalog);
  expect(expectThrow(read).code).toBe("OKM1101");
  const unbounded = verify(
    compose(
      {
        op: "find",
        table: "tasks",
        presets: ["pending"],
        escapes: [{ hatch: "all", reason: "export" }],
      },
      catalog,
    ),
    catalog,
  );
  expect(plan(unbounded, catalog).text).not.toContain("limit");
  const write = compose({ op: "delete", table: "tasks" }, catalog);
  expect(expectThrow(write).code).toBe("OKM1102");
  verify(compose({ op: "delete", table: "tasks", presets: ["pending"] }, catalog), catalog);
});

test("archive modes", () => {
  const only = verify(compose({ ...validFind(), archive: "onlyArchived" }, catalog), catalog);
  expect(plan(only, catalog).text).toContain('"archivedAt" is not null');
  const widened = verify(compose({ ...validFind(), archive: "withArchived" }, catalog), catalog);
  expect(plan(widened, catalog).text).not.toContain('"archivedAt" is');
});

test("a global table does not grow a tenant predicate", () => {
  const query = verify(
    compose(
      {
        op: "find",
        table: "countries",
        limit: 10,
        caller: [{ column: "name", op: "eq", parameter: "$name" }],
      },
      catalog,
    ),
    catalog,
  );
  expect(
    walkPredicates(query.where).some((predicate) => predicate.provenance.kind === "tenancy"),
  ).toBe(false);
});

test("a touched tenant table and a relation filter both keep isolation", () => {
  const touched = verify(compose({ ...validFind(), touched: ["lists"] }, catalog), catalog);
  expect(hasTenant(touched, "lists")).toBe(true);
  expect(hasTenant(touched, "tasks")).toBe(true);
  const related = verify(
    compose(
      {
        ...validFind(),
        filters: {
          allow: { status: ["eq"] },
          relations: { list: ["name"] },
          payload: { where: { list: { op: "has", value: { name: "Work" } }, status: "draft" } },
        },
      },
      catalog,
    ),
    catalog,
  );
  expect(related.tables).toContain("lists");
  expect(hasTenant(related, "lists")).toBe(true);
  const planned = plan(related, catalog);
  expect(planned.text).not.toContain("Work");
  expect(planned.text).toContain("$filter_lists_name");
});

test("hidden fields cannot be allowlisted and client operators stay inside the list", () => {
  expect(() => defineFilters(catalog, "tasks", { allow: { secret: ["eq"] } })).toThrow(/Hidden/);
  const parser = defineFilters(catalog, "tasks", {
    allow: { status: ["eq", "in"] },
    sort: ["dueAt"],
    relations: { list: ["name"] },
  });
  expect(() => parser.parse({ where: { status: { op: "lt", value: 1 } } })).toThrow(/OKM1121/);
  expect(() => parser.parse({ where: { title: "x" } })).toThrow(/OKM1120/);
  expect(() => parser.parse({ sort: "secret" })).toThrow(/OKM1120/);
  expect(() => parser.parse({ where: { list: { op: "has", value: { secret: "x" } } } })).toThrow(
    /OKM1120/,
  );
  expect(() => readFilterInput(JSON.parse('{"op":"or","value":[]}') as unknown)).toThrow(/OKM1121/);
});

test("trusted skips tenant and archive checks and is recorded", () => {
  const query = verify(
    compose(
      { op: "find", table: "tasks", limit: 5, escapes: [{ hatch: "trusted", reason: "hand sql" }] },
      catalog,
    ),
    catalog,
  );
  expect(
    walkPredicates(query.where).some((predicate) => predicate.provenance.kind === "tenancy"),
  ).toBe(false);
  expect(plan(query, catalog).escapes[0]?.hatch).toBe("trusted");
});

test("several broken rules are all reported, in stable order", () => {
  const query = compose(validFind(), catalog);
  const broken: LogicalQuery = {
    ...query,
    op: "update",
    input: ["role"],
    projection: [...query.projection, "secret"],
  };
  const first = collectViolations(broken, catalog);
  const again = collectViolations(
    { ...broken, projection: ["secret", ...query.projection] },
    catalog,
  );
  expect(first.length).toBeGreaterThan(1);
  expect(first.map(violationKey)).toEqual(again.map(violationKey));
  expect(new Set(first.map((item) => item.rule))).toEqual(
    new Set(["guarded", "hidden", "dropped"]),
  );
});

test("contribution order does not change the verdict or the SQL", () => {
  const query = compose(validFind(), catalog);
  const reversed = reverseQuery(query);
  expect(collectViolations(query, catalog)).toEqual(collectViolations(reversed, catalog));
  expect(plan(verify(query, catalog), catalog).text).toBe(
    plan(verify(reversed, catalog), catalog).text,
  );
});

test("a recorded caller filter cannot disappear quietly", () => {
  const query = compose(validFind(), catalog);
  const kept =
    query.where.kind === "and"
      ? query.where.args.filter(
          (child) => child.kind !== "pred" || child.predicate.provenance.kind !== "caller",
        )
      : [];
  const stripped: LogicalQuery = { ...query, where: andExpr(kept) };
  expect(expectThrow(stripped).violations.some((item) => item.rule === "dropped")).toBe(true);
});

test("caller filters are not an invariant when they were never recorded", () => {
  const query = verify(
    compose({ op: "find", table: "tasks", presets: ["pending"], limit: 20 }, catalog),
    catalog,
  );
  expect(
    walkPredicates(query.where).some((predicate) => predicate.provenance.kind === "caller"),
  ).toBe(false);
  expect(hasTenant(query, "tasks")).toBe(true);
  plan(query, catalog);
});

test("a raw parameter is rejected", () => {
  const query = compose(validFind(), catalog);
  const injected = mapPredicates(query, (predicate) =>
    predicate.parameter === "$title"
      ? { ...predicate, parameter: "1; drop table tasks" }
      : predicate,
  );
  expect(expectThrow(injected).violations.some((item) => item.rule === "parameter")).toBe(true);
});

function hasTenant(query: LogicalQuery, table: string): boolean {
  return walkPredicates(query.where).some(
    (predicate) =>
      predicate.table === table &&
      predicate.column === "tenantId" &&
      predicate.op === "eq" &&
      predicate.parameter === "$tenant" &&
      predicate.provenance.kind === "tenancy",
  );
}

function expectThrow(query: LogicalQuery): SafetyError {
  try {
    verify(query, catalog);
  } catch (error) {
    expect(error).toBeInstanceOf(SafetyError);
    return error as SafetyError;
  }
  throw new Error("verify accepted a query that should fail");
}

function dropPredicates(
  query: LogicalQuery,
  match: (predicate: Predicate) => boolean,
): LogicalQuery {
  const removed = new Set(
    walkPredicates(query.where)
      .filter(match)
      .map((predicate) => predicate.provenance.kind + predicate.column),
  );
  return {
    ...query,
    where: filterExpr(query.where, match),
    contributions: query.contributions.filter((contribution) => {
      if (contribution.effect.kind !== "predicate") {
        return true;
      }
      const predicate = contribution.effect.predicate;
      return !removed.has(predicate.provenance.kind + predicate.column);
    }),
    requested: query.requested.filter((id) => {
      const contribution = query.contributions.find((item) => item.id === id);
      if (contribution?.effect.kind !== "predicate") {
        return true;
      }
      const predicate = contribution.effect.predicate;
      return !removed.has(predicate.provenance.kind + predicate.column);
    }),
  };
}

function filterExpr(expr: BoolExpr, match: (predicate: Predicate) => boolean): BoolExpr {
  switch (expr.kind) {
    case "pred":
      return match(expr.predicate) ? andExpr([]) : expr;
    case "and":
    case "or":
      return { kind: expr.kind, args: expr.args.map((child) => filterExpr(child, match)) };
    default: {
      const unreachable: never = expr;
      return unreachable;
    }
  }
}

function mapPredicates(
  query: LogicalQuery,
  map: (predicate: Predicate) => Predicate,
): LogicalQuery {
  return {
    ...query,
    where: mapExpr(query.where, map),
    contributions: query.contributions.map((contribution) => {
      if (contribution.effect.kind !== "predicate") {
        return contribution;
      }
      const predicate = map(contribution.effect.predicate);
      return { ...contribution, effect: { kind: "predicate" as const, predicate } };
    }),
  };
}

function mapExpr(expr: BoolExpr, map: (predicate: Predicate) => Predicate): BoolExpr {
  switch (expr.kind) {
    case "pred":
      return predExpr(map(expr.predicate));
    case "and":
    case "or":
      return { kind: expr.kind, args: expr.args.map((child) => mapExpr(child, map)) };
    default: {
      const unreachable: never = expr;
      return unreachable;
    }
  }
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
