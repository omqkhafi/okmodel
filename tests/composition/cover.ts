/**
 * Deterministic pairwise cover of the composition factors.
 *
 * Every pair of values from two factors appears in at least one case.
 * Factor order and value order are the tie-break, so the list does not move
 * between runs.
 */

export const OPERATIONS = [
  "insert",
  "update-id",
  "update-filter",
  "claim",
  "atomic",
  "delete",
  "archive",
  "find",
  "page",
  "stream",
  "aggregate",
] as const;

/** One generated composition case. */
export type CompositionCase = {
  readonly versioned: boolean;
  readonly archivable: boolean;
  readonly tenancy: "none" | "column" | "composite";
  readonly conceal: "none" | "hidden" | "sensitive";
  readonly batch: "db" | "tx";
  readonly isolation: "default" | "serializable";
  readonly casing: "verbatim" | "snake" | "camel";
  readonly operation: (typeof OPERATIONS)[number];
};

const FACTOR_VALUES = {
  versioned: [false, true],
  archivable: [false, true],
  tenancy: ["none", "column", "composite"],
  conceal: ["none", "hidden", "sensitive"],
  batch: ["db", "tx"],
  isolation: ["default", "serializable"],
  casing: ["verbatim", "snake", "camel"],
  operation: OPERATIONS,
} as const;

const KEYS = Object.keys(FACTOR_VALUES) as (keyof typeof FACTOR_VALUES)[];

type PartialCase = { [K in keyof CompositionCase]?: CompositionCase[K] };

/**
 * Builds the pairwise cover.
 *
 * @returns Cases in the order the greedy search produced them
 */
export function compositionCover(): readonly CompositionCase[] {
  const uncovered = new Set(allPairs());
  const cases: CompositionCase[] = [];
  while (uncovered.size > 0) {
    let best: CompositionCase | undefined;
    let bestScore = -1;
    for (const id of uncovered) {
      const candidate = complete(id, uncovered);
      const score = coveredBy(candidate, uncovered);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best === undefined || bestScore < 1) throw new Error("pairwise cover stalled");
    cases.push(best);
    for (const id of pairsOf(best)) uncovered.delete(id);
  }
  return cases;
}

/**
 * Pair ids this case covers. Used by the unit test.
 *
 * @param item - One case
 * @returns `factor=value|factor=value` ids, keys in factor order
 */
export function pairsOf(item: CompositionCase): readonly string[] {
  const ids: string[] = [];
  for (let i = 0; i < KEYS.length; i += 1) {
    const left = KEYS[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < KEYS.length; j += 1) {
      const right = KEYS[j];
      if (right === undefined) continue;
      ids.push(pairId(left, item[left], right, item[right]));
    }
  }
  return ids;
}

/** Every value pair the factors can form. */
export function allPairs(): readonly string[] {
  const ids: string[] = [];
  for (let i = 0; i < KEYS.length; i += 1) {
    const left = KEYS[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < KEYS.length; j += 1) {
      const right = KEYS[j];
      if (right === undefined) continue;
      for (const a of FACTOR_VALUES[left]) {
        for (const b of FACTOR_VALUES[right]) ids.push(pairId(left, a, right, b));
      }
    }
  }
  return ids;
}

function complete(id: string, uncovered: ReadonlySet<string>): CompositionCase {
  const partial: PartialCase = {};
  for (const side of id.split("|")) {
    const eq = side.indexOf("=");
    const key = side.slice(0, eq) as keyof CompositionCase;
    partial[key] = parseValue(key, side.slice(eq + 1));
  }
  for (const key of KEYS) {
    if (partial[key] !== undefined) continue;
    let best = FACTOR_VALUES[key][0];
    let bestScore = -1;
    for (const value of FACTOR_VALUES[key]) {
      const trial = { ...partial, [key]: value };
      const score = scoreAssigned(trial, uncovered);
      if (score > bestScore) {
        best = value;
        bestScore = score;
      }
    }
    partial[key] = best as CompositionCase[typeof key];
  }
  return partial as CompositionCase;
}

function scoreAssigned(partial: PartialCase, uncovered: ReadonlySet<string>): number {
  const present = KEYS.filter((key) => partial[key] !== undefined);
  let score = 0;
  for (let i = 0; i < present.length; i += 1) {
    const left = present[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < present.length; j += 1) {
      const right = present[j];
      if (right === undefined) continue;
      const id = pairId(left, partial[left], right, partial[right]);
      if (uncovered.has(id)) score += 1;
    }
  }
  return score;
}

function coveredBy(item: CompositionCase, uncovered: ReadonlySet<string>): number {
  let score = 0;
  for (const id of pairsOf(item)) if (uncovered.has(id)) score += 1;
  return score;
}

function pairId(left: string, a: unknown, right: string, b: unknown): string {
  return `${left}=${String(a)}|${right}=${String(b)}`;
}

function parseValue(key: keyof CompositionCase, raw: string): CompositionCase[typeof key] {
  if (key === "versioned" || key === "archivable") {
    return (raw === "true") as CompositionCase[typeof key];
  }
  return raw as CompositionCase[typeof key];
}
