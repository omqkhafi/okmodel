/**
 * Rule objects `v` returns.
 *
 * The engine interprets `k`. This module does not import the engine. Each
 * rule registers the client hook so a bundled app still has it when the
 * module side effect is dropped.
 */

import { armValidation } from "./bind.js";

/** Trims a string. Other values are left as they are. */
export type TrimRule = { readonly k: "trim" };

/** Lowercases a string. Other values are left as they are. */
export type LowerRule = { readonly k: "lower" };

/** Rejects a string that is not an email. `key` is the issue message. */
export type EmailRule = { readonly k: "email"; readonly key: string };

/** Minimum string length or number. `key` is the issue message. */
export type MinRule = { readonly k: "min"; readonly n: number; readonly key: string };

/** A caller predicate. `false` records `key` at `path`. */
export type PredicateRule = {
  readonly k: "rule";
  readonly fn: (value: unknown) => boolean;
  readonly path: string;
  readonly key: string;
};

/** Runs the inner rule only on insert or only on update. */
export type WhenRule = {
  readonly k: "when";
  readonly op: "insert" | "update";
  readonly rule: unknown;
};

/** Following rules in the same list run only on this operation, until the next phase. */
export type PhaseRule = { readonly k: "phase"; readonly op: "insert" | "update" };

/** One object `v` can return. */
export type Rule =
  | TrimRule
  | LowerRule
  | EmailRule
  | MinRule
  | PredicateRule
  | WhenRule
  | PhaseRule;

/**
 * Validation rules.
 *
 * Transforms (`trim`, `lowercase`) run before checks. `onInsert()` and
 * `onUpdate()` with no argument scope the rules that follow them in the same
 * list. Passed a rule, they scope that rule only.
 */
export const v = {
  /**
   * Removes leading and trailing whitespace from a string.
   *
   * @returns A transform rule
   */
  trim(): TrimRule {
    armValidation();
    return { k: "trim" };
  },
  /**
   * Lowercases a string.
   *
   * @returns A transform rule
   */
  lowercase(): LowerRule {
    armValidation();
    return { k: "lower" };
  },
  /**
   * Requires an email address.
   *
   * @param key - Issue message key
   * @returns A check rule
   */
  email(key: string): EmailRule {
    armValidation();
    return { k: "email", key };
  },
  /**
   * Requires a string at least `n` characters long, or a number at least `n`.
   *
   * @param n - Minimum length or value
   * @param key - Issue message key
   * @returns A check rule
   */
  min(n: number, key: string): MinRule {
    armValidation();
    return { k: "min", n, key };
  },
  /**
   * Records `key` at `path` when `fn` returns false.
   *
   * On a field, `fn` receives the field value. In `$row`, it receives the row
   * after field transforms.
   *
   * @param fn - Predicate. `true` accepts the value
   * @param path - Issue path segment
   * @param key - Issue message key
   * @returns A check rule
   */
  rule<T>(fn: (value: T) => boolean, path: string, key: string): PredicateRule {
    armValidation();
    return { k: "rule", fn: fn as (value: unknown) => boolean, path, key };
  },
  /**
   * Limits a rule, or the rules that follow, to insert.
   *
   * @param rule - One rule. Omitted, the rules after this marker are limited
   * @returns A phase marker or a wrapped rule
   */
  onInsert(rule?: unknown): PhaseRule | WhenRule {
    armValidation();
    return rule === undefined ? { k: "phase", op: "insert" } : { k: "when", op: "insert", rule };
  },
  /**
   * Limits a rule, or the rules that follow, to update.
   *
   * @param rule - One rule. Omitted, the rules after this marker are limited
   * @returns A phase marker or a wrapped rule
   */
  onUpdate(rule?: unknown): PhaseRule | WhenRule {
    armValidation();
    return rule === undefined ? { k: "phase", op: "update" } : { k: "when", op: "update", rule };
  },
};
