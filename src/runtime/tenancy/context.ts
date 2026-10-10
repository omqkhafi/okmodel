/**
 * What a table tenancy `rewrite` receives.
 *
 * `columnTenancy()` and `compositeTenancy()` pass it. `via()` reads it.
 * This file is types only, so it is not in a bundle.
 */

import type { AnyTable } from "../../dialects/pg/table.js";
import type { ColumnTenancy } from "../../dialects/pg/tenancy.js";

/** Context for one table whose tenancy mark carries `rewrite`. */
export type TableRewriteContext = {
  readonly tables: readonly AnyTable[];
  readonly keys: readonly string[];
  readonly encodes: readonly ((value: string) => string)[];
  readonly api: ColumnTenancy;
  readonly extras: Map<string, readonly string[]>;
};
