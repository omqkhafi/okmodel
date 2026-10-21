/**
 * Where each dialect family can hold a setting for a unit of work.
 *
 * `transaction` is `set_config(name, value, true)`: gone at commit or
 * rollback, safe behind a transaction-mode pooler. `session` is a variable
 * that lives as long as the connection. `none` has no settings at all.
 * Only `transaction` can back `okmodel/session`.
 */

import { OkmError } from "../../contracts/error.js";
import { FEATURE_REFUSAL_DOCS } from "./check.js";

/** How long a dialect family keeps a setting. */
export type SettingScope = "transaction" | "session" | "none";

/** A dialect family the registry names. */
export type SettingsDialect = "postgres" | "mysql" | "sqlite";

/**
 * Frozen table of `sessionSettings` by dialect family.
 *
 * `as const` is the freeze.
 */
export const SESSION_SETTINGS = {
  postgres: "transaction",
  mysql: "session",
  sqlite: "none",
} as const satisfies Record<SettingsDialect, SettingScope>;

/**
 * Refuses `sessionSettings` on a dialect that cannot scope a setting to a transaction.
 *
 * A connection-level variable would outlive the unit and leak to the next
 * client of a pooled connection, so MySQL refuses too.
 *
 * @param dialect - Dialect family
 * @throws OkmError OKM1860 for `mysql` and `sqlite`
 */
export function assertSessionSettings(dialect: SettingsDialect): void {
  if (SESSION_SETTINGS[dialect] === "transaction") return;
  throw new OkmError(
    "OKM1860",
    `${dialect} refuses sessionSettings. This dialect has no transaction-local settings; use column, composite or path tenancy.`,
    { fix: { summary: `Use column, composite or path tenancy. ${FEATURE_REFUSAL_DOCS}` } },
  );
}
