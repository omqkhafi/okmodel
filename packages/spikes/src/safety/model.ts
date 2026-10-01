/**
 * Logical query, catalog, and provenance for the safety spike.
 *
 * Provenance is stamped by the pipeline. A preset cannot label its own
 * predicate as tenancy.
 */

/** Who added a rule. */
export type ProvenanceKind =
  | "caller"
  | "preset"
  | "trait"
  | "tenancy"
  | "archive"
  | "hidden"
  | "sensitive"
  | "guard"
  | "filter"
  | "escape";

/**
 * Source of a rule.
 *
 * `location` is the `file:line` style the spec shows in `inspect()`.
 */
export type Provenance = {
  readonly kind: ProvenanceKind;
  readonly name: string;
  readonly location: string;
};

/** Comparison operators the verifier understands. */
export type CompareOp =
  | "eq"
  | "isNull"
  | "isNotNull"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "startsWith"
  | "contains";

/**
 * One comparison.
 *
 * `parameter` is a `$name` slot. Null checks omit it. Values are never inlined.
 */
export type Predicate = {
  readonly table: string;
  readonly column: string;
  readonly op: CompareOp;
  readonly parameter: string | undefined;
  readonly provenance: Provenance;
};

/** Boolean structure of a `where`. */
export type BoolExpr =
  | { readonly kind: "pred"; readonly predicate: Predicate }
  | { readonly kind: "and"; readonly args: readonly BoolExpr[] }
  | { readonly kind: "or"; readonly args: readonly BoolExpr[] };

/** A column the catalog knows about. */
export type FieldMeta = {
  readonly name: string;
  readonly guarded: boolean;
  readonly hidden: boolean;
  readonly sensitive: boolean;
  readonly tenantKey: boolean;
  readonly archive: boolean;
};

/** Traits this spike can attach to a table. */
export type TraitName = "timestamps" | "archivable";

/** A named query refinement. It adds predicates. It does not receive the query. */
export type PresetDef = {
  readonly name: string;
  readonly location: string;
  readonly predicates: readonly DraftPredicate[];
};

/** A predicate a preset or caller contributes, before provenance is stamped. */
export type DraftPredicate = {
  readonly column: string;
  readonly op: CompareOp;
  readonly parameter: string | undefined;
};

/** How archived rows are visible. */
export type ArchiveMode = "active" | "withArchived" | "onlyArchived";

/** Explicit escape hatches. Blank reasons do not count. */
export type Escape =
  | { readonly hatch: "unscoped"; readonly reason: string; readonly provenance: Provenance }
  | { readonly hatch: "all"; readonly reason: string; readonly provenance: Provenance }
  | { readonly hatch: "trusted"; readonly reason: string; readonly provenance: Provenance }
  | {
      readonly hatch: "allow";
      readonly fields: readonly string[];
      readonly provenance: Provenance;
    };

/** Escape as the caller wrote it, before provenance is stamped. */
export type DraftEscape =
  | { readonly hatch: "unscoped"; readonly reason: string }
  | { readonly hatch: "all"; readonly reason: string }
  | { readonly hatch: "trusted"; readonly reason: string }
  | { readonly hatch: "allow"; readonly fields: readonly string[] };

/** A rule the pipeline added, kept so a later step can see that it survived. */
export type Contribution = {
  readonly id: string;
  readonly provenance: Provenance;
  readonly effect:
    | { readonly kind: "predicate"; readonly predicate: Predicate }
    | {
        readonly kind: "value";
        readonly column: string;
        readonly parameter: string;
        readonly table: string;
      }
    | { readonly kind: "hide"; readonly table: string; readonly column: string }
    | { readonly kind: "redact"; readonly table: string; readonly column: string }
    | { readonly kind: "guard"; readonly table: string; readonly column: string };
};

/** A value written with a parameter slot. */
export type ValueBinding = {
  readonly table: string;
  readonly column: string;
  readonly parameter: string;
  readonly provenance: Provenance;
};

/**
 * One table in the spike catalog.
 *
 * `relations` maps a relation name to the target table. `globalReason` is set
 * when tenancy is `global`.
 */
export type TableMeta = {
  readonly name: string;
  readonly tenancy: "column" | "global";
  readonly globalReason: string | undefined;
  readonly traits: readonly TraitName[];
  readonly fields: readonly FieldMeta[];
  readonly presets: readonly PresetDef[];
  readonly relations: Readonly<Record<string, string>>;
};

/** Tables the verifier trusts. */
export type Catalog = {
  readonly tables: readonly TableMeta[];
};

/** Logical operation names this spike verifies. */
export type QueryOp = "find" | "insert" | "update" | "delete";

/**
 * A query after presets, traits, tenancy, archive visibility, and field rules.
 *
 * `requested` is the contribution ids the pipeline promised. The verifier
 * rejects the query when one of them is missing.
 */
export type LogicalQuery = {
  readonly op: QueryOp;
  readonly tables: readonly string[];
  readonly where: BoolExpr;
  readonly userWhere: BoolExpr;
  readonly select: "default" | "explicit";
  readonly projection: readonly string[];
  readonly input: readonly string[];
  readonly values: readonly ValueBinding[];
  readonly limit: number | undefined;
  readonly archive: ArchiveMode;
  readonly escapes: readonly Escape[];
  readonly contributions: readonly Contribution[];
  readonly requested: readonly string[];
  readonly redacted: readonly string[];
};

/**
 * Caller input before the pipeline adds rules.
 */
export type QueryDraft = {
  readonly op: QueryOp;
  readonly table: string;
  readonly touched?: readonly string[];
  readonly caller?: readonly DraftPredicate[];
  readonly presets?: readonly string[];
  readonly input?: readonly string[];
  readonly select?: "default" | readonly string[];
  readonly limit?: number;
  readonly archive?: ArchiveMode;
  readonly escapes?: readonly DraftEscape[];
  readonly filters?: {
    readonly allow: Readonly<Record<string, readonly string[]>>;
    readonly sort?: readonly string[];
    readonly relations?: Readonly<Record<string, readonly string[]>>;
    readonly payload: unknown;
  };
};

const AUTOMATIC_ID = "id";

/**
 * Builds a table and applies automatic guards.
 *
 * Primary keys are guarded. The tenant key is guarded under column tenancy.
 * Timestamp and archive columns are guarded when that trait is present.
 * A column-tenant table must name a tenant key. An archivable table must name
 * an archive column. A global table must carry a reason.
 *
 * @param input - Table shape
 * @returns Catalog metadata
 */
export function defineTable(input: {
  readonly name: string;
  readonly tenancy: "column" | "global";
  readonly globalReason?: string;
  readonly traits?: readonly TraitName[];
  readonly fields: readonly {
    readonly name: string;
    readonly hidden?: boolean;
    readonly sensitive?: boolean;
    readonly guarded?: boolean;
    readonly tenantKey?: boolean;
    readonly archive?: boolean;
  }[];
  readonly presets?: readonly PresetDef[];
  readonly relations?: Readonly<Record<string, string>>;
}): TableMeta {
  const traits = input.traits ?? [];
  if (input.tenancy === "global" && (input.globalReason ?? "").trim().length === 0) {
    throw new Error(`Table ${input.name} is global and needs a reason.`);
  }
  const fields = input.fields.map((field) => ({
    name: field.name,
    hidden: field.hidden ?? false,
    sensitive: field.sensitive ?? false,
    guarded:
      field.guarded === true ||
      automaticGuard(field.name, input.tenancy, traits, field.tenantKey === true),
    tenantKey: field.tenantKey === true,
    archive: field.archive === true,
  }));
  if (input.tenancy === "column" && !fields.some((field) => field.tenantKey)) {
    throw new Error(`Table ${input.name} uses column tenancy and needs a tenant key.`);
  }
  if (traits.includes("archivable") && !fields.some((field) => field.archive)) {
    throw new Error(`Table ${input.name} is archivable and needs an archive column.`);
  }
  return {
    name: input.name,
    tenancy: input.tenancy,
    globalReason: input.tenancy === "global" ? input.globalReason : undefined,
    traits,
    fields,
    presets: input.presets ?? [],
    relations: input.relations ?? {},
  };
}

/**
 * Looks up a table.
 *
 * @param catalog - Spike catalog
 * @param name - Table name
 * @returns The table, or `undefined`
 */
export function tableByName(catalog: Catalog, name: string): TableMeta | undefined {
  return catalog.tables.find((table) => table.name === name);
}

/**
 * Tenant key column, when the table has one.
 *
 * @param table - Catalog table
 * @returns The field, or `undefined`
 */
export function tenantField(table: TableMeta): FieldMeta | undefined {
  return table.fields.find((field) => field.tenantKey);
}

/**
 * Archive column, when the table has one.
 *
 * @param table - Catalog table
 * @returns The field, or `undefined`
 */
export function archiveField(table: TableMeta): FieldMeta | undefined {
  return table.fields.find((field) => field.archive);
}

/**
 * Reports whether a reason is usable as an escape hatch.
 *
 * @param reason - Caller text
 * @returns True when the trimmed reason is non-empty
 */
export function usableReason(reason: string): boolean {
  return reason.trim().length > 0;
}

/**
 * An AND node. An empty list is an empty filter.
 *
 * @param args - Children
 * @returns The expression
 */
export function andExpr(args: readonly BoolExpr[]): BoolExpr {
  return { kind: "and", args };
}

/**
 * An OR node.
 *
 * @param args - Children
 * @returns The expression
 */
export function orExpr(args: readonly BoolExpr[]): BoolExpr {
  return { kind: "or", args };
}

/**
 * Wraps one predicate.
 *
 * @param predicate - Comparison
 * @returns A leaf
 */
export function predExpr(predicate: Predicate): BoolExpr {
  return { kind: "pred", predicate };
}

/**
 * Label used in violations and plans.
 *
 * @param provenance - Stamped source
 * @returns `kind:name`
 */
export function provenanceLabel(provenance: Provenance): string {
  return `${provenance.kind}:${provenance.name}`;
}

function automaticGuard(
  name: string,
  tenancy: "column" | "global",
  traits: readonly TraitName[],
  tenantKey: boolean,
): boolean {
  if (name === AUTOMATIC_ID) {
    return true;
  }
  if (tenantKey && tenancy === "column") {
    return true;
  }
  if ((name === "createdAt" || name === "updatedAt") && traits.includes("timestamps")) {
    return true;
  }
  if ((name === "archivedAt" || name === "archiveId") && traits.includes("archivable")) {
    return true;
  }
  return false;
}
