/**
 * OKM1201, thrown when a write would validate and `okmodel/validate` is not registered.
 *
 * The sentences are the registry entry. The write chunk loads this module when
 * it builds the error. The featureless startup graph does not.
 */

import { OkmError } from "../../contracts/error.js";

/** What went wrong. The OKM1201 registry summary is this sentence. */
export const VALIDATION_NOT_IMPORTED =
  "Validation is enabled but `okmodel/validate` was not imported.";

/** What to do. The OKM1201 registry fix is this sentence. */
export const VALIDATION_NOT_IMPORTED_FIX = 'Import "okmodel/validate" before schema().';

/**
 * Throws OKM1201.
 *
 * The category is `input`. The message and the fix are the registry sentences.
 */
export function refuseMissingValidation(): never {
  throw new OkmError("OKM1201", VALIDATION_NOT_IMPORTED, {
    fix: { summary: VALIDATION_NOT_IMPORTED_FIX },
  });
}
