/**
 * Seeded generators for factories.
 *
 * Mulberry32, a fixed word list, and a counter. No runtime dependency.
 * The same seed replays the same sequence (D199).
 */

import { OkmError } from "../../contracts/error.js";

const WORDS = [
  "amber",
  "basin",
  "cedar",
  "delta",
  "ember",
  "flint",
  "grove",
  "harbor",
  "ivory",
  "juniper",
  "kelp",
  "lattice",
  "maple",
  "north",
  "olive",
  "pebble",
  "quartz",
  "river",
  "spruce",
  "tide",
  "umbra",
  "violet",
  "willow",
  "yellow",
] as const;

const FIRST = ["Ada", "Grace", "Lin", "Edsger", "Barbara", "Alan", "Margaret"] as const;
const LAST = ["Lovelace", "Hopper", "Torvalds", "Dijkstra", "Liskov", "Kay", "Hamilton"] as const;

/** A seeded sequence and the values factories ask for. */
export type Rng = {
  /** Next unit interval, `[0, 1)`. */
  next(): number;
  /** Integer in `[0, bound)`. */
  int(bound: number): number;
  /** A version-4 UUID. The bits come from this sequence. */
  uuid(): string;
  /** `local@example.com`, unique for this sequence. */
  email(): string;
  /** A first and last name from the fixed lists. */
  name(): string;
  /** `count` words from the fixed list. */
  words(count: number): string;
  /** A boolean. */
  boolean(): boolean;
  /** A number in `[0, 1)`. */
  float(): number;
  /** An ISO date `YYYY-MM-DD` in 2020. */
  date(): string;
  /** One value from `list`. */
  pick<T>(list: readonly T[]): T;
  /** The next counter value, starting at 1. Text defaults append it. */
  counter(): number;
};

/**
 * Builds the sequence for `seed`.
 *
 * Seed `1` is the default. `0` is shifted so the first step is not a fixed point.
 *
 * @param seed - Integer seed
 * @returns The sequence
 */
export function rng(seed: number): Rng {
  if (!Number.isInteger(seed)) {
    throw new OkmError("invalid", `Factory seed must be an integer, got ${String(seed)}.`, {
      fix: { summary: "Pass testing(schema, { driver, seed }) an integer." },
    });
  }
  let state = (seed === 0 ? 0x9e3779b9 : seed) >>> 0;
  let count = 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (bound: number): number => {
    if (!Number.isInteger(bound) || bound <= 0) {
      throw new OkmError("invalid", `int bound must be a positive integer, got ${String(bound)}.`, {
        fix: { summary: "Pass a positive integer to int()." },
      });
    }
    return Math.floor(next() * bound);
  };
  const api: Rng = {
    next,
    int,
    uuid(): string {
      const bytes: number[] = [];
      for (let index = 0; index < 16; index += 1) bytes.push(Math.floor(next() * 256));
      const sixth = bytes[6] ?? 0;
      const eighth = bytes[8] ?? 0;
      bytes[6] = (sixth & 0x0f) | 0x40;
      bytes[8] = (eighth & 0x3f) | 0x80;
      const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    email(): string {
      count += 1;
      return `user${String(count)}@example.com`;
    },
    name(): string {
      const first = FIRST[int(FIRST.length)] ?? FIRST[0];
      const last = LAST[int(LAST.length)] ?? LAST[0];
      return `${first} ${last}`;
    },
    words(amount: number): string {
      if (!Number.isInteger(amount) || amount < 0) {
        throw new OkmError(
          "invalid",
          `words() needs a non-negative integer, got ${String(amount)}.`,
          { fix: { summary: "Pass words(n) with n greater than or equal to 0." } },
        );
      }
      const picked: string[] = [];
      for (let index = 0; index < amount; index += 1) {
        picked.push(WORDS[int(WORDS.length)] ?? WORDS[0]);
      }
      return picked.join(" ");
    },
    boolean(): boolean {
      return next() < 0.5;
    },
    float(): number {
      return next();
    },
    date(): string {
      const day = 1 + int(28);
      return `2020-01-${String(day).padStart(2, "0")}`;
    },
    pick<T>(list: readonly T[]): T {
      if (list.length === 0) {
        throw new OkmError("invalid", "pick() needs a list with one value.", {
          fix: { summary: "Pass a non-empty list to pick()." },
        });
      }
      const value = list[int(list.length)];
      if (value === undefined) {
        throw new OkmError("invalid", "pick() needs a list with one value.", {
          fix: { summary: "Pass a non-empty list to pick()." },
        });
      }
      return value;
    },
    counter(): number {
      count += 1;
      return count;
    },
  };
  return api;
}
