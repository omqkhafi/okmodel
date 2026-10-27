/**
 * Dialect feature registry (F1).
 *
 * One frozen table per dialect pack. This module is types only. It is not
 * imported by the runtime entry.
 */

/** How a dialect pack provides a feature. */
export type Support = "native" | "emulated" | "refused";

/**
 * Capability flag a registry entry names as its gate.
 *
 * A conformance test that reads this flag is a consumer. A skip with no
 * registry gate is not.
 */
export type CapabilityGate = "transactions" | "stream" | "listen" | "cancel";

/**
 * One feature in a dialect registry.
 *
 * `proof` is the literal test title that shows the entry. A `refused` entry
 * also needs a test titled `refusal:<key>`.
 */
export type FeatureEntry = {
  readonly support: Support;
  /** Lowest server version for this family, when the feature has one. */
  readonly since?: string;
  /** What an emulation costs or changes, one line. */
  readonly cost?: string;
  /** Portable alternative when the feature is refused, one line. */
  readonly alternative?: string;
  /**
   * Refusal code when `support` is `refused`.
   *
   * OKM1861 and OKM1868–OKM1879 are accepted. Any other value is OKM1860.
   */
  readonly code?: string;
  /** Literal test title that proves this entry. */
  readonly proof: string;
  /**
   * Adapter flag this feature requires.
   *
   * Set only when a conformance test reads that flag.
   */
  readonly gate?: CapabilityGate;
};

/** A frozen feature table. Keys are stable dotted names. */
export type Registry = Readonly<Record<string, FeatureEntry>>;

/** One emulated feature a schema uses, with its cost line. */
export type EmulatedNote = {
  readonly feature: string;
  readonly cost: string;
};
