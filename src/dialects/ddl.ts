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
   * @param change - What changed. The dialect decides how many statements that is
   * @returns Steps in apply order. Empty when the change needs no statement
   */
  lower(change: LogicalChange): readonly DdlStep[];
};
