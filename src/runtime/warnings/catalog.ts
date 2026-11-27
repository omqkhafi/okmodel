/**
 * Static warning rules (OKM2xxx).
 *
 * The code number is the type. The level is configuration. A code is never
 * reused or renumbered. This module is the sentence source for the doctor
 * pages. It is not on the runtime entry.
 */

/** `off` reports nothing. `error` throws. `hint` and `warn` report. */
export type WarningLevel = "off" | "hint" | "warn" | "error";

/** How serious a rule is before a project overrides its level. */
export type WarningSeverity = "low" | "medium" | "high";

/** When a rule is evaluated. */
export type WarningPhase = "build" | "check" | "dev-runtime" | "production-runtime";

/** Whether the rule reads the query or a later observation. */
export type WarningEvidence = "static" | "observed";

/**
 * One call-site or project ignore. `reason` is required.
 *
 * `target` narrows a project ignore of a `check` rule to one table
 * (`orders`) or one column (`orders.user_id`). Without it the ignore covers
 * every finding of the rule.
 */
export type WarningIgnore = {
  readonly rule: string;
  readonly reason: string;
  readonly target?: string;
};

/** One safe alternative, in the same shape as an error page. */
export type WarningAlternative = {
  readonly text: string;
  readonly docs: string;
};

/** One escape hatch. A person writes the reason. */
export type WarningHatch = {
  readonly name: string;
  readonly requiresHumanReason: true;
  readonly docs: string;
};

/** One registered rule. */
export type WarningRule = {
  readonly code: string;
  readonly rule: string;
  readonly title: string;
  readonly summary: string;
  readonly fix: string;
  readonly defaultLevel: WarningLevel;
  readonly severity: WarningSeverity;
  readonly phase: WarningPhase;
  readonly evidence: WarningEvidence;
  readonly safeAlternatives: readonly WarningAlternative[];
  readonly escapeHatches: readonly WarningHatch[];
};

/** Offsets above this many rows are OKM2004. */
export const OFFSET_LIMIT = 1000;

/** Value lists above this many elements are OKM2007. */
export const LIST_LIMIT = 500;

/** Include products above this many rows are OKM2008. */
export const FANOUT_LIMIT = 10_000;

/**
 * One safe alternative pointing at the page section.
 *
 * @param code - Spec code
 * @param text - What to do instead
 * @returns The alternative
 */
function alt(code: string, text: string): WarningAlternative {
  return { text, docs: `docs/errors/${code}.md#page` };
}

/**
 * The ignore hatch. The reason is required wherever the hatch is used.
 *
 * @param code - Spec code
 * @returns The hatch
 */
function hatch(code: string): WarningHatch {
  return { name: "ignore", requiresHumanReason: true, docs: `docs/errors/${code}.md#escape` };
}

/**
 * Registered rules, in numeric order.
 *
 * 2000–2099 is query behaviour. 2100–2199 is schema, read by `okm check`.
 * 2200–2299 is operations.
 */
export const WARNING_RULES: readonly WarningRule[] = [
  {
    code: "OKM2004",
    rule: "deep-offset",
    title: "Deep offset",
    summary: "An offset past 1,000 rows makes the database scan every skipped row.",
    fix: "Use page() with a cursor.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "dev-runtime",
    evidence: "static",
    safeAlternatives: [alt("OKM2004", "Use page() with a cursor.")],
    escapeHatches: [hatch("OKM2004")],
  },
  {
    code: "OKM2005",
    rule: "unordered-limit",
    title: "Unordered limit",
    summary:
      "A limit whose order does not end in a unique key can return a different row set each time. Under for(), the tenant key is ignored, so the rest of that unique counts.",
    fix: "End orderBy with the primary key or a unique column.",
    defaultLevel: "warn",
    severity: "high",
    phase: "dev-runtime",
    evidence: "static",
    safeAlternatives: [alt("OKM2005", "End orderBy with the primary key or a unique column.")],
    escapeHatches: [hatch("OKM2005")],
  },
  {
    code: "OKM2007",
    rule: "large-in-list",
    title: "Large value list",
    summary: "A value list longer than 500 elements sends one parameter per element.",
    fix: "Filter with = any(array) so the list is one parameter.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "dev-runtime",
    evidence: "static",
    safeAlternatives: [alt("OKM2007", "Filter with = any(array) so the list is one parameter.")],
    escapeHatches: [hatch("OKM2007")],
  },
  {
    code: "OKM2008",
    rule: "wide-fan-out",
    title: "Wide fan-out",
    summary: "An include multiplies the parent limit by nested limits past 10,000 rows.",
    fix: "Lower the parent limit or an include limit.",
    defaultLevel: "warn",
    severity: "high",
    phase: "dev-runtime",
    evidence: "static",
    safeAlternatives: [alt("OKM2008", "Lower the parent limit or an include limit.")],
    escapeHatches: [hatch("OKM2008")],
  },
  {
    code: "OKM2011",
    rule: "default-limit-reached",
    title: "Default limit reached",
    summary:
      "A read that used a default limit from connect returned exactly that many rows, so more rows may exist.",
    fix: "Pass a limit that fits the call, or use page() with a cursor.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "dev-runtime",
    evidence: "observed",
    safeAlternatives: [
      alt("OKM2011", "Pass a limit that fits the call."),
      alt("OKM2011", "Use page() with a cursor."),
      alt("OKM2011", "Call .all(reason) when every row is needed."),
    ],
    escapeHatches: [hatch("OKM2011")],
  },
  {
    code: "OKM2012",
    rule: "unindexed-computed-key",
    title: "Computed key without an index",
    summary:
      "A computed aggregate groups the related table by its foreign key, and no declared index starts with that key, so each read scans the related table.",
    fix: "Declare an index that starts with the foreign key columns.",
    defaultLevel: "hint",
    severity: "low",
    phase: "dev-runtime",
    evidence: "static",
    safeAlternatives: [
      alt("OKM2012", "Declare an index that starts with the foreign key columns."),
    ],
    escapeHatches: [hatch("OKM2012")],
  },
  {
    code: "OKM2101",
    rule: "unindexed-foreign-key",
    title: "Foreign key without an index",
    summary:
      "No index starts with the columns of this foreign key, so a parent delete or key change scans the child table.",
    fix: "Add an index that starts with the foreign key columns.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2101", "Add an index that starts with the foreign key columns.")],
    escapeHatches: [hatch("OKM2101")],
  },
  {
    code: "OKM2102",
    rule: "table-without-primary-key",
    title: "Table without a primary key",
    summary: "A table with no primary key has no stable row identity for updates and deletes.",
    fix: "Declare a primary key on the table.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2102", "Declare a primary key on the table.")],
    escapeHatches: [hatch("OKM2102")],
  },
  {
    code: "OKM2103",
    rule: "unindexed-filter-column",
    title: "Filter or sort column without an index",
    summary:
      "Callers can filter or sort by this column and no index starts with it, so each read scans the table.",
    fix: "Add an index that starts with the column, or remove the column from the allowlist or preset.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [
      alt("OKM2103", "Add an index that starts with the column."),
      alt("OKM2103", "Remove the column from the filters allowlist, the sort list, or the preset."),
    ],
    escapeHatches: [hatch("OKM2103")],
  },
  {
    code: "OKM2104",
    rule: "duplicate-index",
    title: "Duplicate index",
    summary: "Two indexes on one table have the same columns, method, uniqueness, and predicate.",
    fix: "Drop one of the indexes.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2104", "Drop one of the indexes.")],
    escapeHatches: [hatch("OKM2104")],
  },
  {
    code: "OKM2105",
    rule: "redundant-index",
    title: "Redundant index",
    summary:
      "An index is a column prefix of another index on the same table. Unique, partial, and expression indexes are redundant only when they match completely.",
    fix: "Drop the shorter index, or keep it when the longer one is unique, partial, or an expression.",
    defaultLevel: "hint",
    severity: "low",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2105", "Drop the shorter index.")],
    escapeHatches: [hatch("OKM2105")],
  },
  {
    code: "OKM2106",
    rule: "partial-index-bound-value",
    title: "Partial index bound value",
    summary:
      "A partial index predicate column is also filtered by filters() or a preset. Those compile to bound parameters, so a generic plan may not use the index.",
    fix: "Keep the predicate as a constant in SQL, or accept a scan. Inlining preset constants is a later decision.",
    defaultLevel: "hint",
    severity: "low",
    phase: "check",
    evidence: "static",
    safeAlternatives: [
      alt("OKM2106", "Filter that column with a SQL predicate that repeats the index predicate."),
    ],
    escapeHatches: [hatch("OKM2106")],
  },
  {
    code: "OKM2107",
    rule: "unmanaged-comment",
    title: "Unmanaged comment",
    summary:
      "The database has a comment the schema does not declare. OKM leaves it in place. okm pull writes it into the schema.",
    fix: "okm pull writes the comment into the schema, or the schema declares it.",
    defaultLevel: "hint",
    severity: "low",
    phase: "check",
    evidence: "observed",
    safeAlternatives: [alt("OKM2107", "okm pull copies the comment into the schema.")],
    escapeHatches: [hatch("OKM2107")],
  },
  {
    code: "OKM2108",
    rule: "nullable-match-simple",
    title: "Nullable composite key",
    summary:
      "A composite foreign key has a nullable column and MATCH SIMPLE. PostgreSQL skips the check when any column of the key is null.",
    fix: 'Use match: "full", or make every column of the key not null.',
    defaultLevel: "hint",
    severity: "low",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2108", 'match: "full" checks the whole key.')],
    escapeHatches: [hatch("OKM2108")],
  },
  {
    code: "OKM2110",
    rule: "policy-unindexed",
    title: "Policy column without a leading index",
    summary: "A policy filter column is not the first column of an index on that table.",
    fix: "Index that column first, or accept a scan on every policy check.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2110", "Add an index that starts with the policy column.")],
    escapeHatches: [hatch("OKM2110")],
  },
  {
    code: "OKM2111",
    rule: "policy-setting-outside-select",
    title: "Policy expression outside an InitPlan",
    summary:
      "Policy SQL calls current_setting or another function outside (select ...). Postgres re-evaluates it per row.",
    fix: "Use a session handle or wrap the call in (select ...).",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2111", "Write the setting as a session handle.")],
    escapeHatches: [hatch("OKM2111")],
  },
  {
    code: "OKM2112",
    rule: "policy-definer-forced",
    title: "Definer function reads a forced table",
    summary:
      "A security definer function reads a table with forced row security. The function owner is exempt unless the table is forced, and a forced read can return no rows.",
    fix: "Read the table as the caller, or keep the helper off forced tables.",
    defaultLevel: "warn",
    severity: "high",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2112", "Make the helper security invoker.")],
    escapeHatches: [hatch("OKM2112")],
  },
  {
    code: "OKM2113",
    rule: "policy-bypass-role",
    title: "Policy role bypasses row security",
    summary:
      "A policy names a role that owns the tables, is marked superuser, or has BYPASSRLS. That role does not see the policy.",
    fix: "Point the policy at a role that does not bypass row security.",
    defaultLevel: "warn",
    severity: "high",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2113", "Use the app role, then SET LOCAL ROLE to it.")],
    escapeHatches: [hatch("OKM2113")],
  },
  {
    code: "OKM2114",
    rule: "policy-unknown-role",
    title: "Policy role is not in the config",
    summary: "A policy TO role is not a key or a name in the roles config.",
    fix: "Add the role to roles, or name a configured key.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2114", "Use a role key from the roles config.")],
    escapeHatches: [hatch("OKM2114")],
  },
  {
    code: "OKM2115",
    rule: "policy-while-disabled",
    title: "Policies while row security is off",
    summary: "The table stores policies and row security is not enabled. They have no effect.",
    fix: "Set rls so the table enables row security, or remove the policies.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2115", "Set rls: true on the table.")],
    escapeHatches: [hatch("OKM2115")],
  },
  {
    code: "OKM2116",
    rule: "policy-update-without-select",
    title: "UPDATE policy without a SELECT policy",
    summary:
      "An UPDATE policy has no SELECT policy for the same role. The update matches zero rows and reports success.",
    fix: "Add a SELECT policy for that role.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2116", "Add a for: select policy for the same role.")],
    escapeHatches: [hatch("OKM2116")],
  },
  {
    code: "OKM2117",
    rule: "policy-returning",
    title: "Restrictive SELECT changes RETURNING",
    summary:
      "A restrictive SELECT policy also filters INSERT ... RETURNING and DELETE ... RETURNING. A row that fails it raises 42501 on insert and is omitted from a delete count.",
    fix: "Express write restrictions with for: insert, update, or delete policies.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2117", "Keep the restrictive policy on insert, update, or delete.")],
    escapeHatches: [hatch("OKM2117")],
  },
  {
    code: "OKM2118",
    rule: "counter-delete",
    title: "Counter and DELETE",
    summary:
      "A table with a counter series also grants DELETE. Deleting a row leaves a gap. The number is not reused.",
    fix: "Use archivable() so the row stays, or drop the DELETE grant.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2118", "Declare the table with archivable().")],
    escapeHatches: [hatch("OKM2118")],
  },
  {
    code: "OKM2119",
    rule: "reference-period",
    title: "Reference omits the period",
    summary:
      "A number that resets has a unique index that does not include the period. The next period can collide with a previous one.",
    fix: "Put the period in the unique index, or drop the unique index on the reference.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2119", "Include the reset period in the unique index.")],
    escapeHatches: [hatch("OKM2119")],
  },
  {
    code: "OKM2120",
    rule: "sequence-start",
    title: "Sequence start changed",
    summary:
      "start changed on a sequence that already exists. The plan does not restart it. Existing values stay.",
    fix: "Leave start as it is, or set the live value yourself with setval when you mean to.",
    defaultLevel: "hint",
    severity: "low",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2120", "Keep the previous start.")],
    escapeHatches: [hatch("OKM2120")],
  },
  {
    code: "OKM2123",
    rule: "reference-year",
    title: "Year needs a stable source",
    summary:
      "A generated reference takes a year from timestamptz. That expression is not immutable, so a unique index on it is refused.",
    fix: "Use a date or timestamp column, or write at time zone with a constant zone. Do not use to_char for the reference.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "check",
    evidence: "static",
    safeAlternatives: [alt("OKM2123", "Take the year from date or timestamp, or at time zone.")],
    escapeHatches: [hatch("OKM2123")],
  },
];

/**
 * A rule by its kebab-case id.
 *
 * @param rule - Rule id
 * @returns The rule, or `undefined`
 */
export function warningRule(rule: string): WarningRule | undefined {
  return WARNING_RULES.find((item) => item.rule === rule);
}

/**
 * Reports whether a value is a plain object.
 *
 * @param value - Candidate
 * @returns `true` for a non-null object that is not an array
 */
export function isWarningRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
