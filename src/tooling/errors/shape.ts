/**
 * Extra fields on an `okm.cli/1` error object.
 *
 * The six fields X1 shipped stay first. These are additive. `OkmError` does
 * not grow a field for them: a producer attaches location and a machine edit
 * here, and the registry supplies the rest.
 */

import type { UntrustedText } from "../untrusted.js";

const DETAIL = Symbol.for("okm.cli.errorDetail");

/** Where a producer can point, when it knows. */
export type CliErrorLocation = {
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
};

/** A machine-applicable edit. One of insert or replace, with the file. */
export type CliFixEdit =
  | { readonly file: string; readonly insert: string }
  | { readonly file: string; readonly replace: string };

/** A remedy that does not bypass the check. */
export type CliSafeAlternative = {
  readonly text: string;
  readonly docs: string;
};

/** A bypass. A person writes the reason; the text never lives in `fix`. */
export type CliEscapeHatch = {
  readonly name: string;
  readonly requiresHumanReason: true;
  readonly docs: string;
};

/** Location, edit, or database text a producer attached to an error. */
export type CliErrorDetail = {
  readonly location?: CliErrorLocation;
  readonly fixEdit?: CliFixEdit;
  /** Database or catalog text. It is not copied into `summary` or `fix`. */
  readonly detail?: UntrustedText;
};

/**
 * Tokens that name a bypass.
 *
 * `summary` and `fix` must not contain one. The hatch list is the place
 * that names them.
 */
export const BYPASS_TOKENS = [
  "--force",
  "--allow-protected",
  "--allow-pooler",
  "--accept-unverified",
  "-- okm-allow",
  "okm-allow",
  "unscoped",
  ".all(",
] as const;

/**
 * Bypass tokens present in `text`.
 *
 * @param text - Summary or fix
 * @returns The tokens found, in list order
 */
export function bypassTokensIn(text: string): readonly string[] {
  return BYPASS_TOKENS.filter((token) => text.includes(token));
}

/**
 * Page path for one code.
 *
 * @param code - Spec code
 * @param anchor - Heading slug, when the link points at a section
 * @returns `docs/errors/<code>.md`, plus the anchor
 */
export function errorDocsPath(code: string, anchor?: string): string {
  const path = `docs/errors/${code}.md`;
  return anchor === undefined ? path : `${path}#${anchor}`;
}

/**
 * Remembers where an error was found, or a machine edit.
 *
 * The property is not enumerable, so logs and `JSON.stringify` of the
 * `OkmError` itself stay unchanged.
 *
 * @param error - Error about to be thrown
 * @param detail - Location, edit, or both
 * @returns The same error
 */
export function attachCliDetail<T extends object>(error: T, detail: CliErrorDetail): T {
  Object.defineProperty(error, DETAIL, { value: detail, enumerable: false });
  return error;
}

/**
 * Detail recorded by {@link attachCliDetail}.
 *
 * @param error - Caught value
 * @returns The detail, or `undefined`
 */
export function readCliDetail(error: unknown): CliErrorDetail | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value: unknown = Reflect.get(error, DETAIL);
  if (typeof value !== "object" || value === null) return undefined;
  return value as CliErrorDetail;
}
