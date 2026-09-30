/**
 * A schema name that cannot collide with another call.
 *
 * @returns A lowercase identifier of the form `s_` plus 32 hex characters
 */
export function isolatedSchemaName(): string {
  return `s_${crypto.randomUUID().replaceAll("-", "")}`;
}
