/**
 * Compares a schema's features with a dialect registry.
 *
 * A refused feature throws OKM1860. An emulated feature returns a note.
 * Native features are silent. The Postgres table has no refused entries;
 * tests pass a fixture registry to prove the refusal path.
 */

import { OkmError } from "../../contracts/error.js";
import type { EmulatedNote, FeatureEntry, Registry } from "./types.js";

/** Doctor page for a feature the dialect refuses. */
export const FEATURE_REFUSAL_DOCS = "https://okm.omqkhafi.dev/docs/reference/errors#okm1860";

/**
 * Notes for emulated features in `features`. Does not throw.
 *
 * @param features - Keys the schema uses
 * @param registry - Dialect table
 * @returns Cost lines, in feature order
 */
export function emulationOf(
  features: readonly string[],
  registry: Registry,
): readonly EmulatedNote[] {
  const notes: EmulatedNote[] = [];
  for (const feature of features) {
    const entry = registry[feature];
    if (entry?.support !== "emulated" || entry.cost === undefined) continue;
    notes.push({ feature, cost: entry.cost });
  }
  return notes;
}

/**
 * Refuses a feature the registry marks `refused` and returns emulation notes.
 *
 * @param features - Keys the schema uses
 * @param registry - Dialect table
 * @param dialect - Dialect name in the error
 * @returns Emulation notes. Empty when every used feature is native
 * @throws OkmError OKM1860
 */
export function assertSupported(
  features: readonly string[],
  registry: Registry,
  dialect: string,
): readonly EmulatedNote[] {
  for (const feature of features) {
    const entry = registry[feature];
    if (entry?.support === "refused") refuse(dialect, feature, entry);
  }
  return emulationOf(features, registry);
}

/**
 * Text for CLI stdout. Empty when there is nothing to say.
 *
 * @param notes - Notes from {@link assertSupported}
 * @returns One line per note, or `""`
 */
export function formatEmulation(notes: readonly EmulatedNote[]): string {
  if (notes.length === 0) return "";
  return notes.map((note) => `emulated ${note.feature}: ${note.cost}\n`).join("");
}

/**
 * Problems in a registry given the literal test titles of the suite.
 *
 * A missing proof fails. A refused entry without `refusal:<key>` fails.
 *
 * @param registry - Dialect table, or a fixture
 * @param titles - Literal `test("...")` titles
 * @returns Problem lines. Empty when the table matches the suite
 */
export function registryProblems(
  registry: Registry,
  titles: ReadonlySet<string>,
): readonly string[] {
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(registry)) {
    if (!titles.has(entry.proof)) {
      problems.push(`${key}: proof "${entry.proof}" is not a test title`);
    }
    if (entry.support !== "refused") continue;
    if (!titles.has(`refusal:${key}`)) {
      problems.push(`${key}: refused entry has no refusal:${key} test`);
    }
    if (entry.alternative === undefined || entry.alternative.length === 0) {
      problems.push(`${key}: refused entry has no alternative`);
    }
    if (entry.code === undefined) problems.push(`${key}: refused entry has no code`);
  }
  return problems;
}

function refuse(dialect: string, feature: string, entry: FeatureEntry): never {
  const since = entry.since === undefined ? "" : ` First supported in ${entry.since}.`;
  const alternative = entry.alternative ?? "Use a feature this dialect provides.";
  throw new OkmError("OKM1860", `${dialect} refuses ${feature}.${since}`, {
    fix: { summary: `${alternative} ${FEATURE_REFUSAL_DOCS}` },
  });
}
