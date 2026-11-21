/**
 * Fix text for failures whose default text says nothing useful (D330).
 *
 * The same text goes to a person and to `errors[].fix`. A schema file that
 * throws is worded where it is caught, and a lock timeout where it is raised.
 * This one covers a database that is not there.
 */

import type { OkmError } from "../../contracts/error.js";

/** The fix a driver error carries when nothing better is known. */
const DEFAULT_DRIVER_FIX = "Read the summary and correct the call.";

/** postgres.js and the server say this for SQLSTATE 3D000. */
const MISSING_DATABASE = /^database ".+" does not exist$/;

/**
 * A better fix for a mapped error, or `undefined` to keep its own.
 *
 * @param mapped - Error after mapping
 * @returns The fix text
 */
export function knownFix(mapped: OkmError): string | undefined {
  if (mapped.code === "driver" && mapped.fix.summary === DEFAULT_DRIVER_FIX) {
    if (MISSING_DATABASE.test(mapped.message)) {
      return "I could not find that database, so I changed nothing. Create it, or correct the database name in the URL.";
    }
  }
  return undefined;
}
