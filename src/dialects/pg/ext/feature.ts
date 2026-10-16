/**
 * Version gate for one extension feature (OKM1812).
 *
 * The factory reads the declared extension version. An omitted pin is
 * unpinned: apply checks the server. A pin that still allows a version
 * without the feature fails here, at the call, which is schema build when
 * the schema file calls the method. The message names the feature, the
 * extension version, and `minPostgres`.
 */

import { OkmError } from "../../../contracts/error.js";
import { compareExtensionVersions, isExactVersion } from "../../../contracts/catalog/extension.js";

/** What a feature needs. */
export type FeatureNeed = {
  /** Extension the feature belongs to. */
  readonly name: string;
  /** Minimum extension version (`1.2`). */
  readonly extension: string;
  /** Minimum Postgres major. Named in the message. */
  readonly postgres: number;
};

/**
 * Refuses a pin that does not guarantee the feature.
 *
 * @param declared - `version` on the extension, when the caller set one
 * @param feature - Feature name, such as `daitch_mokotoff`
 * @param need - Versions the feature needs
 */
export function assertExtFeature(
  declared: string | undefined,
  feature: string,
  need: FeatureNeed,
): void {
  if (declared === undefined) return;
  if (pinAllows(declared, need.extension)) return;
  throw new OkmError(
    "OKM1812",
    `${feature} needs ${need.name} ${need.extension} or higher and PostgreSQL ${String(need.postgres)}. minPostgres: ${String(need.postgres)}. The declaration allows ${declared}.`,
    {
      fix: {
        summary: `Raise the ${need.name} pin to ${need.extension} or higher, and set minPostgres to ${String(need.postgres)}.`,
      },
    },
  );
}

function pinAllows(declared: string, minimum: string): boolean {
  const floor = /^>=(\d+(?:\.\d+)*)$/.exec(declared);
  const pinned = floor?.[1] ?? declared;
  if (!isExactVersion(pinned)) return false;
  return compareExtensionVersions(pinned, minimum) >= 0;
}
