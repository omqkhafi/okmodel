/**
 * Nearest-name hints for unknown tables, fields, presets, and options.
 *
 * One edit-distance helper. No dependency, and nothing runs at import.
 */

/**
 * Closest candidate to `input`, or `undefined` when none is close.
 *
 * Comparison ignores ASCII case. The returned spelling is the candidate's.
 *
 * @param input - The name that was not accepted
 * @param candidates - Accepted and reserved names
 * @returns A name to show after "did you mean"
 */
export function nearestName(input: string, candidates: readonly string[]): string | undefined {
  if (input.length === 0 || candidates.length === 0) return undefined;
  const limit = input.length <= 4 ? 1 : input.length <= 12 ? 2 : 3;
  let width = 0;
  for (const candidate of candidates) {
    if (candidate.length > width) width = candidate.length;
  }
  const prev = new Uint16Array(width + 1);
  const next = new Uint16Array(width + 1);
  let best: string | undefined;
  let bestDistance = limit;
  for (const candidate of candidates) {
    if (candidate === input) continue;
    const gap =
      candidate.length > input.length
        ? candidate.length - input.length
        : input.length - candidate.length;
    if (gap > bestDistance) continue;
    const distance = editDistance(input, candidate, bestDistance, prev, next);
    if (distance === undefined) continue;
    if (
      best === undefined ||
      distance < bestDistance ||
      (distance === bestDistance && candidate < best)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Levenshtein distance, or `undefined` when it would pass `cap`.
 *
 * `prev` and `next` are reused by the caller. They must be at least
 * `right.length + 1` long.
 */
function editDistance(
  left: string,
  right: string,
  cap: number,
  prev: Uint16Array,
  next: Uint16Array,
): number | undefined {
  const leftLength = left.length;
  const rightLength = right.length;
  if (leftLength === 0) return rightLength <= cap ? rightLength : undefined;
  if (rightLength === 0) return leftLength <= cap ? leftLength : undefined;
  for (let column = 0; column <= rightLength; column += 1) prev[column] = column;
  for (let row = 1; row <= leftLength; row += 1) {
    next[0] = row;
    let rowBest = row;
    const leftCode = left.charCodeAt(row - 1);
    for (let column = 1; column <= rightLength; column += 1) {
      const cost = sameLetter(leftCode, right.charCodeAt(column - 1)) ? 0 : 1;
      const deletion = (prev[column] ?? 0) + 1;
      const insertion = (next[column - 1] ?? 0) + 1;
      const substitution = (prev[column - 1] ?? 0) + cost;
      let value = deletion < insertion ? deletion : insertion;
      if (substitution < value) value = substitution;
      next[column] = value;
      if (value < rowBest) rowBest = value;
    }
    if (rowBest > cap) return undefined;
    for (let column = 0; column <= rightLength; column += 1) prev[column] = next[column] ?? 0;
  }
  const distance = prev[rightLength] ?? cap + 1;
  return distance <= cap ? distance : undefined;
}

function sameLetter(left: number, right: number): boolean {
  if (left === right) return true;
  const leftFold = left >= 65 && left <= 90 ? left + 32 : left;
  const rightFold = right >= 65 && right <= 90 ? right + 32 : right;
  return leftFold === rightFold;
}
