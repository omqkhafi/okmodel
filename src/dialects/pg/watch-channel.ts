/**
 * The channel a watch trigger notifies.
 *
 * Shared by the catalog compiler and the runtime. The runtime imports this
 * file only, so a connect bundle does not load the trigger DDL.
 */

import { fitIdentifier } from "../../contracts/catalog/identifier.js";

/** Bytes of `pg_notify` payload before the trigger wakes every listener. */
export const WATCH_PAYLOAD_MAX = 7900;

/**
 * Channel a table's trigger notifies. Fits in 63 bytes.
 *
 * @param sqlName - The table's SQL name
 * @returns The channel
 */
export function watchChannel(sqlName: string): string {
  return fitIdentifier(`okm_w_${sqlName}`);
}
