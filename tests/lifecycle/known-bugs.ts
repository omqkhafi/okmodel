/**
 * Open migration-lifecycle bugs the property test may hit.
 *
 * A failure matches only when its message contains a listed needle and the
 * case carries that bug's feature. Tags alone never skip a case. Entries the
 * grammar cannot produce are omitted. Product bugs stay; generator mistakes
 * are fixed in the grammar instead.
 */

/** One known open bug the lifecycle property may encounter. */
export type KnownBug = {
  /** Stable id. `NEW-*` is a bug found by this property. */
  readonly id: string;
  /** What the case must be doing. */
  readonly feature: string;
  /** Feature tags that must all be present on the case. */
  readonly tags: readonly string[];
  /** Substrings of the failure message. One is enough, and one is required. */
  readonly messages: readonly string[];
};

/**
 * Bugs this property can still reach.
 *
 * N-10, N-11, N-102, N-118, N-119, and N-123 were fixed by #537.
 * N-35 (varchar picklist / IN check, OKM1520), N-36 (CASE check, OKM1122),
 * N-37 (`picklist().array()`, malformed array literal), N-126 (OKM1531
 * own-column exemption), and N-135 (INVALID index after a killed build) are
 * real bugs this grammar does not generate.
 */
export const KNOWN_BUGS: readonly KnownBug[] = [
  {
    id: "NEW-2",
    feature:
      "generated column whose expression quotes identifiers, generated('(\"a\" + 1)'): Postgres prints it unquoted and migrate check reports history differs forever",
    tags: ["generated"],
    messages: ["history differs from the stored catalog"],
  },
];

/**
 * The first known bug that matches a failed case, if any.
 *
 * @param tags - Feature tags present on the case
 * @param message - Failure message, including the OKM code when there is one
 * @returns The matching entry, or undefined
 */
export function matchKnownBug(tags: readonly string[], message: string): KnownBug | undefined {
  const present = new Set(tags);
  for (const bug of KNOWN_BUGS) {
    if (bug.messages.length === 0 || bug.tags.length === 0) continue;
    if (!bug.messages.some((needle) => message.includes(needle))) continue;
    if (!bug.tags.every((tag) => present.has(tag))) continue;
    return bug;
  }
  return undefined;
}
