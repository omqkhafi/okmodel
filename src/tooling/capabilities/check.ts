/**
 * Compares a schema's features with a dialect registry.
 *
 * A refused feature throws OKM1860. An emulated feature returns a note.
 * Native features are silent. The Postgres table has no refused entries;
 * tests pass a fixture registry to prove the refusal path.
 */

import { CAPABILITY_NAMES } from "../../adapters/capabilities.js";
import { OkmError } from "../../contracts/error.js";
import type { CapabilityGate, EmulatedNote, FeatureEntry, Registry } from "./types.js";

/**
 * Handbook anchor for one refusal code.
 *
 * @param code - `OKM1860`, or a reserved refusal code the entry named
 * @returns The errors page for that code
 */
function refusalDocs(code: string): string {
  // Joined so a source scan sees the errors page, not an uninterpolated template.
  return "https://okm.omqkhafi.dev/docs/reference/errors#" + code.toLowerCase();
}

/** Doctor page for a feature the dialect refuses. */
export const FEATURE_REFUSAL_DOCS = refusalDocs("OKM1860");

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

/**
 * Problems in the link between registry gates and gated conformance cases.
 *
 * A gate on an entry needs a case that names that gate or names a key whose
 * entry uses it. A gated case that names neither a registry key nor a
 * capability gate fails. Proof and refusal titles stay in {@link registryProblems}.
 *
 * @param registry - Dialect table, or a fixture
 * @param gatedFeatures - Keys and gates passed to `gated`
 * @returns Problem lines. Empty when every gate has a case and every case names a real key
 */
export function gateCoverageProblems(
  registry: Registry,
  gatedFeatures: readonly string[],
): readonly string[] {
  const problems: string[] = [];
  const gates = new Set<CapabilityGate>();
  for (const entry of Object.values(registry)) {
    if (entry.gate !== undefined) gates.add(entry.gate);
  }
  for (const name of CAPABILITY_NAMES) gates.add(name);
  for (const gate of gates) {
    const consumed = gatedFeatures.some((feature) => {
      if (feature === gate) return true;
      return registry[feature]?.gate === gate;
    });
    if (!consumed) problems.push(`${gate}: gate has no conformance case`);
  }
  for (const feature of gatedFeatures) {
    if ((CAPABILITY_NAMES as readonly string[]).includes(feature)) continue;
    if (registry[feature] === undefined) {
      problems.push(`${feature}: gated case names a key that is not in the registry`);
    }
  }
  return problems;
}

function refuse(dialect: string, feature: string, entry: FeatureEntry): never {
  const since = entry.since === undefined ? "" : ` First supported in ${entry.since}.`;
  const alternative = entry.alternative ?? "Use a feature this dialect provides.";
  const code = refusalCode(entry);
  throw new OkmError(code, `${dialect} refuses ${feature}.${since}`, {
    fix: { summary: `${alternative} ${refusalDocs(code)}` },
  });
}

/**
 * Code the registry entry names, when it is a reserved feature-refusal code.
 *
 * OKM1861 and OKM1868–OKM1879 are accepted. Anything else stays OKM1860.
 * The fix links to that code's page. The same set exits 5.
 *
 * @param entry - Refused registry row
 * @returns The entry code, or OKM1860
 */
function refusalCode(entry: FeatureEntry): string {
  const code = entry.code;
  if (typeof code === "string" && /^OKM1861$|^OKM186[89]$|^OKM187\d$/.test(code)) return code;
  return "OKM1860";
}
