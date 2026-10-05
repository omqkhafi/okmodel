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
import type { PlanStep, StepKind } from "./plan.js";
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
 * Locking rules are warnings until the planner emits the safe form.
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
    (input) => hit(uniqueConstraint(input), "adds a unique constraint"),
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
    (input) => hit(validatingCheck(input), "validates a check"),
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
    "warning",
    "Creating an index on an existing table without CONCURRENTLY locks writes.",
    (input) => hit(blockingIndex(input), "creates an index without CONCURRENTLY"),
  ),
  rule(
    "OKM1535",
    "locking",
    "warning",
    "Adding a check without NOT VALID locks the table while it scans.",
    (input) => hit(checkWithoutNotValid(input), "adds a check without NOT VALID"),
  ),
  rule(
    "OKM1536",
    "locking",
    "warning",
    "Adding a foreign key without NOT VALID locks the table while it scans.",
    (input) => hit(foreignKeyWithoutNotValid(input), "adds a foreign key without NOT VALID"),
  ),
  rule(
    "OKM1537",
    "locking",
    "warning",
    "SET NOT NULL locks the table while it scans for nulls.",
    (input) =>
      hit(
        matches(
          input.step,
          "set-not-null",
          /^alter table\s+\S+\s+alter column\s+\S+\s+set not null\b/,
        ),
        "sets NOT NULL",
      ),
  ),
  rule(
    "OKM1538",
    "locking",
    "warning",
    "A type change that rewrites the table locks it for the rewrite.",
    (input) => typeChange(input, "rewrite"),
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

function normalized(sql: string): string {
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

function matches(step: PlanStep, kind: StepKind, pattern: RegExp): boolean {
  return pattern.test(normalized(step.sql)) || step.kind === kind;
}

function renamesTable(step: PlanStep): boolean {
  const text = normalized(step.sql);
  if (/^alter table\s+\S+\s+rename to\b/.test(text)) return true;
  return (
    step.kind === "rename-table" && !/^alter table\s+\S+\s+rename (column|constraint)\b/.test(text)
  );
}

function droppedType(input: StepInput): "enum" | "domain" | undefined {
  const text = normalized(input.step.sql);
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
  const text = normalized(input.step.sql);
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
  const text = normalized(input.step.sql);
  if (!/^alter table\s+\S+\s+add constraint\b/.test(text) && input.step.kind !== "add-constraint") {
    return false;
  }
  return /\b(unique|primary key)\b/.test(text);
}

function uniqueIndex(input: StepInput): boolean {
  const text = normalized(input.step.sql);
  if (!/^create unique index\b/.test(text)) return false;
  return tableExists(input);
}

function blockingIndex(input: StepInput): boolean {
  const text = normalized(input.step.sql);
  if (!/^create(?: unique)? index\b/.test(text) && input.step.kind !== "create-index") return false;
  if (/\bconcurrently\b/.test(text)) return false;
  return tableExists(input);
}

function checkWithoutNotValid(input: StepInput): boolean {
  return addedConstraint(input, "check") && !/\bnot valid\b/.test(normalized(input.step.sql));
}

function foreignKeyWithoutNotValid(input: StepInput): boolean {
  return addedConstraint(input, "foreign key") && !/\bnot valid\b/.test(normalized(input.step.sql));
}

function validatingCheck(input: StepInput): boolean {
  if (validates(input, "check")) return true;
  return checkWithoutNotValid(input);
}

function validatingForeignKey(input: StepInput): boolean {
  if (validates(input, "foreignKey")) return true;
  return foreignKeyWithoutNotValid(input);
}

function addedConstraint(input: StepInput, kind: "check" | "foreign key"): boolean {
  if (!tableExists(input)) return false;
  const text = normalized(input.step.sql);
  if (!/^alter table\s+\S+\s+add constraint\b/.test(text)) return false;
  return new RegExp(`\\b${kind}\\b`).test(text);
}

function validates(input: StepInput, kind: "check" | "foreignKey"): boolean {
  const text = normalized(input.step.sql);
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

function typeChange(
  input: StepInput,
  mode: "incompatible" | "shrink" | "narrow" | "rewrite",
): readonly string[] {
  const text = normalized(input.step.sql);
  const changing =
    /^alter table\s+\S+\s+alter column\s+\S+\s+set data type\b/.test(text) ||
    input.step.kind === "set-column-type";
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
  if (shrink) return [];
  if (mode === "narrow") return narrows(before, after) ? ["narrows a type"] : [];
  if (lengthGrow(before, after)) return [];
  if (mode === "incompatible") return ["changes a column type"];
  return rewrites(before, after) ? ["rewrites the table"] : [];
}

function columnTypes(
  input: StepInput,
): { readonly before: string; readonly after: string } | undefined {
  const text = normalized(input.step.sql);
  const match = /^alter table\s+(\S+)\s+alter column\s+(\S+)\s+set data type\b/.exec(text);
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

function rewrites(before: string, after: string): boolean {
  if (lengthShrink(before, after) || lengthGrow(before, after)) return false;
  if (isCharacter(before) && after === "text") return false;
  return true;
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

function isCharacter(type: string): boolean {
  return type === "text" || charLength(type) !== undefined;
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
  const text = normalized(step.sql);
  const altered = /^(?:alter|drop) table\s+(\S+)/.exec(text);
  if (altered?.[1] !== undefined) return lastName(altered[1]);
  const index = /^create(?: unique)? index\s+\S+\s+on\s+(\S+)/.exec(text);
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
