/**
 * Grants remembered on a view, function, or schema while `schema()` builds.
 *
 * The catalog object does not store the option. Tooling reads it when it
 * attaches roles. A later `schema()` call for the same name replaces the slot.
 */

const slots = new Map<string, unknown>();
const batches = new WeakSet<object>();

/**
 * Clears grants from an earlier schema the first time this schema contributes.
 *
 * @param scope - The schema object `contribute` receives
 */
export function beginGrantBatch(scope: object): void {
  if (batches.has(scope)) return;
  batches.add(scope);
  slots.clear();
}

/**
 * Remembers `grants` for one object.
 *
 * @param kind - `view`, `materializedView`, `function`, or `namespace`
 * @param schema - Schema name
 * @param name - Object name
 * @param grants - The option, stored as given
 */
export function rememberGrants(kind: string, schema: string, name: string, grants: unknown): void {
  if (grants === undefined) return;
  slots.set(`${kind}\0${schema}\0${name}`, grants);
}

/**
 * Reads the grants remembered for one object.
 *
 * @param kind - Object kind
 * @param schema - Schema name
 * @param name - Object name
 * @returns The option, or `undefined` when the builder did not set one
 */
export function readGrants(kind: string, schema: string, name: string): unknown {
  return slots.get(`${kind}\0${schema}\0${name}`);
}

/**
 * Whether any builder remembered a `grants` option.
 *
 * @returns True when at least one object set `grants`
 */
export function hasRememberedGrants(): boolean {
  return slots.size > 0;
}

/**
 * Drops grants remembered for a previous schema.
 *
 * `schema()` calls this before it asks each object to contribute, so one
 * process can build two schemas.
 */
export function clearGrants(): void {
  slots.clear();
}
