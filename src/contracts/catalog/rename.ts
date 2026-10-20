/**
 * A rename the author declared on a table or a column.
 *
 * The schema stores `renamedFrom`. The planner applies these names before it
 * diffs, so a declared rename is not a drop and an add.
 */
export type DeclaredRename =
  | { readonly kind: "table"; readonly from: string; readonly to: string }
  | {
      readonly kind: "column";
      readonly table: string;
      readonly from: string;
      readonly to: string;
    };
