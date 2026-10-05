/**
 * Seeds and run counts for the 0.2 gate property tests.
 *
 * CI uses the fixed seed below, so a red run is the same red run on a rerun and
 * on a laptop. A failure prints the seed and the replay command. Set
 * `OKM_PROPERTY_SEED` to try another seed and `OKM_PROPERTY_SCALE` to multiply
 * the run counts (a soak run uses 10 or more).
 */

import fc from "fast-check";

/** The seed CI runs with. */
export const GATE_SEED = Number(process.env.OKM_PROPERTY_SEED ?? "20261005");

/**
 * Run count for a property after the scale is applied.
 *
 * @param base - Runs at scale 1
 * @returns At least 1
 */
export function gateRuns(base: number): number {
  const scale = Number(process.env.OKM_PROPERTY_SCALE ?? "1");
  return Math.max(1, Math.round(base * (Number.isFinite(scale) ? scale : 1)));
}

/** Failures worth reporting, so the test can print them again at the end. */
export const gateFailures: string[] = [];

/**
 * Runs a property with the gate seed and prints the seed on failure.
 *
 * @param name - Test name, repeated in the failure line
 * @param property - The fast-check property
 * @param base - Runs at scale 1
 */
export async function assertGate<T>(
  name: string,
  property: fc.IAsyncProperty<T> | fc.IProperty<T>,
  base: number,
): Promise<void> {
  try {
    await fc.assert(property, {
      seed: GATE_SEED,
      numRuns: gateRuns(base),
      // The fast-check report names the counterexample; the line below names the replay.
      verbose: fc.VerbosityLevel.None,
    });
  } catch (error) {
    const line = `[gate-property] ${name} failed. Replay: OKM_PROPERTY_SEED=${String(GATE_SEED)} bun test (seed ${String(GATE_SEED)}, ${String(gateRuns(base))} runs)`;
    gateFailures.push(line);
    console.error(line);
    throw error;
  }
}
