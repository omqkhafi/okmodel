/**
 * Text that did not come from OKModel's own checked identifiers.
 *
 * Bounded and marked untrusted; this reduces risk and does not eliminate it.
 * The word for this is not "sanitized". A caller may lower a cap. A caller
 * may not raise one.
 */

/** Where a string was read. The list is closed. */
export const UNTRUSTED_ORIGINS = [
  "schema.identifier",
  "schema.comment",
  "schema.enum",
  "schema.default",
  "constraint.name",
  "index.name",
  "migration.comment",
  "db.error",
  "db.object-name",
  "user.query",
  "package.json",
] as const;

/** One origin. */
export type UntrustedOrigin = (typeof UNTRUSTED_ORIGINS)[number];

/** One bounded string. Key order is the contract order. */
export type UntrustedText = {
  readonly untrusted: true;
  readonly origin: UntrustedOrigin;
  readonly text: string;
  readonly truncated: boolean;
  readonly modified: boolean;
};

/** Default cap for one string, in Unicode code points. */
export const STRING_CAP = 200;

/** Default cap for one response field, in Unicode code points. */
export const FIELD_CAP = 2000;

/**
 * An identifier OKModel's own schema code may put in a summary.
 *
 * Names read from a database catalog do not use this. They are untrusted.
 */
const CHECKED_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

const STRING_CAP_DEFAULT = STRING_CAP;
const FIELD_CAP_DEFAULT = FIELD_CAP;

const INDIC =
  /\p{Script=Devanagari}|\p{Script=Bengali}|\p{Script=Gurmukhi}|\p{Script=Gujarati}|\p{Script=Oriya}|\p{Script=Tamil}|\p{Script=Telugu}|\p{Script=Kannada}|\p{Script=Malayalam}|\p{Script=Sinhala}/u;

/**
 * Caps a caller may set. Each value may only go down.
 */
export type UntrustedCaps = {
  /** Code points kept in one string. Defaults to {@link STRING_CAP}. */
  readonly maxCodePoints?: number;
  /** Code points kept in one response field. Defaults to {@link FIELD_CAP}. */
  readonly fieldCodePoints?: number;
};

/**
 * Bounds one string and marks its origin.
 *
 * @param input - Text as it was read
 * @param origin - Where it was read
 * @param caps - Lower caps. A larger number stays at the default
 * @returns The object, keys in contract order
 */
export function untrustedText(
  input: string,
  origin: UntrustedOrigin,
  caps?: UntrustedCaps,
): UntrustedText {
  const cap = Math.min(
    downward(caps?.maxCodePoints, STRING_CAP_DEFAULT),
    downward(caps?.fieldCodePoints, FIELD_CAP_DEFAULT),
  );
  const normalized = input.normalize("NFC");
  const kept = keep(codePointsOf(normalized));
  const bounded = take(kept, cap);
  const text = String.fromCodePoint(...bounded);
  return {
    untrusted: true,
    origin,
    text,
    truncated: bounded.length < kept.length,
    modified: text !== input,
  };
}

/**
 * Reports whether OKModel's own schema may inline this name.
 *
 * @param name - One identifier
 * @returns `true` when the name matches {@link CHECKED_IDENTIFIER}
 */
function isCheckedIdentifier(name: string): boolean {
  return CHECKED_IDENTIFIER.test(name);
}

/**
 * A schema name as a string, or an untrusted object when it is not checked.
 *
 * @param name - Name from a schema or a statement
 * @param origin - Origin used when the name is not checked
 * @returns The string or the object
 */
export function checkedOrUntrusted(name: string, origin: UntrustedOrigin): string | UntrustedText {
  if (isCheckedIdentifier(name)) return name;
  return untrustedText(name, origin);
}

/**
 * Prints one untrusted value on its own, quoted.
 *
 * The line does not tell the reader to act on the text.
 *
 * @param value - Bounded text
 * @returns `untrusted <origin>: "<text>"`
 */
export function renderUntrusted(value: UntrustedText): string {
  return `untrusted ${value.origin}: ${JSON.stringify(value.text)}`;
}

function downward(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  const whole = Math.floor(requested);
  if (whole < 1) return 1;
  return Math.min(whole, ceiling);
}

function codePointsOf(text: string): readonly number[] {
  const points: number[] = [];
  for (const char of text) {
    const point = char.codePointAt(0);
    if (point !== undefined) points.push(point);
  }
  return points;
}

function keep(points: readonly number[]): number[] {
  const kept: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined || drop(point, points, index)) continue;
    const previous = kept[kept.length - 1];
    const before = kept.length > 1 ? kept[kept.length - 2] : undefined;
    if (previous === point && before === point && limitedMark(point)) continue;
    kept.push(point);
  }
  return kept.filter((point, index) => adjacency(point, kept, index));
}

function drop(point: number, points: readonly number[], index: number): boolean {
  if (point >= 0xd800 && point <= 0xdfff) return true;
  if (isNoncharacter(point)) return true;
  if (point >= 0xe0000 && point <= 0xe007f) return true;
  if (point >= 0xe0100 && point <= 0xe01ef) return true;
  if (point >= 0x180b && point <= 0x180f) return true;
  if (point === 0x200b || point === 0x2060 || point === 0xfeff) return true;
  if (point >= 0x2061 && point <= 0x2064) return true;
  if (point === 0x2028 || point === 0x2029) return true;
  if ((point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069)) return true;
  if (isPrivateUse(point)) return true;
  if (isControl(point)) return true;
  if (point >= 0xfe00 && point <= 0xfe0f) {
    const previous = index > 0 ? points[index - 1] : undefined;
    return !(
      (point === 0xfe0e || point === 0xfe0f) &&
      previous !== undefined &&
      isExtendedPictographic(previous)
    );
  }
  return false;
}

function adjacency(point: number, kept: readonly number[], index: number): boolean {
  if (point === 0x200e || point === 0x200f || point === 0x061c) {
    return besideLetter(kept[index - 1]) || besideLetter(kept[index + 1]);
  }
  if (point === 0x200c || point === 0x200d) {
    const previous = kept[index - 1];
    return previous !== undefined && isJoinerBase(previous);
  }
  return true;
}

function limitedMark(point: number): boolean {
  return (
    point === 0x200e || point === 0x200f || point === 0x061c || point === 0x200c || point === 0x200d
  );
}

function besideLetter(point: number | undefined): boolean {
  if (point === undefined) return false;
  return /\p{L}|\p{M}|\p{Nd}/u.test(String.fromCodePoint(point));
}

function isJoinerBase(point: number): boolean {
  const char = String.fromCodePoint(point);
  if (!/\p{L}|\p{M}/u.test(char)) return false;
  return /\p{Script=Arabic}|\p{Script=Hebrew}/u.test(char) || INDIC.test(char);
}

function isExtendedPictographic(point: number): boolean {
  return /\p{Extended_Pictographic}/u.test(String.fromCodePoint(point));
}

function isPrivateUse(point: number): boolean {
  return (
    (point >= 0xe000 && point <= 0xf8ff) ||
    (point >= 0xf0000 && point <= 0xffffd) ||
    (point >= 0x100000 && point <= 0x10fffd)
  );
}

function isControl(point: number): boolean {
  if (point === 0x09 || point === 0x0a) return false;
  return point <= 0x1f || (point >= 0x7f && point <= 0x9f);
}

function isNoncharacter(point: number): boolean {
  if (point >= 0xfdd0 && point <= 0xfdef) return true;
  return (point & 0xfffe) === 0xfffe;
}

function take(points: readonly number[], cap: number): number[] {
  if (points.length <= cap) return [...points];
  let end = cap;
  if (isMark(points[end] ?? 0)) {
    while (end > 0 && isMark(points[end - 1] ?? 0)) end -= 1;
    if (end > 0 && isLetter(points[end - 1] ?? 0)) end -= 1;
  }
  return points.slice(0, end);
}

function isMark(point: number): boolean {
  return /\p{M}/u.test(String.fromCodePoint(point));
}

function isLetter(point: number): boolean {
  return /\p{L}/u.test(String.fromCodePoint(point));
}
