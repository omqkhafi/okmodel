/**
 * Postgres safe steps for `SET NOT NULL` (D193).
 *
 * The planner asks for these as one logical column change. The temporary
 * check is dropped after `SET NOT NULL`.
 */

import { fitIdentifier } from "../../contracts/catalog/identifier.js";
import type { Catalog, ColumnObject } from "../../contracts/catalog/types.js";
import { qualify, quoteIdent } from "./ddl.js";
import type { StepKind } from "../step-class.js";

/** One statement inside a not-null rewrite. */
export type NotNullStep = {
  readonly sql: string;
  readonly kind: StepKind;
  readonly action: "ddl";
  readonly lock: string;
  readonly transactional: boolean;
};

const ACCESS = "ACCESS EXCLUSIVE";
const SHARE_UPDATE = "SHARE UPDATE EXCLUSIVE";

/**
 * `SET NOT NULL` through a validated check.
 *
 * Postgres skips the table scan when a validated `CHECK (col IS NOT NULL)`
 * already exists.
 *
 * @param column - Column that must become `NOT NULL`
 * @param schema - Concrete schema name
 * @param setKind - `set-not-null` when the column already existed; `add-column` when this finishes a new column
 * @param catalogs - Catalogs whose constraint names the temporary check must not reuse
 * @returns Add `NOT VALID`, validate, set not null, drop the check
 */
export function notNullSteps(
  column: ColumnObject,
  schema: string,
  setKind: "set-not-null" | "add-column",
  catalogs: readonly Catalog[],
): readonly NotNullStep[] {
  const tableName = column.identity.parent.name;
  const columnName = column.identity.name;
  const table = qualify(schema, tableName);
  const quotedColumn = quoteIdent(columnName);
  const constraint = quoteIdent(notNullConstraintName(tableName, columnName, catalogs));
  return [
    {
      sql: `alter table ${table} add constraint ${constraint} check (${quotedColumn} is not null) not valid`,
      kind: "add-constraint",
      action: "ddl",
      lock: ACCESS,
      transactional: true,
    },
    {
      sql: `alter table ${table} validate constraint ${constraint}`,
      kind: "validate-constraint",
      action: "ddl",
      lock: SHARE_UPDATE,
      transactional: true,
    },
    {
      sql: `alter table ${table} alter column ${quotedColumn} set not null`,
      kind: setKind,
      action: "ddl",
      lock: ACCESS,
      transactional: true,
    },
    {
      sql: `alter table ${table} drop constraint ${constraint}`,
      kind: "drop-not-null-check",
      action: "ddl",
      lock: ACCESS,
      transactional: true,
    },
  ];
}

function notNullConstraintName(
  table: string,
  column: string,
  catalogs: readonly Catalog[],
): string {
  const taken = new Set<string>();
  for (const source of catalogs) {
    for (const object of source.objects) {
      if (object.kind === "constraint" || object.kind === "index") taken.add(object.identity.name);
    }
  }
  const base = fitIdentifier(`${table}_${column}_notnull`);
  if (!taken.has(base)) return base;
  return fitIdentifier(`${table}_${column}_notnull_okm`);
}
