/**
 * A procedure argument inside a typed body.
 *
 * The printer qualifies it as `"routine"."name"`. An unqualified parameter
 * that matches a column is the column, so the qualification is required.
 */

/** Symbol a typed body uses for one argument. */
export const PROC_ARG = Symbol.for("okm.proc.arg");

/** One argument the body printer qualifies. */
export type ProcArg = {
  readonly [PROC_ARG]: { readonly routine: string; readonly name: string };
};

/**
 * Marks one argument so the printer qualifies it.
 *
 * @param routine - Procedure name
 * @param name - Argument name
 * @returns The marker `literal` prints
 */
export function procArg(routine: string, name: string): ProcArg {
  return { [PROC_ARG]: { routine, name } };
}

/**
 * Reads a procedure-argument marker.
 *
 * @param value - A value from a statement
 * @returns The routine and argument, or `undefined` when it is not a marker
 */
export function procArgOf(
  value: unknown,
): { readonly routine: string; readonly name: string } | undefined {
  if (typeof value !== "object" || value === null || !(PROC_ARG in value)) return undefined;
  const slot = (value as ProcArg)[PROC_ARG];
  if (typeof slot?.name !== "string" || typeof slot.routine !== "string") return undefined;
  return slot;
}
