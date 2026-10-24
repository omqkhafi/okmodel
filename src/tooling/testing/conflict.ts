/**
 * OKM1894 for `testing()` when a table or extension is already in the database.
 */

import { OkmError } from "../../contracts/error.js";

/**
 * Refuses to apply a harness object that already exists.
 *
 * @param kind - Which object conflicted
 * @param name - The object's name
 * @returns Never
 */
export function testingObjectConflict(kind: "table" | "extension", name: string): never {
  throw new OkmError("OKM1894", `testing() found an existing ${kind} "${name}".`, {
    fix: {
      summary: "Use an empty database, or pass migrate: false when the schema is already applied.",
    },
  });
}
