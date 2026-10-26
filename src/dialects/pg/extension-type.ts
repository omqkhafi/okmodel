/**
 * Type spelling for a column whose type belongs to an extension.
 *
 * `format_type` qualifies the name when the extension schema is not on
 * `search_path`: `ltree` installed in `extensions` reads back as
 * `extensions.ltree`. The schema writes `ltree`. Both are that type.
 */

const ARRAY_TAIL = /(?:\[\])+$/;

/**
 * Drops one extension-schema qualifier from a type name.
 *
 * `extensions.ltree` with schema `extensions` is `ltree`. `extensions.ltree[]`
 * is `ltree[]`. A name that is already unqualified is unchanged. A quoted
 * schema matches `format_type` (`"My Ext".ltree`).
 *
 * @param typeName - `format_type` text or the type the schema stored
 * @param schema - Schema the extension is installed in
 * @returns The type without that qualifier
 */
export function visibleExtensionType(typeName: string, schema: string): string {
  const suffix = ARRAY_TAIL.exec(typeName)?.[0] ?? "";
  const scalar = typeName.slice(0, typeName.length - suffix.length);
  for (const prefix of qualifierPrefixes(schema)) {
    if (!scalar.startsWith(prefix)) continue;
    const rest = scalar.slice(prefix.length);
    if (rest.length === 0) continue;
    return rest + suffix;
  }
  return typeName;
}

function qualifierPrefixes(schema: string): readonly string[] {
  const quoted = `"${schema.replaceAll('"', '""')}".`;
  if (/^[a-z_][a-z0-9_]*$/.test(schema)) return [`${schema}.`, quoted];
  return [quoted];
}
