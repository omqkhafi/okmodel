/**
 * Client generators.
 *
 * A generator fills a column on insert. It is not a database default, so it
 * stays off the catalog and its hash. Built-ins are marked by name so
 * `connect({ generators })` can replace them.
 */

/** Property that marks a function as a client generator. */
export const CLIENT_DEFAULT: unique symbol = Symbol.for("okmodel.clientDefault");

/** Built-in generator names, plus a caller-supplied function. */
export type GeneratorName = "uuidv4" | "uuidv7" | "okid" | "function";

/** Scalar options stored with a named generator. OKID uses these. */
export type GeneratorOptions = Readonly<Record<string, string | number | boolean>>;

/**
 * What insert calls when a column was omitted.
 *
 * `label` is the catalog-output word for a client default. The catalog
 * document itself does not store it.
 */
export type ClientFill = {
  readonly label: "client";
  readonly name: GeneratorName;
  readonly options?: GeneratorOptions;
  readonly call: () => unknown;
};

/** A function `.default()` and `schema({ defaults: { id } })` accept. */
export type ClientGenerator<T = string> = (() => T) & {
  readonly [CLIENT_DEFAULT]: {
    readonly label: "client";
    readonly name: Exclude<GeneratorName, "function">;
    readonly options?: GeneratorOptions;
  };
};

/**
 * Replacements for the built-in generators, keyed by name.
 *
 * A test passes fixed functions here. A custom function with no name is left
 * alone.
 */
export type IdGenerators = {
  readonly uuidv4?: () => string;
  readonly uuidv7?: () => string;
  readonly okid?: () => string;
};

/**
 * Marks `call` as a named client generator.
 *
 * @typeParam T - Value the generator returns
 * @param call - Function that produces one value
 * @param name - Built-in name `connect({ generators })` can replace
 * @param options - Scalar options stored beside the name
 * @returns The same function, marked
 */
export function clientGenerator<T>(
  call: () => T,
  name: Exclude<GeneratorName, "function">,
  options?: GeneratorOptions,
): ClientGenerator<T> {
  const marked = call as ClientGenerator<T>;
  Object.defineProperty(marked, CLIENT_DEFAULT, {
    value: options === undefined ? { label: "client", name } : { label: "client", name, options },
    enumerable: false,
  });
  return marked;
}

/**
 * Reads a client generator from a `.default()` argument.
 *
 * A marked built-in keeps its name. Any other function is a custom generator.
 *
 * @param value - Argument passed to `.default()` or `defaults.id`
 * @returns The fill insert should call, or `undefined` when `value` is a literal
 */
export function readClientGenerator(value: unknown): ClientFill | undefined {
  if (typeof value !== "function") return undefined;
  const mark = (value as { readonly [CLIENT_DEFAULT]?: unknown })[CLIENT_DEFAULT];
  if (isMark(mark)) return { label: "client", name: mark.name, call: value as () => unknown };
  return { label: "client", name: "function", call: value as () => unknown };
}

type GeneratorMark = {
  readonly label: "client";
  readonly name: Exclude<GeneratorName, "function">;
  readonly options?: GeneratorOptions;
};

function isMark(value: unknown): value is GeneratorMark {
  if (typeof value !== "object" || value === null) return false;
  const name = (value as { readonly name?: unknown }).name;
  return (
    (value as { readonly label?: unknown }).label === "client" &&
    typeof name === "string" &&
    name !== "function"
  );
}
