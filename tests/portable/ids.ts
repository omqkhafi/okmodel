/**
 * OKID and UUID checks that Node, Bun, and Deno can all run.
 *
 * The vectors follow okengine's `src/okid.test.ts`. The public `okid()`
 * returns a generator; these checks call the vendored function for the vectors
 * and the public generator for the column-default shape.
 */

import {
  OKID_ALPHABET,
  OKID_DEFAULT_LENGTH,
  OKID_LOOKALIKE_CHARS,
  OKID_MAX_LENGTH,
  OKID_MAX_PREFIX_LENGTH,
  OKID_MIN_LENGTH,
  OKID_SORTABLE_ALPHABET,
  OKID_SORTABLE_MIN_LENGTH,
} from "../../src/runtime/ids/okid-shared.js";
import { okid as mintOkid } from "../../src/runtime/ids/okid.js";
import { okid, uuidv4, uuidv7 } from "../../src/runtime/ids/index.js";

const SAMPLE = 1_000;

/**
 * Runs the id vectors. Throws on the first miss.
 */
export function runIdChecks(): void {
  check("default length is 21", () => {
    const id = mintOkid();
    assert(id.length === OKID_DEFAULT_LENGTH, id);
    assert(id.length === 21, id);
  });
  check("bare lengths", () => {
    for (const length of [10, 16, 21, 32])
      assert(mintOkid(length).length === length, String(length));
  });
  check("options length", () => {
    assert(mintOkid({}).length === 21, "empty");
    assert(mintOkid({ length: 24 }).length === 24, "24");
  });
  check("alphabet", () => {
    const allowed = new Set(OKID_ALPHABET);
    for (let index = 0; index < SAMPLE; index += 1) {
      for (const char of mintOkid()) assert(allowed.has(char), char);
    }
  });
  check("url safe", () => {
    for (let index = 0; index < 200; index += 1) {
      const id = mintOkid();
      assert(encodeURIComponent(id) === id, id);
    }
  });
  check("no duplicates in 20000", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 20_000; index += 1) seen.add(mintOkid());
    assert(seen.size === 20_000, String(seen.size));
  });
  check("lookalikes removed", () => {
    const banned = new Set(OKID_LOOKALIKE_CHARS);
    for (let index = 0; index < SAMPLE; index += 1) {
      for (const char of mintOkid({ lookAlikes: false })) assert(!banned.has(char), char);
    }
  });
  check("digits only", () => {
    for (let index = 0; index < 200; index += 1) {
      assert(
        /^\d+$/.test(mintOkid({ lowercase: false, uppercase: false, symbols: false })),
        "digits",
      );
    }
  });
  check("rejects bad lengths", () => {
    for (const bad of [0, -1, 7, OKID_MAX_LENGTH + 1, Number.NaN, 1.5, Infinity]) {
      assertThrows(() => mintOkid(bad), "length");
      assertThrows(() => mintOkid({ length: bad }), "options");
    }
  });
  check("boundary lengths", () => {
    assert(mintOkid(OKID_MIN_LENGTH).length === OKID_MIN_LENGTH, "min");
    assert(mintOkid(OKID_MAX_LENGTH).length === OKID_MAX_LENGTH, "max");
  });
  check("empty alphabet", () => {
    assertThrows(
      () => mintOkid({ numbers: false, lowercase: false, uppercase: false, symbols: false }),
      "empty",
    );
  });
  check("sortable floor", () => {
    assertThrows(() => mintOkid({ sortable: true, length: 15 }), "15");
    assert(mintOkid({ sortable: true }).length === 21, "default");
    assert(mintOkid({ sortable: true, length: 16 }).length === 16, "16");
  });
  check("uses getRandomValues", () => {
    const cryptoObject = globalThis.crypto;
    const original = cryptoObject.getRandomValues.bind(cryptoObject);
    let calls = 0;
    cryptoObject.getRandomValues = ((view: ArrayBufferView) => {
      calls += 1;
      return original(view);
    }) as typeof cryptoObject.getRandomValues;
    try {
      mintOkid();
      assert(calls > 0, "calls");
    } finally {
      cryptoObject.getRandomValues = original;
    }
  });
  check("sortable timestamp is stable inside one millisecond", () => {
    withNow(1_700_000_000_000, () => {
      const left = mintOkid({ sortable: true });
      const right = mintOkid({ sortable: true });
      assert(left.slice(0, 8) === right.slice(0, 8), left);
      assert(left.slice(8) !== right.slice(8), "tail");
    });
  });
  check("sortable order follows time", () => {
    const ids: string[] = [];
    let now = 1_700_000_000_000;
    withClock(
      () => now,
      () => {
        for (let index = 0; index < 50; index += 1) {
          ids.push(mintOkid({ sortable: true }));
          now += 3;
        }
      },
    );
    const sorted = [...ids].sort();
    assert(sorted.join("\n") === ids.join("\n"), "order");
  });
  check("sortable alphabet is codepoint order", () => {
    const alphabet = OKID_SORTABLE_ALPHABET;
    assert(alphabet.length === 64, String(alphabet.length));
    for (let index = 1; index < alphabet.length; index += 1) {
      const current = alphabet.charCodeAt(index);
      const previous = alphabet.charCodeAt(index - 1);
      assert(current > previous, alphabet[index] ?? "");
    }
  });
  check("prefix keeps the body length", () => {
    const id = mintOkid({ prefix: "usr_" });
    assert(id.startsWith("usr_"), id);
    assert(id.length === 4 + OKID_DEFAULT_LENGTH, String(id.length));
  });
  check("prefix plus sortable", () => {
    withNow(1_700_000_000_000, () => {
      const left = mintOkid({ prefix: "evt_", sortable: true, length: 16 });
      const right = mintOkid({ prefix: "evt_", sortable: true, length: 16 });
      assert(left.startsWith("evt_"), left);
      assert(left.length === 20, String(left.length));
      assert(left.slice(4, 12) === right.slice(4, 12), "time");
      assert(left.slice(12) !== right.slice(12), "tail");
    });
  });
  check("prefix rejects outside characters and oversized labels", () => {
    assertThrows(() => mintOkid({ prefix: "usr:" }), "colon");
    assertThrows(() => mintOkid({ prefix: "a".repeat(OKID_MAX_PREFIX_LENGTH + 1) }), "long");
    const id = mintOkid({ prefix: "a".repeat(OKID_MAX_PREFIX_LENGTH) });
    assert(id.length === OKID_MAX_PREFIX_LENGTH + OKID_DEFAULT_LENGTH, String(id.length));
  });
  check("entropy floors", () => {
    const bits = OKID_DEFAULT_LENGTH * Math.log2(OKID_ALPHABET.length);
    assert(Math.abs(bits - 126) < 1e-6, String(bits));
    assert(OKID_MIN_LENGTH * Math.log2(64) === 48, "min");
    assert((OKID_SORTABLE_MIN_LENGTH - 8) * Math.log2(64) === 48, "sortable");
  });
  check("public okid returns a generator", () => {
    const next = okid({ prefix: "usr_", sortable: true, length: 16 });
    const left = next();
    const right = next();
    assert(left.startsWith("usr_"), left);
    assert(left.length === 20, String(left.length));
    assert(left !== right, "distinct");
    assert(okid(16)().length === 16, "length");
  });
  check("uuid versions", () => {
    const fourth = uuidv4();
    const seventh = uuidv7();
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fourth),
      fourth,
    );
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(seventh),
      seventh,
    );
    assert(uuidv4() !== uuidv4(), "uuidv4 distinct");
  });
}

function check(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name}: ${message}`);
  }
}

function assert(value: boolean, detail: string): void {
  if (!value) throw new Error(detail);
}

function assertThrows(run: () => unknown, detail: string): void {
  try {
    run();
  } catch (error) {
    if (error instanceof RangeError) return;
    throw new Error(`${detail} threw ${error instanceof Error ? error.name : "unknown"}`);
  }
  throw new Error(`${detail} did not throw`);
}

function withNow(now: number, run: () => void): void {
  withClock(() => now, run);
}

function withClock(now: () => number, run: () => void): void {
  const clock = Date as unknown as { now: () => number };
  const original = clock.now;
  clock.now = now;
  try {
    run();
  } finally {
    clock.now = original;
  }
}
