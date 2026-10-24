/**
 * Open migration-lifecycle bugs the property test may hit.
 *
 * A failure whose case carries a listed feature is skipped with that id.
 * A4/A5 remove entries here as they fix them. Do not fix product code in the
 * lifecycle PR that owns this list.
 */

/** One known open bug the lifecycle property may encounter. */
export type KnownBug = {
  /** Stable N-id from the QA list. */
  readonly id: string;
  /** Schema feature that triggers the failure. */
  readonly feature: string;
  /** Tags on a generated case that count as this feature. */
  readonly tags: readonly string[];
  /** Optional substring of the failure message (any one is enough). */
  readonly messages?: readonly string[];
};

/**
 * Start list for the lifecycle property. A4/A5 delete rows as they land.
 */
export const KNOWN_BUGS: readonly KnownBug[] = [
  {
    id: "N-10",
    feature: "trigger WHEN spelling / parenthesis normalisation",
    tags: ["trigger-when"],
  },
  {
    id: "N-11",
    feature: "view under defineConfig({ namespace })",
    tags: ["namespace", "view"],
  },
  {
    id: "N-35",
    feature: "mixed-case identifiers round-trip",
    tags: ["mixed-case-name"],
  },
  {
    id: "N-36",
    feature: "identifiers that contain spaces",
    tags: ["space-name"],
  },
  {
    id: "N-37",
    feature: "identifiers with digits or embedded quotes",
    tags: ["digit-name", "quote-name"],
  },
  {
    id: "N-102",
    feature: "drop an indexed column while creating another index",
    tags: ["index-drop-while-create"],
  },
  {
    id: "N-118",
    feature: "adding one enum value",
    tags: ["enum-add-value"],
  },
  {
    id: "N-119",
    feature: "push rename of a table with an identity column",
    tags: ["identity-rename"],
  },
  {
    id: "N-123",
    feature: 'foreign keys with onDelete/onUpdate including explicit "no action"',
    tags: ["fk-no-action"],
  },
  {
    id: "N-126",
    feature: "generated columns after apply / push",
    tags: ["generated"],
  },
  {
    id: "N-135",
    feature: "domains and domain checks after apply / push",
    tags: ["domain"],
  },
  // Found by the lifecycle property (seed 42). Not yet on the QA N-list.
  {
    id: "NEW-1",
    feature: "partial index predicate / history differs after apply (drop+recreate same index)",
    tags: ["index-partial"],
    messages: ["history differs from the stored catalog"],
  },
];

/**
 * The first known bug that matches a failed case, if any.
 *
 * @param tags - Feature tags present on the case
 * @param message - Failure message
 * @returns The matching entry, or undefined
 */
export function matchKnownBug(tags: readonly string[], message: string): KnownBug | undefined {
  const present = new Set(tags);
  for (const bug of KNOWN_BUGS) {
    // Every listed tag must be on the case so a broad feature does not hide
    // unrelated failures.
    if (!bug.tags.every((tag) => present.has(tag))) continue;
    if (bug.messages !== undefined && bug.messages.length > 0) {
      if (!bug.messages.some((needle) => message.includes(needle))) continue;
    }
    return bug;
  }
  return undefined;
}
