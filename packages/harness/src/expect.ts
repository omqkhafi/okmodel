/**
 * Assertions for the conformance suites.
 *
 * The suites run under `bun test` and under `okm driver test`. This is the
 * same small set of matchers either runner can load, without `bun:test`.
 */

/** Matchers on one value. */
type Matcher = {
  toBe(expected: unknown): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toEqual(expected: unknown): void;
  toHaveLength(expected: number): void;
  toBeInstanceOf(expected: new (...args: never[]) => unknown): void;
  toContain(expected: string): void;
  toBeLessThan(expected: number): void;
  toMatchObject(expected: object): void;
  readonly not: { toBe(expected: unknown): void };
};

/**
 * Asserts `actual`.
 *
 * A mismatch throws. The message names the matcher and both values.
 *
 * @param actual - Value under test
 * @returns Matchers
 */
export function expect(actual: unknown): Matcher {
  const fail = (matcher: string, expected: unknown): void => {
    throw new Error(`${matcher}: ${preview(actual)} vs ${preview(expected)}`);
  };
  return {
    toBe(expected) {
      if (!Object.is(actual, expected)) fail("toBe", expected);
    },
    toBeNull() {
      if (actual !== null) fail("toBeNull", null);
    },
    toBeUndefined() {
      if (actual !== undefined) fail("toBeUndefined", undefined);
    },
    toEqual(expected) {
      if (!deepEqual(actual, expected)) fail("toEqual", expected);
    },
    toHaveLength(expected) {
      const length = lengthOf(actual);
      if (length !== expected) fail("toHaveLength", expected);
    },
    toBeInstanceOf(expected) {
      if (!instanceOf(actual, expected)) fail("toBeInstanceOf", expected.name);
    },
    toContain(expected) {
      if (typeof actual === "string") {
        if (!actual.includes(expected)) fail("toContain", expected);
        return;
      }
      if (Array.isArray(actual) && actual.some((item) => Object.is(item, expected))) return;
      fail("toContain", expected);
    },
    toBeLessThan(expected) {
      if (typeof actual !== "number" || !(actual < expected)) fail("toBeLessThan", expected);
    },
    toMatchObject(expected) {
      if (!matchObject(actual, expected)) fail("toMatchObject", expected);
    },
    not: {
      toBe(expected) {
        if (Object.is(actual, expected)) fail("not.toBe", expected);
      },
    },
  };
}

function lengthOf(value: unknown): number | undefined {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  return undefined;
}

function instanceOf(value: unknown, expected: new (...args: never[]) => unknown): boolean {
  return (typeof value === "object" || typeof value === "function") && value instanceof expected;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]),
  );
}

function matchObject(actual: unknown, expected: object): boolean {
  if (typeof actual !== "object" || actual === null) return false;
  const record = actual as Record<string, unknown>;
  const wanted = expected as Record<string, unknown>;
  return Object.keys(wanted).every((key) => {
    const item = wanted[key];
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      return matchObject(record[key], item);
    }
    return deepEqual(record[key], item);
  });
}

function preview(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function") return value.name === "" ? "function" : value.name;
  try {
    const text = JSON.stringify(value);
    if (text !== undefined) return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    // A circular value still needs a label.
  }
  return String(value);
}
