/**
 * Lint rules for one plan step or one catalog column.
 *
 * A rule reads the statement and the catalogs. It does not connect.
 */

import { isDomain } from "../../contracts/catalog/enum.js";
import type {
  Catalog,
  ColumnObject,
  ConstraintObject,
  TypeObject,
} from "../../contracts/catalog/types.js";
import { postgresProbeParses } from "./pg-probe.js";
import type { PlanStep, StepKind } from "./plan.js";
import { checkRejectsNull, defaultViolatesCheck } from "./check-value.js";
import { volatileDefault } from "./safe.js";
import { statementOutsideTransaction } from "./runner.js";
import { sqlStatements, transactionControl } from "./sql-lex.js";
import { canonicalTypeName } from "./type-name.js";

/** Destructive, compatibility, data, locking, or a schema type preference. */
export type LintCategory =
  | "destructive"
  | "backward-incompatible"
  | "data-dependent"
  | "locking"
  | "type-preference";

/** An error blocks plan, check, and apply. A warning is printed and does not. */
export type LintSeverity = "error" | "warning";

/** What a step rule can see. Catalogs are the plan's before and after. */
export type StepInput = {
  readonly step: PlanStep;
  readonly before: Catalog;
  readonly after: Catalog;
  readonly existingTables: ReadonlySet<string>;
  /** Steps before this one. A safe `SET NOT NULL` is recognised from them. */
  readonly earlier: readonly PlanStep[];
  /** Steps after this one. A unique index built for a constraint is recognised from them. */
  readonly later: readonly PlanStep[];
};

/** One step rule. `check` returns a reason for each hit, or nothing. */
export type StepRule = {
  readonly code: string;
  readonly category: Exclude<LintCategory, "type-preference">;
  readonly severity: LintSeverity;
  /** One line for the codes table. */
  readonly doc: string;
  readonly check: (input: StepInput) => readonly string[];
};

/** One schema rule. `okm check` runs these on the author catalog. */
export type ColumnRule = {
  readonly code: string;
  readonly category: "type-preference";
  readonly severity: "warning";
  /** One line for the codes table. */
  readonly doc: string;
  readonly check: (column: ColumnObject) => string | undefined;
};

const INTEGER_WIDTH: Readonly<Record<string, number>> = {
  smallint: 2,
  integer: 4,
  bigint: 8,
};

const FLOAT_WIDTH: Readonly<Record<string, number>> = {
  real: 4,
  "double precision": 8,
};

/**
 * Step rules, lowest free code in each category.
 *
 * OKM1534 to OKM1537 are errors when the statement is not the safe form.
 * OKM1538 stays a warning, and only when the type change rewrites the table.
 */
export const STEP_RULES: readonly StepRule[] = [
  rule("OKM1511", "destructive", "error", "Dropping a table destroys its rows.", (input) =>
    hit(matches(input.step, "drop-table", /^drop table\b/), "drops a table"),
  ),
  rule("OKM1512", "destructive", "error", "Dropping a column destroys its values.", (input) =>
    hit(matches(input.step, "drop-column", /^alter table\s+\S+\s+drop column\b/), "drops a column"),
  ),
  rule(
    "OKM1513",
    "destructive",
    "error",
    "Dropping an enum can break columns that use it.",
    (input) => hit(droppedType(input) === "enum", "drops an enum"),
  ),
  rule(
    "OKM1514",
    "destructive",
    "error",
    "Dropping a domain can break columns that use it.",
    (input) => hit(droppedType(input) === "domain", "drops a domain"),
  ),
  rule("OKM1515", "destructive", "error", "Dropping a function can break its callers.", (input) =>
    hit(matches(input.step, "drop-function", /^drop function\b/), "drops a function"),
  ),
  rule(
    "OKM1516",
    "destructive",
    "error",
    "Dropping a view can break queries that read it.",
    (input) => hit(matches(input.step, "drop-view", /^drop view\b/), "drops a view"),
  ),
  rule(
    "OKM1517",
    "destructive",
    "error",
    "Dropping an extension removes it even when the catalog has no dependent.",
    (input) =>
      hit(matches(input.step, "drop-extension", /^drop extension\b/), "drops an extension"),
  ),
  rule(
    "OKM1518",
    "destructive",
    "error",
    "Dropping a materialized view destroys the rows it stores.",
    (input) =>
      hit(
        matches(input.step, "drop-matview", /^drop materialized view\b/),
        "drops a materialized view",
      ),
  ),
  rule(
    "OKM1519",
    "backward-incompatible",
    "error",
    "Renaming a column breaks queries that still use the old name.",
    (input) =>
      hit(
        matches(input.step, "rename-column", /^alter table\s+\S+\s+rename column\b/),
        "renames a column",
      ),
  ),
  rule(
    "OKM1523",
    "backward-incompatible",
    "error",
    "Renaming a table breaks queries that still use the old name.",
    (input) => hit(renamesTable(input.step), "renames a table"),
  ),
  rule(
    "OKM1524",
    "backward-incompatible",
    "error",
    "Changing a column type can break readers and writers.",
    (input) => typeChange(input, "incompatible"),
  ),
  rule(
    "OKM1525",
    "backward-incompatible",
    "error",
    "Adding NOT NULL without a default fails when the table already has rows.",
    (input) => hit(requiredColumn(input), "adds NOT NULL without a default"),
  ),
  rule(
    "OKM1526",
    "backward-incompatible",
    "error",
    "Removing a default breaks writers that omit the column.",
    (input) =>
      hit(
        matches(
          input.step,
          "drop-default",
          /^alter table\s+\S+\s+alter column\s+\S+\s+drop default\b/,
        ),
        "removes a default",
      ),
  ),
  rule(
    "OKM1527",
    "backward-incompatible",
    "error",
    "Shortening a character length rejects values that used to fit.",
    (input) => typeChange(input, "shrink"),
  ),
  rule(
    "OKM1528",
    "data-dependent",
    "error",
    "A new unique or primary key on an existing table fails when rows collide.",
    (input) => hit(uniqueConstraint(input), "builds a unique or primary key"),
  ),
  rule(
    "OKM1529",
    "data-dependent",
    "error",
    "A new unique index on an existing table fails when rows collide.",
    (input) => hit(uniqueIndex(input), "creates a unique index"),
  ),
  rule(
    "OKM1531",
    "data-dependent",
    "error",
    "A check that validates existing rows fails when a row does not pass.",
    (input) =>
      hit(
        validatingCheck(input),
        validatesUnvalidatedNotNull(input)
          ? "validates a NOT NULL constraint"
          : "validates a check",
      ),
  ),
  rule(
    "OKM1532",
    "data-dependent",
    "error",
    "A foreign key that validates existing rows fails when a row has no target.",
    (input) => hit(validatingForeignKey(input), "validates a foreign key"),
  ),
  rule(
    "OKM1533",
    "data-dependent",
    "error",
    "Narrowing an integer, float, or numeric type rejects values outside the new range.",
    (input) => typeChange(input, "narrow"),
  ),
  rule(
    "OKM1534",
    "locking",
    "error",
    "Creating an index on an existing table without CONCURRENTLY locks writes.",
    (input) => hit(blockingIndex(input), "creates an index without CONCURRENTLY"),
  ),
  rule(
    "OKM1535",
    "locking",
    "error",
    "Adding a check without NOT VALID locks the table while it scans.",
    (input) => hit(checkWithoutNotValid(input), "adds a check without NOT VALID"),
  ),
  rule(
    "OKM1536",
    "locking",
    "error",
    "Adding a foreign key without NOT VALID locks the table while it scans.",
    (input) => hit(foreignKeyWithoutNotValid(input), "adds a foreign key without NOT VALID"),
  ),
  rule(
    "OKM1537",
    "locking",
    "error",
    "SET NOT NULL locks the table while it scans for nulls.",
    (input) => hit(unsafeSetNotNull(input), "sets NOT NULL"),
  ),
  rule(
    "OKM1538",
    "locking",
    "warning",
    "A type change that rewrites the table locks it for the rewrite.",
    (input) => typeChange(input, "rewrite"),
  ),
  rule(
    "OKM1542",
    "data-dependent",
    "error",
    "A data statement outside backfill(), or DO or CALL, is not a migration step.",
    (input) => dataStatement(input.step),
  ),
  rule(
    "OKM1550",
    "destructive",
    "error",
    "Disabling row-level security, dropping a policy, creating or altering one that is not the emitted tenant predicate, granting BYPASSRLS, or changing the owner of a tenant table removes the rlsTenancy backstop.",
    (input) => weakensRls(input),
  ),
  rule(
    "OKM1551",
    "destructive",
    "error",
    "Transaction control inside a step commits or leaves the migration transaction.",
    (input) => {
      const word = transactionControl(input.step.sql);
      return word === undefined ? [] : [`contains ${word}`];
    },
  ),
  rule(
    "OKM1557",
    "locking",
    "error",
    "A committed step with no built-in probe and no declared probe cannot be resumed.",
    (input) =>
      hit(
        needsDeclaredProbe(input.step) && input.step.probe === undefined,
        "committed step has no probe",
      ),
  ),
  rule(
    "OKM1558",
    "locking",
    "error",
    "A probe must be one read-only SELECT on a committed step.",
    (input) => probeFindings(input.step),
  ),
];

/**
 * Type preferences. Warnings, read from the schema catalog by `okm check`.
 */
export const COLUMN_RULES: readonly ColumnRule[] = [
  {
    code: "OKM1539",
    category: "type-preference",
    severity: "warning",
    doc: "timestamp without time zone depends on the session time zone; use timestamptz.",
    check: (column) =>
      /^timestamp(?:\(\d+\))? without time zone$/.test(canonical(column.definition.dataType))
        ? "is timestamp without time zone"
        : undefined,
  },
  {
    code: "OKM1540",
    category: "type-preference",
    severity: "warning",
    doc: "varchar(n) can be text; a length check belongs in the application.",
    check: (column) =>
      /^character varying\(\d+\)$/.test(canonical(column.definition.dataType))
        ? "is varchar(n)"
        : undefined,
  },
  {
    code: "OKM1543",
    category: "type-preference",
    severity: "warning",
    doc: "serial and nextval defaults should be identity generated always.",
    check: (column) => (isSerial(column) ? "uses serial or nextval" : undefined),
  },
  {
    code: "OKM1544",
    category: "type-preference",
    severity: "warning",
    doc: "json should be jsonb, which is available on every supported Postgres.",
    check: (column) => (canonical(column.definition.dataType) === "json" ? "is json" : undefined),
  },
  {
    code: "OKM1545",
    category: "type-preference",
    severity: "warning",
    doc: "An identity that is not generated always differs from the repo default.",
    check: (column) =>
      column.definition.identity?.always === false ? "is generated by default" : undefined,
  },
];

function rule(
  code: string,
  category: StepRule["category"],
  severity: LintSeverity,
  doc: string,
  check: (input: StepInput) => readonly string[],
): StepRule {
  return { code, category, severity, doc, check };
}

function hit(matched: boolean, reason: string): readonly string[] {
  return matched ? [reason] : [];
}

/**
 * A committed step that the built-in probe cannot read.
 *
 * A backfill keeps its own checkpoint. A transactional step rolls back with
 * its history row. `statementOutsideTransaction` matches apply: a statement
 * Postgres cannot run inside a transaction is committed even when the header
 * still says it can share one.
 *
 * @param step - One plan step, or one statement of a step
 * @returns `true` when the step needs a `-- probe:` line
 */
function needsDeclaredProbe(step: PlanStep): boolean {
  if (step.action === "backfill" || step.backfill !== undefined) return false;
  const committed = !step.transactional || statementOutsideTransaction(step.sql);
  if (!committed) return false;
  return !postgresProbeParses(step.kind ?? "raw-sql", step.sql);
}

/**
 * Problems in a declared probe.
 *
 * An empty probe, a probe that is not one read-only `SELECT`, and a probe
 * on a step that never leaves the migration transaction are each a reason.
 *
 * @param step - One plan step
 * @returns One reason per problem
 */
function probeFindings(step: PlanStep): readonly string[] {
  if (step.probe === undefined) return [];
  const reasons: string[] = [];
  if (step.action === "backfill" || step.backfill !== undefined) {
    reasons.push("probe is on a backfill step");
  } else if (step.transactional && !statementOutsideTransaction(step.sql)) {
    reasons.push("probe is on a transactional step");
  }
  reasons.push(...probeTextProblems(step.probe));
  return reasons;
}

const WRITE_WORD = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "into",
  "truncate",
  "copy",
  "call",
]);

function probeTextProblems(probe: string): readonly string[] {
  if (probe.trim().length === 0) return ["probe is empty"];
  const statements = sqlStatements(probe);
  if (statements.length !== 1) return ["probe has more than one statement"];
  const statement = statements[0] ?? "";
  if (!isReadOnlySelect(statement)) return ["probe is not one read-only select"];
  return [];
}

function isReadOnlySelect(sql: string): boolean {
  if (!/^(?:select|with)\b/i.test(sql.trim())) return false;
  const words = sqlWords(sql);
  if (words.length === 0) return false;
  const head = words[0];
  if (head !== "select" && head !== "with") return false;
  if (head === "with" && !words.includes("select")) return false;
  for (const word of words) {
    if (WRITE_WORD.has(word)) return false;
  }
  return !locksRows(words);
}

function locksRows(words: readonly string[]): boolean {
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== "for") continue;
    const next = words[index + 1];
    if (next === "update" || next === "share") return true;
    if (next === "no" && words[index + 2] === "key" && words[index + 3] === "update") return true;
    if (next === "key" && words[index + 2] === "share") return true;
  }
  return false;
}

function sqlWords(sql: string): readonly string[] {
  const words: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === "'") {
      index = skipQuote(sql, index, "'");
      continue;
    }
    if (char === '"') {
      index = skipQuote(sql, index, '"');
      continue;
    }
    const dollar = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(index));
    if (dollar !== null) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, index + tag.length);
      index = close === -1 ? sql.length : close + tag.length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][\w$]*/.exec(sql.slice(index));
      if (match !== null) {
        words.push(match[0].toLowerCase());
        index += match[0].length;
        continue;
      }
    }
    index += 1;
  }
  return words;
}

function skipQuote(sql: string, index: number, quote: "'" | '"'): number {
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (sql[cursor] === quote) {
      if (sql[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return sql.length;
}

/**
 * Collapses whitespace and lowercases SQL outside quoted identifiers.
 *
 * @param sql - One statement
 * @returns The comparison form
 */
export function normalizedSql(sql: string): string {
  const collapsed = sql.trim().replace(/\s+/g, " ");
  let out = "";
  let quoted = false;
  for (const char of collapsed) {
    if (char === '"') {
      quoted = !quoted;
      out += char;
      continue;
    }
    out += quoted ? char : char.toLowerCase();
  }
  return out;
}

function weakensRls(input: StepInput): readonly string[] {
  const text = normalizedSql(input.step.sql);
  if (/\bdisable row level security\b/.test(text)) return ["disables row level security"];
  if (/\bno force row level security\b/.test(text)) return ["stops forcing row level security"];
  if (/^drop policy\b/.test(text)) return ["drops a policy"];
  const drifted = policyDrift(input, text);
  if (drifted !== undefined) return [drifted];
  if (/^(?:alter|create) (?:role|user)\b/.test(text) && /(?<!no)bypassrls\b/.test(text)) {
    return ["grants BYPASSRLS"];
  }
  if (changesTenantOwner(input, text)) return ["changes the owner of a tenant table"];
  return [];
}

/**
 * A create or alter policy on a tenant table that is not the emitted predicate.
 *
 * `USING (true)` and `WITH CHECK (true)` keep their own reasons. Any other
 * expression, an extra policy name, or `AS RESTRICTIVE` is the same rule.
 * A known policy may omit `WITH CHECK`. An alter that does not touch the
 * expression is left alone.
 */
function policyDrift(input: StepInput, text: string): string | undefined {
  const header = /^(create|alter) policy\s+(\S+)\s+on\s+(\S+)/.exec(text);
  const kind = header?.[1];
  const table = lastName(header?.[3]);
  if (kind === undefined || table === undefined) return undefined;
  if (!hasPolicy(input.before, table) && !hasPolicy(input.after, table)) return undefined;
  const name = lastName(header?.[2]) ?? "";
  const using = clause(text, "using");
  const check = clause(text, "with check");
  if (isTrue(using) || isTrue(check)) {
    return kind === "alter"
      ? "widens a policy to match every row"
      : "creates a policy that matches every row";
  }
  if (kind === "alter" && using === undefined && check === undefined) return undefined;
  const tenant = policyExpression(input, table, `${table}_tenant`);
  const unscoped = policyExpression(input, table, `${table}_unscoped_select`);
  const emitted =
    !/\bas restrictive\b/.test(text) &&
    (matchesEmitted(name, `${table}_tenant`, using, check, tenant) ||
      matchesEmitted(name, `${table}_unscoped_select`, using, check, unscoped));
  if (emitted) return undefined;
  return kind === "alter"
    ? "widens a policy away from the tenant predicate"
    : "creates a policy that is not the tenant predicate";
}

function matchesEmitted(
  name: string,
  expectedName: string,
  using: string | undefined,
  check: string | undefined,
  expression: string | undefined,
): boolean {
  if (name !== expectedName || expression === undefined || using === undefined) return false;
  if (!sameExpression(using, expression)) return false;
  return check === undefined || sameExpression(check, expression);
}

function sameExpression(found: string, expected: string): boolean {
  return found === expected || unwrap(found) === unwrap(expected);
}

function unwrap(expression: string): string {
  const body = expression.trim();
  if (!body.startsWith("(") || !body.endsWith(")")) return body;
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index === body.length - 1 ? body.slice(1, -1).trim() : body;
    }
  }
  return body;
}

function isTrue(expression: string | undefined): boolean {
  return expression !== undefined && expression.replaceAll(" ", "") === "(true)";
}

function clause(text: string, keyword: "using" | "with check"): string | undefined {
  const needle = keyword === "using" ? /\busing\s*\(/g : /\bwith check\s*\(/g;
  const found = needle.exec(text);
  if (found === null) return undefined;
  return parenthesized(text, found.index + found[0].length - 1);
}

function parenthesized(text: string, open: number): string | undefined {
  let depth = 0;
  let quoted = false;
  let single = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (single) {
      if (char === "'" && text[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (char === "'") single = false;
      continue;
    }
    if (quoted) {
      if (char === '"') quoted = false;
      continue;
    }
    if (char === "'") {
      single = true;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  return undefined;
}

function policyExpression(input: StepInput, table: string, name: string): string | undefined {
  const expression =
    expressionOf(input.after, table, name) ?? expressionOf(input.before, table, name);
  return expression === undefined ? undefined : normalizedSql(expression);
}

function expressionOf(source: Catalog, table: string, name: string): string | undefined {
  for (const object of source.objects) {
    if (object.kind !== "policy") continue;
    if (object.identity.parent.name !== table || object.identity.name !== name) continue;
    return object.definition.expression;
  }
  return undefined;
}

function changesTenantOwner(input: StepInput, text: string): boolean {
  const match = /^alter table\s+(\S+)\s+owner to\b/.exec(text);
  const table = lastName(match?.[1]);
  if (table === undefined) return false;
  return hasPolicy(input.before, table) || hasPolicy(input.after, table);
}

function hasPolicy(source: Catalog, table: string): boolean {
  return source.objects.some(
    (object) => object.kind === "policy" && object.identity.parent.name === table,
  );
}

function dataStatement(step: PlanStep): readonly string[] {
  const text = normalizedSql(step.sql);
  if (/^(?:do|call)\b/.test(text)) return ["the body is not analysed"];
  if (step.backfill !== undefined) return [];
  if (/^(?:insert|update|delete|merge|truncate)\b/.test(text)) {
    return ["changes rows outside backfill()"];
  }
  if (/^with\b/.test(text) && /\b(?:insert|update|delete|merge)\b/.test(text)) {
    return ["changes rows outside backfill()"];
  }
  return [];
}

function matches(step: PlanStep, kind: StepKind, pattern: RegExp): boolean {
  return pattern.test(normalizedSql(step.sql)) || step.kind === kind;
}

function renamesTable(step: PlanStep): boolean {
  const text = normalizedSql(step.sql);
  if (/^alter table\s+\S+\s+rename to\b/.test(text)) return true;
  return (
    step.kind === "rename-table" && !/^alter table\s+\S+\s+rename (column|constraint)\b/.test(text)
  );
}

function droppedType(input: StepInput): "enum" | "domain" | undefined {
  const text = normalizedSql(input.step.sql);
  const dropping = /^drop type\b/.test(text);
  if (!dropping && input.step.kind !== "drop-enum" && input.step.kind !== "drop-domain") {
    return undefined;
  }
  if (input.step.kind === "drop-domain") return "domain";
  if (input.step.kind === "drop-enum") return "enum";
  const name = lastName(/^drop type\s+(\S+)/.exec(text)?.[1]);
  const found = input.before.objects.find(
    (object): object is TypeObject => object.kind === "type" && object.identity.name === name,
  );
  if (found !== undefined && isDomain(found.definition)) return "domain";
  return "enum";
}

function requiredColumn(input: StepInput): boolean {
  const text = normalizedSql(input.step.sql);
  const adding =
    /^alter table\s+\S+\s+add column\b/.test(text) || input.step.kind === "add-column-required";
  if (!adding) return false;
  if (input.step.kind === "add-column") return false;
  if (!tableExists(input)) return false;
  if (input.step.kind === "add-column-required") return true;
  const body = text.replace(/^alter table\s+\S+\s+add column\s+/, "");
  return /\bnot null\b/.test(body) && !/\bdefault\b/.test(body) && !/\bgenerated\b/.test(body);
}

function uniqueConstraint(input: StepInput): boolean {
  if (!tableExists(input)) return false;
  const text = normalizedSql(input.step.sql);
  if (/\busing index\b/.test(text)) return false;
  if (/^alter table\s+\S+\s+add constraint\b/.test(text) && /\b(unique|primary key)\b/.test(text)) {
    return true;
  }
  if (!/^create unique index\b/.test(text)) return false;
  const name = createdIndexName(text);
  if (name === undefined) return false;
  return input.later.some((step) => usesIndex(normalizedSql(step.sql), name));
}

function uniqueIndex(input: StepInput): boolean {
  const text = normalizedSql(input.step.sql);
  if (!/^create unique index\b/.test(text)) return false;
  if (!tableExists(input)) return false;
  const name = createdIndexName(text);
  if (name !== undefined && input.later.some((step) => usesIndex(normalizedSql(step.sql), name))) {
    return false;
  }
  return !coveredByExistingUnique(input, name);
}

/**
 * Whether a unique index that already stands makes the new one safe.
 *
 * Rows that collide on every column of the new index also collide on any
 * subset of those columns. An existing unique index or key over such a
 * subset, with no narrower predicate, already forbids them. This is the
 * tenant-prefix upgrade: unique `(code)` becomes unique `(tenant_id, code)`.
 * The reverse, `(tenant_id, code)` to `(code)`, is not covered. A step that
 * dropped the existing one earlier in the plan does not count.
 */
function coveredByExistingUnique(input: StepInput, name: string | undefined): boolean {
  const table = statementTable(input.step);
  if (name === undefined || table === undefined) return false;
  const created = input.after.objects.find(
    (object) =>
      object.kind === "index" &&
      object.identity.name === name &&
      object.identity.parent.name === table,
  );
  if (created?.kind !== "index" || created.definition.expression !== undefined) return false;
  const columns = created.definition.columns;
  const covers = (held: readonly string[], predicate: string | undefined): boolean =>
    held.length > 0 &&
    held.every((column) => columns.includes(column)) &&
    (predicate === undefined || predicate === created.definition.predicate);
  for (const object of input.before.objects) {
    if (object.kind === "index") {
      const { unique, expression, columns: held, predicate } = object.definition;
      if (!unique || expression !== undefined || !covers(held, predicate)) continue;
    } else if (
      object.kind === "constraint" &&
      (object.definition.constraintKind === "unique" ||
        object.definition.constraintKind === "primaryKey")
    ) {
      if (!covers(object.definition.columns, undefined)) continue;
    } else {
      continue;
    }
    if (object.identity.parent.name !== table || object.identity.name === name) continue;
    if (droppedEarlier(input.earlier, object.identity.name)) continue;
    return true;
  }
  return false;
}

function droppedEarlier(earlier: readonly PlanStep[], name: string): boolean {
  return earlier.some((step) => {
    const text = normalizedSql(step.sql);
    return (
      /^(?:drop index|alter table .* drop constraint)\b/.test(text) && text.includes(`"${name}"`)
    );
  });
}

function createdIndexName(text: string): string | undefined {
  const match = /^create unique index (?:concurrently )?(?:"([^"]+)"|([a-z_][\w$]*))/.exec(text);
  return match?.[1] ?? match?.[2];
}

function usesIndex(text: string, name: string): boolean {
  return text.includes(`using index "${name}"`) || text.includes(`using index ${name}`);
}

function unsafeSetNotNull(input: StepInput): boolean {
  const text = normalizedSql(input.step.sql);
  const match = /^alter table\s+(\S+)\s+alter column\s+(\S+)\s+set not null\b/.exec(text);
  if (match === null && input.step.kind !== "set-not-null") return false;
  if (!tableExists(input)) return false;
  const table = match?.[1];
  const column = match?.[2];
  if (
    table !== undefined &&
    column !== undefined &&
    validatedNotNullCheck(input.earlier, table, column)
  ) {
    return false;
  }
  return true;
}

function validatedNotNullCheck(
  earlier: readonly PlanStep[],
  table: string,
  column: string,
): boolean {
  const needle = `check (${column} is not null) not valid`;
  for (const step of earlier) {
    const text = normalizedSql(step.sql);
    if (!text.startsWith(`alter table ${table} `) || !text.includes(needle)) continue;
    const added = /^alter table\s+\S+\s+add constraint\s+(\S+)\s+check\b/.exec(text);
    const name = added?.[1];
    if (name === undefined) continue;
    const validated = earlier.some((item) =>
      normalizedSql(item.sql).startsWith(`alter table ${table} validate constraint ${name}`),
    );
    if (validated) return true;
  }
  return false;
}

function blockingIndex(input: StepInput): boolean {
  const text = normalizedSql(input.step.sql);
  if (!/^create(?: unique)? index\b/.test(text) && input.step.kind !== "create-index") return false;
  if (/\bconcurrently\b/.test(text)) return false;
  return tableExists(input);
}

function checkWithoutNotValid(input: StepInput): boolean {
  return addedConstraint(input, "check") && !/\bnot valid\b/.test(normalizedSql(input.step.sql));
}

function foreignKeyWithoutNotValid(input: StepInput): boolean {
  return (
    addedConstraint(input, "foreign key") && !/\bnot valid\b/.test(normalizedSql(input.step.sql))
  );
}

function validatingCheck(input: StepInput): boolean {
  if (widenValidate(input)) return false;
  if (notNullFloorValidate(input)) return false;
  if (ownColumnCheckValidate(input)) return false;
  if (validates(input, "check")) return true;
  return checkWithoutNotValid(input);
}

/**
 * `VALIDATE` of the temporary `col IS NOT NULL` check from the safe rewrite.
 *
 * The documented type-change recipe and the planner both use that form before
 * `SET NOT NULL`. It is not OKM1531: the scan is intentional and paired with
 * the lock-safe sequence (B-36).
 */
function notNullFloorValidate(input: StepInput): boolean {
  const text = normalizedSql(input.step.sql);
  const name = /^alter table\s+(\S+)\s+validate constraint\s+(\S+)/.exec(text);
  if (name === null) return false;
  const table = name[1];
  const constraint = name[2];
  if (table === undefined || constraint === undefined) return false;
  return input.earlier.some((step) => {
    const prior = normalizedSql(step.sql);
    if (!prior.startsWith(`alter table ${table} `)) return false;
    if (!prior.includes(`add constraint ${constraint} `)) return false;
    const body = /check\s*\(\s*(\S+)\s+is not null\s*\)\s*not valid/.exec(prior);
    if (body === null) return false;
    // A column added in this migration is NULL on every existing row. That
    // check is the user's, not the temporary floor before SET NOT NULL.
    const column = lastName(body[1]);
    if (column !== undefined && columnAdded(input.earlier, table, column)) return false;
    return true;
  });
}

function columnAdded(earlier: readonly PlanStep[], tableSql: string, column: string): boolean {
  return addedColumn(earlier, tableSql, column) !== undefined;
}

/**
 * `VALIDATE` of a check whose column was added earlier in this migration.
 *
 * The planner pairs `ADD COLUMN` (constant default, or nullable with no
 * default) with `ADD CONSTRAINT … NOT VALID` then `VALIDATE`. Existing rows
 * only see the new column's default or null, so that scan is not OKM1531
 * when the default passes the check and NULL does not make it false. The
 * default and nullability come from the `ADD COLUMN` statement. A write on
 * that table after the add, a default in the statement that fails the check,
 * a nullable column whose check rejects NULL, a volatile default, or a check
 * on a column that already existed, stays an error (D301). The catalog
 * snapshot is not enough: a hand-written file can disagree with it.
 */
function ownColumnCheckValidate(input: StepInput): boolean {
  const text = normalizedSql(input.step.sql);
  const matched = /^alter table\s+(\S+)\s+validate constraint\s+(\S+)/.exec(text);
  if (matched === null) return false;
  const tableSql = matched[1];
  const constraintSql = matched[2];
  if (tableSql === undefined || constraintSql === undefined) return false;
  const tableName = lastName(tableSql);
  const constraintName = lastName(constraintSql);
  if (tableName === undefined || constraintName === undefined) return false;
  const paired = input.earlier.some((step) => {
    const prior = normalizedSql(step.sql);
    if (!prior.startsWith(`alter table ${tableSql} `)) return false;
    if (!prior.includes(`add constraint ${constraintSql} `)) return false;
    return /\bcheck\b/.test(prior) && /\bnot valid\b/.test(prior);
  });
  if (!paired) return false;
  const constraint = findConstraint(input.after, constraintName);
  if (constraint === undefined || constraint.definition.constraintKind !== "check") {
    return false;
  }
  const columns = constraint.definition.columns;
  if (columns.length === 0) return false;
  const expression = constraint.definition.expression ?? "";
  return columns.every((column) => ownColumnSafe(input, tableSql, column, expression));
}

/**
 * Whether one check column was added in this migration with a safe default.
 *
 * @param input - Step context with earlier SQL and the catalogs
 * @param tableSql - Qualified table token from the validate statement
 * @param column - Column the check names
 * @param expression - Check expression, without the `CHECK` keyword
 * @returns `true` when the add statement is a constant default or nullable and the check accepts that value
 */
function ownColumnSafe(
  input: StepInput,
  tableSql: string,
  column: string,
  expression: string,
): boolean {
  const added = addedColumn(input.earlier, tableSql, column);
  if (added === undefined) return false;
  if (writesTableAfter(input.earlier, tableSql, added.index)) return false;
  const shape = addedColumnShape(added.sql, column);
  if (shape === undefined || shape.generated) return false;
  if (volatileDefault(shape.defaultExpression, [input.before, input.after])) return false;
  if (shape.defaultExpression !== undefined) {
    return !defaultViolatesCheck(column, shape.defaultExpression, expression);
  }
  if (!shape.nullable) return false;
  return !checkRejectsNull(column, expression);
}

/**
 * The `ADD COLUMN` for `column` on `tableSql`, using the statement text.
 *
 * @param earlier - Steps before `VALIDATE`
 * @param tableSql - Table token from that statement
 * @param column - Column the check names
 * @returns The last matching add, or `undefined` when this migration did not add it
 */
function addedColumn(
  earlier: readonly PlanStep[],
  tableSql: string,
  column: string,
): { readonly index: number; readonly sql: string } | undefined {
  let found: { readonly index: number; readonly sql: string } | undefined;
  earlier.forEach((step, index) => {
    const prior = normalizedSql(step.sql);
    const match = /^alter table\s+(\S+)\s+add column(?:\s+if not exists)?\s+(\S+)\b/.exec(prior);
    if (match === null || match[1] !== tableSql) return;
    if (lastName(match[2]) !== column) return;
    found = { index, sql: prior };
  });
  return found;
}

/**
 * Whether a later statement can store a value other than the column default.
 *
 * `INSERT`, `UPDATE`, and `DELETE` on the same table token count. A write
 * before the add does not: the column is not there yet.
 *
 * @param earlier - Steps before `VALIDATE`
 * @param tableSql - Table token from the add
 * @param addedAt - Index of that add in `earlier`
 * @returns `true` when a row written in the gap can fail the check
 */
function writesTableAfter(
  earlier: readonly PlanStep[],
  tableSql: string,
  addedAt: number,
): boolean {
  return earlier.slice(addedAt + 1).some((step) => writesTable(normalizedSql(step.sql), tableSql));
}

function writesTable(sql: string, tableSql: string): boolean {
  const update = /^update\s+(?:only\s+)?(\S+)/.exec(sql);
  if (update?.[1] === tableSql) return true;
  const insert = /^insert\s+into\s+(\S+)/.exec(sql);
  if (insert?.[1] === tableSql) return true;
  const removed = /^delete\s+from\s+(?:only\s+)?(\S+)/.exec(sql);
  return removed?.[1] === tableSql;
}

type AddedShape = {
  readonly nullable: boolean;
  readonly defaultExpression: string | undefined;
  readonly generated: boolean;
};

/**
 * Nullability and default from an `ADD COLUMN` statement.
 *
 * Postgres's column grammar allows the constraints in any order. A generated
 * column is not a constant default. Unparsed text is `undefined`, and the
 * caller then keeps OKM1531.
 *
 * @param sql - Normalised `ADD COLUMN` statement
 * @param column - Column name the check uses
 * @returns The shape, or `undefined` when the statement does not parse
 */
function addedColumnShape(sql: string, column: string): AddedShape | undefined {
  const match = /^alter table\s+\S+\s+add column(?:\s+if not exists)?\s+(\S+)\s+([\s\S]+)$/.exec(
    sql,
  );
  if (match === null || lastName(match[1]) !== column) return undefined;
  const tail = match[2]?.trim().replace(/;$/, "").trim();
  if (tail === undefined || tail.length === 0) return undefined;
  return columnShape(tail);
}

function columnShape(tail: string): AddedShape | undefined {
  let nullable = true;
  let defaultExpression: string | undefined;
  let generated = false;
  let index = 0;
  let depth = 0;
  while (index < tail.length) {
    const char = tail[index] ?? "";
    if (char === "'") {
      const next = closeQuote(tail, index, "'");
      if (next === undefined) return undefined;
      index = next;
      continue;
    }
    if (char === '"') {
      const next = closeQuote(tail, index, '"');
      if (next === undefined) return undefined;
      index = next;
      continue;
    }
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) return undefined;
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth === 0 && isWordStart(char)) {
      const word = readWord(tail, index);
      const after = index + word.length;
      if (word === "not" && peekWord(tail, after) === "null") {
        nullable = false;
        index = afterWord(tail, after);
        continue;
      }
      if (word === "null") {
        nullable = true;
        index = after;
        continue;
      }
      if (word === "default") {
        const expression = readDefaultExpression(tail, after);
        if (expression === undefined) return undefined;
        defaultExpression = expression.expression;
        index = expression.next;
        continue;
      }
      if (word === "generated") {
        generated = true;
        index = after;
        continue;
      }
      if (word === "primary") {
        nullable = false;
        index = after;
        continue;
      }
      if (word === "collate" || word === "constraint") {
        const name = skipName(tail, after);
        if (name === undefined) return undefined;
        index = name;
        continue;
      }
      index = after;
      continue;
    }
    index += 1;
  }
  if (depth !== 0) return undefined;
  if (generated) return { nullable: false, defaultExpression: undefined, generated: true };
  return { nullable, defaultExpression, generated: false };
}

function readDefaultExpression(
  sql: string,
  start: number,
): { readonly expression: string; readonly next: number } | undefined {
  let index = start;
  while (sql[index] === " ") index += 1;
  const begin = index;
  let depth = 0;
  let consumed = false;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "'") {
      const next = closeQuote(sql, index, "'");
      if (next === undefined) return undefined;
      index = next;
      consumed = true;
      continue;
    }
    if (char === '"') {
      const next = closeQuote(sql, index, '"');
      if (next === undefined) return undefined;
      index = next;
      consumed = true;
      continue;
    }
    if (char === "(") {
      depth += 1;
      index += 1;
      consumed = true;
      continue;
    }
    if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
      index += 1;
      continue;
    }
    if (char === "$") {
      const next = closeDollar(sql, index);
      if (next !== undefined) {
        index = next;
        consumed = true;
        continue;
      }
    }
    if (depth === 0 && isWordStart(char)) {
      const word = readWord(sql, index);
      const after = index + word.length;
      if (word === "not" && peekWord(sql, after) === "null") {
        if (!consumed) return undefined;
        break;
      }
      if (!consumed && word === "null") {
        index = after;
        break;
      }
      if (consumed && constraintWord(word, sql, after)) break;
      index = after;
      consumed = true;
      continue;
    }
    index += 1;
    if (char !== " ") consumed = true;
  }
  const expression = sql.slice(begin, index).trim();
  if (expression.length === 0) return undefined;
  return { expression, next: index };
}

function constraintWord(word: string, sql: string, after: number): boolean {
  if (word === "not") return peekWord(sql, after) === "null";
  return (
    word === "null" ||
    word === "default" ||
    word === "generated" ||
    word === "check" ||
    word === "unique" ||
    word === "primary" ||
    word === "references" ||
    word === "collate" ||
    word === "constraint"
  );
}

function closeQuote(sql: string, index: number, quote: "'" | '"'): number | undefined {
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (sql[cursor] === quote) {
      if (sql[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return undefined;
}

function closeDollar(sql: string, index: number): number | undefined {
  const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(index));
  const token = tag?.[0];
  if (token === undefined) return undefined;
  const close = sql.indexOf(token, index + token.length);
  if (close < 0) return undefined;
  return close + token.length;
}

function skipName(sql: string, start: number): number | undefined {
  let index = start;
  while (sql[index] === " ") index += 1;
  const char = sql[index];
  if (char === '"') return closeQuote(sql, index, '"');
  if (char !== undefined && isWordStart(char)) return index + readWord(sql, index).length;
  return undefined;
}

function peekWord(sql: string, start: number): string | undefined {
  let index = start;
  while (sql[index] === " ") index += 1;
  const char = sql[index];
  if (char === undefined || !isWordStart(char)) return undefined;
  return readWord(sql, index);
}

function afterWord(sql: string, start: number): number {
  let index = start;
  while (sql[index] === " ") index += 1;
  const char = sql[index];
  if (char === undefined || !isWordStart(char)) return index;
  return index + readWord(sql, index).length;
}

function readWord(sql: string, index: number): string {
  let cursor = index + 1;
  while (cursor < sql.length && /[\w$]/.test(sql[cursor] ?? "")) cursor += 1;
  return sql.slice(index, cursor);
}

function isWordStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

/**
 * `VALIDATE CONSTRAINT` of a NOT NULL constraint the before-catalog holds
 * unvalidated (PostgreSQL 18 `NOT NULL … NOT VALID`).
 *
 * The planner emits it when the schema says NOT NULL. Stored NULLs make it
 * fail, so it stays OKM1531 with its own reason.
 */
function validatesUnvalidatedNotNull(input: StepInput): boolean {
  const text = normalizedSql(input.step.sql);
  const token = /^alter table\s+\S+\s+validate constraint\s+(\S+)/.exec(text)?.[1];
  const name = token === undefined ? undefined : lastName(token);
  if (name === undefined) return false;
  return input.before.objects.some(
    (object) => object.kind === "column" && object.definition.unvalidatedNotNull === name,
  );
}

function widenValidate(input: StepInput): boolean {
  const text = normalizedSql(input.step.sql);
  if (!/^alter table\s+\S+\s+validate constraint\b/.test(text)) return false;
  if (input.step.kind === "widen-check") return true;
  const name = /^alter table\s+\S+\s+validate constraint\s+(\S+)/.exec(text)?.[1];
  if (name === undefined) return false;
  return input.earlier.some((step) => {
    if (step.kind !== "widen-check") return false;
    const prior = normalizedSql(step.sql);
    return prior.includes(`add constraint ${name} `);
  });
}

function validatingForeignKey(input: StepInput): boolean {
  if (validates(input, "foreignKey")) return true;
  return foreignKeyWithoutNotValid(input);
}

function addedConstraint(input: StepInput, kind: "check" | "foreign key"): boolean {
  if (!tableExists(input)) return false;
  const text = normalizedSql(input.step.sql);
  if (!/^alter table\s+\S+\s+add constraint\b/.test(text)) return false;
  return new RegExp(`\\b${kind}\\b`).test(text);
}

function validates(input: StepInput, kind: "check" | "foreignKey"): boolean {
  const text = normalizedSql(input.step.sql);
  const table = /^alter table\s+\S+\s+validate constraint\s+(\S+)/.exec(text);
  if (table !== null) {
    const token = table[1];
    if (token === undefined) return kind === "check";
    const name = lastName(token);
    if (name === undefined) return kind === "check";
    const constraint = findConstraint(input.after, name);
    if (constraint === undefined) return kind === "check";
    return constraint.definition.constraintKind === kind;
  }
  if (kind === "check" && /^alter domain\s+\S+\s+validate constraint\b/.test(text)) return true;
  return false;
}

const TYPE_CHANGE = /^alter table\s+(\S+)\s+alter column\s+(\S+)\s+(?:set data type|type)\b/;

function typeChange(
  input: StepInput,
  mode: "incompatible" | "shrink" | "narrow" | "rewrite",
): readonly string[] {
  const text = normalizedSql(input.step.sql);
  const changing = TYPE_CHANGE.test(text) || input.step.kind === "set-column-type";
  if (!changing) return [];
  const compared = columnTypes(input);
  if (compared === undefined) {
    if (mode === "incompatible" || mode === "rewrite") return ["changes a column type"];
    return [];
  }
  const { before, after } = compared;
  if (before === after) return [];
  const shrink = lengthShrink(before, after);
  if (mode === "shrink") return shrink ? ["shortens a character length"] : [];
  if (shrink) {
    return mode === "rewrite" && tableRewrites(before, after, input) ? ["rewrites the table"] : [];
  }
  if (mode === "narrow") return narrows(before, after) ? ["narrows a type"] : [];
  if (lengthGrow(before, after) && mode !== "rewrite") return [];
  if (mode === "incompatible") return ["changes a column type"];
  return tableRewrites(before, after, input) ? ["rewrites the table"] : [];
}

function columnTypes(
  input: StepInput,
): { readonly before: string; readonly after: string } | undefined {
  const text = normalizedSql(input.step.sql);
  const match = TYPE_CHANGE.exec(text);
  const table = lastName(match?.[1]);
  const column = lastName(match?.[2]);
  if (table === undefined || column === undefined) return undefined;
  const previous = findColumn(input.before, table, column);
  const next = findColumn(input.after, table, column);
  if (previous === undefined || next === undefined) return undefined;
  return {
    before: canonical(previous.definition.dataType),
    after: canonical(next.definition.dataType),
  };
}

function lengthShrink(before: string, after: string): boolean {
  const left = charLength(before);
  const right = charLength(after);
  return (
    left !== undefined &&
    right !== undefined &&
    left.family === right.family &&
    right.length < left.length
  );
}

function lengthGrow(before: string, after: string): boolean {
  const left = charLength(before);
  const right = charLength(after);
  return (
    left !== undefined &&
    right !== undefined &&
    left.family === right.family &&
    right.length > left.length
  );
}

/**
 * Whether Postgres rewrites the heap for this type change (D276).
 *
 * A `USING` expression that is not a plain cast always rewrites. The other
 * exceptions are the ones `ATColumnChangeRequiresRewrite` skips: a
 * binary-coercible change, `varchar(n)` widening, `varchar` to `text`, a
 * numeric precision increase at the same scale, and an unconstrained domain
 * over the old type. `timestamp` to `timestamptz` rewrites unless `TimeZone`
 * is UTC, and this function does not connect, so that pair stays a rewrite.
 *
 * @param before - Canonical type before the statement
 * @param after - Canonical type after the statement
 * @param input - The step and the catalogs
 * @returns `true` when `pg_class.relfilenode` changes
 */
function tableRewrites(before: string, after: string, input: StepInput): boolean {
  if (usingRewrites(input)) return true;
  if (varyingRelaxation(before, after)) return false;
  if (isVarying(before) && after === "text") return false;
  if (before === "text" && unconstrainedVarying(after)) return false;
  if ((before === "text" || isVarying(before)) && unconstrainedCharacter(after)) return false;
  if (numericRelaxation(before, after)) return false;
  if (binaryPair(before, after)) return false;
  if (domainSkipsRewrite(before, after, input)) return false;
  return true;
}

/**
 * A create or alter of a domain, or a `LANGUAGE sql` function.
 *
 * Offline lint cannot see the reprint. The allow is still for that statement.
 * `okm migrate check` decides whether the text actually differs.
 *
 * @param sql - One statement
 * @returns `true` when OKM1552 can fire for this statement
 */
export function statementMayReprint(sql: string): boolean {
  const text = normalizedSql(sql);
  if (/^(?:create|alter) domain\b/.test(text)) return true;
  return /^create(?: or replace)? function\b/.test(text) && /\blanguage sql\b/.test(text);
}

function usingRewrites(input: StepInput): boolean {
  const text = normalizedSql(input.step.sql);
  const at = text.search(/\busing\b/);
  if (at < 0) return false;
  const column = lastName(TYPE_CHANGE.exec(text)?.[2]);
  if (column === undefined) return true;
  const expression = text
    .slice(at + "using".length)
    .trim()
    .replace(/;$/, "");
  return !plainCast(expression, column);
}

function plainCast(expression: string, column: string): boolean {
  const bare = column.toLowerCase();
  const quoted = `"${column}"`;
  return (
    expression.startsWith(`${bare}::`) ||
    expression.startsWith(`${quoted}::`) ||
    expression.startsWith(`cast(${bare} as `) ||
    expression.startsWith(`cast(${quoted} as `)
  );
}

function isVarying(type: string): boolean {
  return (
    type === "character varying" ||
    type === "varchar" ||
    type.startsWith("character varying(") ||
    type.startsWith("varchar(")
  );
}

function unconstrainedVarying(type: string): boolean {
  return type === "character varying" || type === "varchar";
}

function unconstrainedCharacter(type: string): boolean {
  return type === "bpchar" || type === "character";
}

function varyingRelaxation(before: string, after: string): boolean {
  const left = charLength(before);
  if (left?.family === "varying" && unconstrainedVarying(after)) return true;
  const right = charLength(after);
  return left?.family === "varying" && right?.family === "varying" && right.length > left.length;
}

function numericRelaxation(before: string, after: string): boolean {
  const left = numericBounds(before);
  const right = numericBounds(after);
  if (left === undefined || right === undefined) return false;
  if (right.precision === undefined) return left.precision !== undefined;
  if (left.precision === undefined || left.scale === undefined || right.scale === undefined) {
    return false;
  }
  return right.scale === left.scale && right.precision > left.precision;
}

function numericBounds(
  type: string,
): { readonly precision: number | undefined; readonly scale: number | undefined } | undefined {
  const match = /^numeric(?:\((\d+)(?:,(\d+))?\))?$/.exec(type);
  if (match === null) return undefined;
  if (match[1] === undefined) return { precision: undefined, scale: undefined };
  return {
    precision: Number(match[1]),
    scale: match[2] === undefined ? 0 : Number(match[2]),
  };
}

function binaryPair(before: string, after: string): boolean {
  if (before === "integer" && after === "oid") return true;
  if (before === "oid" && after === "integer") return true;
  if (before === "cidr" && after === "inet") return true;
  return before === "xml" && after === "text";
}

function domainSkipsRewrite(before: string, after: string, input: StepInput): boolean {
  const next = domainNamed(input, after);
  if (next !== undefined && next.check.trim().length === 0 && canonical(next.base) === before) {
    return true;
  }
  const previous = domainNamed(input, before);
  return previous !== undefined && canonical(previous.base) === after;
}

function domainNamed(
  input: StepInput,
  name: string,
): { readonly base: string; readonly check: string } | undefined {
  for (const source of [input.after, input.before]) {
    for (const object of source.objects) {
      if (object.kind !== "type" || object.identity.name !== name) continue;
      if (!isDomain(object.definition)) continue;
      return object.definition;
    }
  }
  return undefined;
}

function narrows(before: string, after: string): boolean {
  const leftInt = INTEGER_WIDTH[before];
  const rightInt = INTEGER_WIDTH[after];
  if (leftInt !== undefined && rightInt !== undefined) return rightInt < leftInt;
  const leftFloat = FLOAT_WIDTH[before];
  const rightFloat = FLOAT_WIDTH[after];
  if (leftFloat !== undefined && rightFloat !== undefined) return rightFloat < leftFloat;
  const left = numericSpec(before);
  const right = numericSpec(after);
  if (left === undefined || right === undefined) return false;
  return right.precision < left.precision || right.scale < left.scale;
}

function charLength(
  type: string,
): { readonly family: "varying" | "fixed"; readonly length: number } | undefined {
  const varying = /^character varying\((\d+)\)$/.exec(type);
  if (varying?.[1] !== undefined) return { family: "varying", length: Number(varying[1]) };
  const fixed = /^character\((\d+)\)$/.exec(type);
  if (fixed?.[1] !== undefined) return { family: "fixed", length: Number(fixed[1]) };
  return undefined;
}

function numericSpec(
  type: string,
): { readonly precision: number; readonly scale: number } | undefined {
  const match = /^numeric(?:\((\d+)(?:,(\d+))?\))?$/.exec(type);
  if (match === null) return undefined;
  if (match[1] === undefined) return { precision: 1000, scale: 0 };
  return {
    precision: Number(match[1]),
    scale: match[2] === undefined ? 0 : Number(match[2]),
  };
}

function tableExists(input: StepInput): boolean {
  const name = statementTable(input.step);
  return name !== undefined && input.existingTables.has(name);
}

function statementTable(step: PlanStep): string | undefined {
  const text = normalizedSql(step.sql);
  const altered = /^(?:alter|drop) table\s+(\S+)/.exec(text);
  if (altered?.[1] !== undefined) return lastName(altered[1]);
  const index = /^create(?: unique)? index(?: concurrently)?\s+\S+\s+on\s+(\S+)/.exec(text);
  return lastName(index?.[1]);
}

function lastName(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  const parts = [...token.matchAll(/"(?:[^"]|"")*"|[A-Za-z_][\w$]*/g)];
  const last = parts.at(-1)?.[0];
  if (last === undefined) return undefined;
  if (last.startsWith('"')) return last.slice(1, -1).replaceAll('""', '"');
  return last;
}

function findColumn(source: Catalog, table: string, name: string): ColumnObject | undefined {
  return source.objects.find(
    (object): object is ColumnObject =>
      object.kind === "column" &&
      object.identity.parent.name === table &&
      object.identity.name === name,
  );
}

function findConstraint(source: Catalog, name: string): ConstraintObject | undefined {
  return source.objects.find(
    (object): object is ConstraintObject =>
      object.kind === "constraint" && object.identity.name === name,
  );
}

function canonical(typeName: string): string {
  return canonicalTypeName(typeName);
}

function isSerial(column: ColumnObject): boolean {
  const typeName = column.definition.dataType.toLowerCase();
  if (typeName === "serial" || typeName === "smallserial" || typeName === "bigserial") return true;
  if (column.definition.identity !== undefined) return false;
  return /nextval\s*\(/i.test(column.definition.defaultExpression ?? "");
}
