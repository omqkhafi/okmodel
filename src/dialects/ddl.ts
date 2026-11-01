/**
 * DDL lowering seam.
 *
 * The planner decides which logical changes happen and in what order.
 * A dialect turns one logical change into the physical steps that apply it.
 * Postgres is the first implementation, in `src/dialects/pg/lower.ts`.
 *
 * This module is not a package export. SQLite and MySQL can implement
 * {@link DdlDialect} later without a planner edit.
 */

import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ConstraintObject,
  ExtensionObject,
  FunctionObject,
  IndexObject,
  MaterializedViewObject,
  PolicyObject,
  SequenceObject,
  TableObject,
  TriggerObject,
  TypeObject,
  ViewObject,
} from "../contracts/catalog/types.js";
import { OkmError } from "../contracts/error.js";
import { classOf, STEP_CLASS, type MigrationClass, type StepKind } from "./step-class.js";

/** How a dialect provides a feature. Matches the feature registry. */
export type DdlSupport = "native" | "emulated" | "refused";

/**
 * One emulated feature.
 *
 * `cost` is the registry's one-line note. The planner does not print it.
 */
export type DdlEmulatedNote = {
  readonly feature: string;
  /** What the emulation costs or changes, one line. */
  readonly cost: string;
};

/**
 * What `-- backfill` records on a physical step.
 *
 * Same shape as the migration header: quoted table, quoted key columns, batch size.
 */
export type DdlBackfill = {
  /** Quoted schema-qualified table, as in the statement. */
  readonly table: string;
  /** Quoted key columns. */
  readonly key: readonly string[];
  /** Rows per batch. */
  readonly batch: number;
};

/** One `-- okm-allow CODE: reason` line above a statement. */
export type DdlAllow = {
  readonly code: string;
  readonly reason: string;
};

/**
 * One physical statement a dialect returns for a logical change.
 *
 * The planner stores this as a plan step. It does not concatenate `sql`.
 */
export type DdlStep = {
  readonly sql: string;
  readonly class: MigrationClass;
  /**
   * Planner operation. Absent on a step built by hand.
   *
   * The class comes from this kind.
   */
  readonly kind?: StepKind;
  readonly action: "ddl" | "backfill";
  readonly lock: string;
  /**
   * Tables the statement names.
   *
   * Used to look up `pg_class.reltuples` when a plan is printed against a
   * reachable target. The plan text does not write this into a file.
   */
  readonly tables?: readonly string[];
  /**
   * Set when the step was emitted by a safe rewrite.
   *
   * Display only. A migration file does not record it.
   */
  readonly safeRewrite?: true;
  readonly transactional: boolean;
  /**
   * Set when the statement is a batched backfill.
   *
   * Absent on a data step written without that header.
   */
  readonly backfill?: DdlBackfill;
  /**
   * Set on an extension upgrade the planner could not check.
   *
   * Apply reads `pg_extension_update_paths` before any statement.
   */
  readonly path?: "unverified";
  /**
   * Set on `CREATE OR REPLACE` of a function whose signature did not change.
   *
   * The statement is expand. The flag says the body or the settings changed.
   */
  readonly behavior?: "change";
  /**
   * `-- okm-allow` lines on the step.
   *
   * A reason silences that code on every statement of the step.
   */
  readonly allows?: readonly DdlAllow[];
};

/**
 * One physical step {@link DdlDialect.lower} may return.
 *
 * `kind` is required. The class is {@link classOf} of that kind, and `sql`
 * is non-empty. {@link sealLowered} checks the class and the text.
 */
export type LoweredStep = Omit<DdlStep, "kind"> & {
  readonly kind: StepKind;
};

/**
 * Refuses a lowering the planner cannot trust.
 *
 * An empty list is a change with no statement. Every step that is present
 * needs SQL, a kind, the class of that kind, and SQL that matches the kind.
 *
 * @param steps - Steps from {@link DdlDialect.lower}
 * @returns The same steps
 * @throws OkmError OKM1559 when SQL is blank, the kind is missing, the class disagrees, or the SQL does not match the kind
 */
export function sealLowered(steps: readonly DdlStep[]): readonly LoweredStep[] {
  for (const step of steps) {
    if (
      typeof step !== "object" ||
      step === null ||
      typeof step.sql !== "string" ||
      step.sql.trim().length === 0
    ) {
      throw new OkmError("OKM1559", "The dialect returned a statement with no SQL.", {
        fix: { summary: "Each lowered statement has to contain SQL." },
      });
    }
    if (step.kind === undefined) {
      throw new OkmError(
        "OKM1559",
        `A lowered statement has no kind and was classed ${step.class}.`,
        { fix: { summary: "The statement class has to match its kind." } },
      );
    }
    if (classOf(step.kind) !== step.class) {
      throw new OkmError(
        "OKM1559",
        `Step kind ${step.kind} is ${classOf(step.kind)}, and the statement was classed ${step.class}.`,
        { fix: { summary: "The statement class has to match its kind." } },
      );
    }
    if (!statementMatchesKind(step.kind, step.sql)) {
      throw new OkmError("OKM1559", `Step kind ${step.kind} does not match its statement.`, {
        fix: { summary: "The statement has to match its kind." },
      });
    }
  }
  return steps as readonly LoweredStep[];
}

/**
 * Whether `sql` is a statement of `kind`.
 *
 * The text is compared after comments are removed and whitespace is collapsed.
 * `raw-sql` matches any statement. A safe rewrite is not sealed here.
 *
 * @param kind - Planner operation on the step
 * @param sql - Statement text
 * @returns `true` when the statement is that kind
 */
function statementMatchesKind(kind: StepKind, sql: string): boolean {
  if (!Object.hasOwn(STEP_CLASS, kind)) return false;
  return KIND_SQL[kind].test(normalizedStatement(sql));
}

/**
 * One pattern per kind, matched against {@link normalizedStatement}.
 *
 * A kind that emits more than one statement shape (a check swap, row-level
 * security, default privileges) accepts each of those shapes.
 */
const KIND_SQL: Readonly<Record<StepKind, RegExp>> = {
  "create-table": /^create table\b/,
  "drop-table": /^drop table\b/,
  "add-column": /^alter table\b.*\badd column\b/,
  "add-column-required": /^alter table\b.*\badd column\b/,
  "drop-column": /^alter table\b.*\bdrop column\b/,
  "set-column-type": /^alter table\b.*\bset data type\b/,
  "set-not-null": /^alter table\b.*\bset not null\b/,
  "drop-not-null": /^alter table\b.*\bdrop not null\b/,
  "set-default": /^alter table\b.*\bset default\b/,
  "drop-default": /^alter table\b.*\bdrop default\b/,
  "add-identity": /^alter table\b.*\badd generated (?:always|by default) as identity\b/,
  "drop-identity": /^alter table\b.*\bdrop identity\b/,
  "set-identity-always": /^alter table\b.*\bset generated always\b/,
  "set-identity-by-default": /^alter table\b.*\bset generated by default\b/,
  "add-constraint": /^alter table\b.*\badd constraint\b/,
  "validate-constraint": /^alter table\b.*\bvalidate constraint\b/,
  "drop-constraint": /^alter table\b.*\bdrop constraint\b/,
  "drop-not-null-check": /^alter table\b.*\bdrop constraint\b/,
  "rename-constraint": /^alter table\b.*\brename constraint\b/,
  "widen-check": /^alter table\b.*\b(?:drop constraint|add constraint|validate constraint)\b/,
  "narrow-check": /^alter table\b.*\b(?:drop constraint|add constraint|validate constraint)\b/,
  "create-index": /^create (?:unique )?index\b/,
  "drop-index": /^drop index\b/,
  "rename-index": /^alter index\b.*\brename to\b/,
  "create-sequence": /^create sequence\b/,
  "drop-sequence": /^drop sequence\b/,
  "create-enum": /^create type\b.*\bas enum\b/,
  "recreate-enum": /^create type\b.*\bas enum\b/,
  "add-enum-value": /^alter type\b.*\badd value\b/,
  "rename-enum": /^alter type\b.*\brename to\b/,
  "drop-enum": /^drop type\b/,
  "set-enum-column": /^alter table\b.*\balter column\b.*\btype\b/,
  "create-domain": /^create domain\b/,
  "drop-domain": /^drop (?:domain|type)\b/,
  "add-domain-check": /^alter domain\b.*\badd constraint\b/,
  "validate-domain-check": /^alter domain\b.*\bvalidate constraint\b/,
  "drop-domain-check": /^alter domain\b.*\bdrop constraint\b/,
  "rename-domain-check": /^alter domain\b.*\brename constraint\b/,
  "create-extension": /^create extension\b/,
  "drop-extension": /^drop extension\b/,
  "update-extension": /^alter extension\b.*\bupdate\b/,
  "move-extension": /^alter extension\b.*\bset schema\b/,
  "create-function": /^create function\b/,
  "drop-function": /^drop function\b/,
  "replace-function": /^create or replace function\b/,
  "create-trigger": /^create trigger\b/,
  "drop-trigger": /^drop trigger\b/,
  "create-view": /^create view\b/,
  "drop-view": /^drop view\b/,
  "replace-view": /^create or replace view\b/,
  "create-matview": /^create materialized view\b/,
  "drop-matview": /^drop materialized view\b/,
  "refresh-matview": /^refresh materialized view\b/,
  "create-role": /^create role\b/,
  "alter-role": /^alter role\b/,
  grant: /^grant\b/,
  revoke: /^revoke\b/,
  "grant-default": /^alter default privileges\b/,
  "revoke-default": /^alter default privileges\b.*\brevoke\b/,
  "rename-table": /^alter table\b.*\brename to\b/,
  "rename-column": /^alter table\b.*\brename column\b/,
  "rename-sequence": /^alter sequence\b.*\brename to\b/,
  "backfill-expand": /^update\b/,
  "backfill-contract": /^update\b/,
  "enable-rls":
    /^alter table\b.*\b(?:enable row level security|(?<!no )force row level security)\b/,
  "create-policy": /^create policy\b/,
  "drop-policy": /^drop policy\b/,
  "disable-rls": /^alter table\b.*\b(?:disable row level security|no force row level security)\b/,
  "raw-sql": /.+/,
};

/** Comments removed, whitespace collapsed, letters folded. */
function normalizedStatement(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Drops `--` and block comments that are not inside a quote.
 *
 * A dollar quote is copied through, so a function body is not treated as SQL
 * punctuation. The kind match then sees the statement, not the body.
 */
function stripSqlComments(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index = Math.min(index + 2, sql.length);
      continue;
    }
    if (char === "'") {
      const end = quotedEnd(sql, index, "'");
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "$") {
      const tag = dollarTag(sql, index);
      if (tag !== undefined) {
        const close = sql.indexOf(tag, index + tag.length);
        const end = close < 0 ? sql.length : close + tag.length;
        out += sql.slice(index, end);
        index = end;
        continue;
      }
    }
    out += char ?? "";
    index += 1;
  }
  return out;
}

function quotedEnd(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function dollarTag(sql: string, start: number): string | undefined {
  const match = /^\$([A-Za-z0-9_]*)\$/.exec(sql.slice(start));
  return match?.[0];
}

/**
 * Accepts a lowering only when it is at least one trusted statement.
 *
 * A missing result, an empty list, or a step with no SQL is OKM1559. An
 * empty list used to drop the change.
 *
 * @param lowered - Whatever {@link DdlDialect.lower} returned
 * @returns The sealed steps
 * @throws OkmError OKM1559
 */
export function requireLowered(lowered: unknown): readonly LoweredStep[] {
  if (!Array.isArray(lowered) || lowered.length === 0) {
    throw new OkmError("OKM1559", "The dialect returned no statement for a change.", {
      fix: { summary: "The lowering for this change has to return at least one statement." },
    });
  }
  return sealLowered(lowered as readonly DdlStep[]);
}

/**
 * One logical catalog change.
 *
 * A dialect returns zero or more physical steps for one variant. Table,
 * column, constraint, index, type, extension, routine, view, policy,
 * privilege, sequence, check, and row-rewrite changes lower here. `pending`
 * stays for a change a dialect has nothing to emit for.
 */
export type LogicalChange =
  | { readonly op: "pending" }
  | {
      readonly op: "rename-table";
      readonly schema: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly op: "rename-column";
      readonly schema: string;
      readonly table: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly op: "rename-constraint";
      readonly schema: string;
      readonly table: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly op: "rename-index";
      readonly schema: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly op: "drop-table";
      readonly object: TableObject;
      readonly schema: string;
    }
  | {
      readonly op: "drop-column";
      readonly object: ColumnObject;
      readonly schema: string;
    }
  | {
      readonly op: "drop-constraint";
      readonly object: ConstraintObject;
      readonly schema: string;
    }
  | {
      readonly op: "create-table";
      readonly table: TableObject;
      readonly catalog: Catalog;
      readonly schema: string;
    }
  | {
      readonly op: "add-column";
      readonly column: ColumnObject;
      readonly schema: string;
      /** True when the parent table is created in this same plan. */
      readonly tableIsNew: boolean;
    }
  | {
      readonly op: "add-constraint";
      readonly constraint: ConstraintObject;
      readonly schema: string;
      /** True when the parent table is created in this same plan. */
      readonly tableIsNew: boolean;
    }
  | {
      readonly op: "create-index";
      readonly index: IndexObject;
      readonly schema: string;
      /**
       * True when the parent table already exists.
       *
       * The dialect chooses a non-blocking build when it can.
       */
      readonly onExistingTable: boolean;
    }
  | {
      readonly op: "drop-index";
      readonly index: IndexObject;
      readonly schema: string;
      /**
       * True when the parent table remains.
       *
       * The dialect chooses a non-blocking drop when it can. The planner
       * still decides whether that drop waits for a replacement build.
       */
      readonly onExistingTable: boolean;
    }
  | {
      readonly op: "alter-column";
      /** Column already applied, with alias spellings aligned to `after`. */
      readonly before: ColumnObject;
      readonly after: ColumnObject;
      readonly schema: string;
      /** Before and after catalogs, for the not-null check name. */
      readonly catalogs: readonly Catalog[];
    }
  | {
      readonly op: "create-type";
      readonly object: TypeObject;
      readonly schema: string;
    }
  | {
      readonly op: "drop-type";
      readonly object: TypeObject;
      readonly schema: string;
    }
  | {
      readonly op: "add-enum-values";
      readonly schema: string;
      readonly name: string;
      readonly before: readonly string[];
      readonly after: readonly string[];
    }
  | {
      readonly op: "replace-enum";
      readonly schema: string;
      readonly name: string;
      readonly labels: readonly string[];
      /** Columns that must be cast onto the recreated type, in planner order. */
      readonly columns: readonly { readonly table: string; readonly column: string }[];
    }
  | {
      readonly op: "alter-domain-check";
      readonly schema: string;
      readonly name: string;
      readonly expression: string;
    }
  | {
      readonly op: "create-extension";
      readonly object: ExtensionObject;
      readonly schema: string;
    }
  | {
      readonly op: "drop-extension";
      readonly object: ExtensionObject;
      readonly schema: string;
    }
  | {
      readonly op: "move-extension";
      readonly name: string;
      readonly schema: string;
    }
  | {
      readonly op: "update-extension";
      readonly name: string;
      readonly version: string;
    }
  | {
      readonly op: "create-function";
      readonly object: FunctionObject;
      readonly schema: string;
    }
  | {
      readonly op: "drop-function";
      readonly object: FunctionObject;
      readonly schema: string;
    }
  | {
      readonly op: "replace-function";
      readonly object: FunctionObject;
      readonly schema: string;
    }
  | {
      readonly op: "create-trigger";
      readonly object: TriggerObject;
      readonly schema: string;
    }
  | {
      readonly op: "drop-trigger";
      readonly object: TriggerObject;
      readonly schema: string;
    }
  | {
      readonly op: "create-view";
      readonly object: ViewObject;
      readonly schema: string;
    }
  | {
      readonly op: "drop-view";
      readonly object: ViewObject;
      readonly schema: string;
    }
  | {
      readonly op: "replace-view";
      readonly object: ViewObject;
      readonly schema: string;
    }
  | {
      readonly op: "create-matview";
      readonly object: MaterializedViewObject;
      readonly schema: string;
    }
  | {
      readonly op: "drop-matview";
      readonly object: MaterializedViewObject;
      readonly schema: string;
    }
  | {
      readonly op: "refresh-matview";
      readonly object: MaterializedViewObject;
      readonly schema: string;
    }
  | {
      readonly op: "create-policy";
      readonly object: PolicyObject;
      readonly schema: string;
    }
  | {
      readonly op: "drop-policy";
      readonly object: PolicyObject;
      readonly schema: string;
    }
  | {
      readonly op: "privileges";
      readonly phase: "revoke" | "prepare" | "grant";
      readonly before: readonly CatalogObject[];
      readonly after: readonly CatalogObject[];
      readonly schema: string;
      /** Identity keys this plan drops and creates again. */
      readonly recreated: readonly string[];
    }
  | {
      readonly op: "create-sequence";
      readonly object: SequenceObject;
      readonly schema: string;
    }
  | {
      readonly op: "drop-sequence";
      readonly object: SequenceObject;
      readonly schema: string;
    }
  | {
      readonly op: "rename-sequence";
      readonly schema: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly op: "swap-check";
      readonly schema: string;
      readonly table: string;
      readonly name: string;
      readonly expression: string;
      readonly kind: "narrow-check" | "widen-check";
    }
  | {
      readonly op: "rewrite-values";
      readonly schema: string;
      readonly table: string;
      readonly column: string;
      readonly from: string;
      readonly to: string | null;
      readonly cast: boolean;
      /** Batch predicate. The planner owns the `$1` / `$2` header. */
      readonly predicate: string;
      /** Quoted key columns, in primary-key order. */
      readonly key: readonly string[];
      readonly batch: number;
      readonly kind: "backfill-expand" | "backfill-contract";
    };

/**
 * Dialect DDL lowering and the feature questions the planner is allowed to ask.
 *
 * The planner does not import a feature registry. It calls {@link DdlDialect.support}
 * and {@link DdlDialect.refuseUnsupported}.
 */
export type DdlDialect = {
  /** Dialect name used when a feature is refused. */
  readonly name: string;
  /**
   * Support recorded for one feature key.
   *
   * @param feature - Dotted registry key
   * @returns The registry support, or `undefined` when the key is absent
   */
  support(feature: string): DdlSupport | undefined;
  /**
   * Features of `catalog` this dialect knows how to read.
   *
   * @param catalog - Catalog the planner is about to diff
   * @returns Feature keys this dialect's registry understands
   */
  featuresUsed(catalog: Catalog): readonly string[];
  /**
   * Refuses a feature this dialect marks `refused`.
   *
   * @param features - Keys to check. A refused key throws
   * @returns Emulation notes for the keys that are emulated
   * @throws OkmError OKM1860 when a key is refused
   */
  refuseUnsupported(features: readonly string[]): readonly DdlEmulatedNote[];
  /**
   * Physical steps for one logical change.
   *
   * Each step has non-empty SQL, a kind, and the class of that kind.
   * {@link sealLowered} refuses anything else with OKM1559.
   *
   * @param change - What changed. The dialect decides how many statements that is
   * @returns Steps in apply order. Empty when the change needs no statement
   * @throws OkmError OKM1559 when a step has no SQL, no kind, or a class that disagrees with the kind
   */
  lower(change: LogicalChange): readonly LoweredStep[];
  /**
   * Whether `from` and `to` are one casing of each other.
   *
   * Absent when the dialect does not spell names. The planner uses it to
   * name casing as the cause of an unexplained rename.
   *
   * @param from - Name that would be dropped
   * @param to - Name that would be added
   * @returns `true` when one casing of either name is the other
   */
  sameCasing?(from: string, to: string): boolean;
};
