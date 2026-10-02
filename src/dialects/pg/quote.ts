/**
 * SQL literal quoting for catalog default expressions.
 *
 * Only single quotes are escaped. Postgres `standard_conforming_strings` is
 * on, so a backslash stays a backslash.
 */

/**
 * Wraps text in a SQL string literal.
 *
 * @param value - Raw text
 * @returns A single-quoted literal
 */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Quotes one element of a Postgres array literal.
 *
 * Bare tokens are integers, decimals, and booleans. Everything else is a
 * double-quoted element.
 *
 * @param encoded - Element text from the scalar codec
 * @param raw - When true, a numeric or boolean token may stay bare
 * @returns One array-literal element
 */
export function arrayElement(encoded: string, raw: boolean): string {
  if (raw && (encoded === "true" || encoded === "false" || isBareNumber(encoded))) {
    return encoded;
  }
  return `"${encoded.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Reports whether `encoded` is a bare numeric token.
 */
function isBareNumber(encoded: string): boolean {
  let pattern = bareNumber;
  pattern ??= /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  bareNumber = pattern;
  return pattern.test(encoded);
}

let bareNumber: RegExp | undefined;
