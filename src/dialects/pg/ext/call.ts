/**
 * SQL fragments for an extension function or operator.
 *
 * The fragment is the whole predicate, the same way `fragment` is. Values
 * are parameters. The schema and function names are quoted identifiers the
 * generator wrote.
 */

import { OkmError } from "../../../contracts/error.js";
import { sqlExpression, type Fragment, type FragmentPart } from "../ops/fragment.js";
import { quotedIdent } from "./using.js";

/**
 * `schema.fn(column, …) = schema.fn($1)`.
 *
 * @param schema - Install schema
 * @param name - Function name
 * @param value - Parameter
 * @returns A where fragment
 */
export function fnEqualsArg(schema: string, name: string, value: string): Fragment {
  const fn = `${quotedIdent(schema)}.${quotedIdent(name)}`;
  return sqlExpression(
    [
      { k: "t", s: `${fn}(` },
      { k: "c" },
      { k: "t", s: `) = ${fn}(` },
      { k: "p", v: value },
      { k: "t", s: ")" },
    ],
    true,
  );
}

/**
 * `schema.fn(column, $1) = $2::integer`.
 *
 * @param schema - Install schema
 * @param name - Function name
 * @param value - Text argument
 * @param distance - Integer the function result must equal
 * @returns A where fragment
 */
export function fnDistance(
  schema: string,
  name: string,
  value: string,
  distance: number,
): Fragment {
  if (!Number.isInteger(distance)) {
    throw new OkmError("OKM1120", `${name} distance must be an integer.`, {
      fix: { summary: "Pass a whole number of edits." },
    });
  }
  const fn = `${quotedIdent(schema)}.${quotedIdent(name)}`;
  return sqlExpression(
    [
      { k: "t", s: `${fn}(` },
      { k: "c" },
      { k: "t", s: ", " },
      { k: "p", v: value },
      { k: "t", s: ") = " },
      { k: "p", v: String(distance) },
      { k: "t", s: "::integer" },
    ],
    true,
  );
}

/**
 * `column <op> $1`, with an optional cast on the parameter.
 *
 * @param op - Operator token the generator wrote
 * @param value - Parameter
 * @param cast - SQL type to cast the parameter to, when the operator needs one
 * @returns A where fragment
 */
export function opArg(op: string, value: string, cast?: string): Fragment {
  const parts: FragmentPart[] = [{ k: "c" }, { k: "t", s: ` ${op} ` }, { k: "p", v: value }];
  if (cast !== undefined) parts.push({ k: "t", s: `::${cast}` });
  return sqlExpression(parts, true);
}

/**
 * `schema.fn()` as the whole predicate.
 *
 * @param schema - Install schema
 * @param name - Function name
 * @returns A where fragment
 */
export function bareCall(schema: string, name: string): Fragment {
  const fn = `${quotedIdent(schema)}.${quotedIdent(name)}`;
  return sqlExpression([{ k: "t", s: `${fn}()` }], true);
}

/**
 * `encode(schema.digest(column, $1), 'hex') = $2`.
 *
 * @param schema - Install schema
 * @param algorithm - Digest algorithm, a parameter
 * @param hex - Expected hex digest, a parameter
 * @returns A where fragment
 */
export function digestEquals(schema: string, algorithm: string, hex: string): Fragment {
  const fn = `${quotedIdent(schema)}.${quotedIdent("digest")}`;
  return sqlExpression(
    [
      { k: "t", s: `encode(${fn}(` },
      { k: "c" },
      { k: "t", s: ", " },
      { k: "p", v: algorithm },
      { k: "t", s: "), 'hex') = " },
      { k: "p", v: hex },
    ],
    true,
  );
}
