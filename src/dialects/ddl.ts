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
  ColumnObject,
  ConstraintObject,
  TableObject,
} from "../contracts/catalog/types.js";
import type { MigrationClass, StepKind } from "./step-class.js";

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
 * One logical catalog change.
 *
 * A dialect returns zero or more physical steps for one variant. Table,
 * column, and constraint changes are the first family. Other families stay
 * `pending` until they move.
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
      readonly op: "alter-column";
      /** Column already applied, with alias spellings aligned to `after`. */
      readonly before: ColumnObject;
      readonly after: ColumnObject;
      readonly schema: string;
      /** Before and after catalogs, for the not-null check name. */
      readonly catalogs: readonly Catalog[];
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
   * @param change - What changed. The dialect decides how many statements that is
   * @returns Steps in apply order. Empty when the change needs no statement
   */
  lower(change: LogicalChange): readonly DdlStep[];
};
