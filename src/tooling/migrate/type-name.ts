/**
 * One spelling for a SQL type name in a diff (D191).
 *
 * The catalog keeps the spelling the schema wrote. Introspection keeps
 * `format_type`. Both sides of a comparison pass through here, so
 * `timestamptz` and `timestamp with time zone` are one type. A different
 * length, precision, or type stays different. An unknown name is returned
 * as written.
 */

/**
 * Maps a schema spelling or a `format_type` spelling to the long form.
 *
 * Modifiers and array ranks stay. `varchar(20)[]` becomes
 * `character varying(20)[]`.
 *
 * @param typeName - Type name from a catalog definition
 * @returns The Postgres long spelling
 */
export function canonicalTypeName(typeName: string): string {
  const suffix = arraySuffix(typeName);
  const scalar = suffix.length === 0 ? typeName : typeName.slice(0, -suffix.length);
  return canonicalScalar(scalar) + suffix;
}

function arraySuffix(typeName: string): string {
  let end = typeName.length;
  let suffix = "";
  while (end >= 2 && typeName.endsWith("[]", end)) {
    suffix = `[]${suffix}`;
    end -= 2;
  }
  return suffix;
}

function canonicalScalar(typeName: string): string {
  const varying = /^(?:varchar|character varying)(\(\d+\))$/.exec(typeName);
  if (varying !== null) return `character varying${varying[1] ?? ""}`;
  const fixed = /^(?:char|character)(\(\d+\))$/.exec(typeName);
  if (fixed !== null) return `character${fixed[1] ?? ""}`;
  const timed =
    /^(timestamp with time zone|timestamp without time zone|time with time zone|time without time zone|timestamptz|timestamp|timetz|time)(\(\d+\))?$/.exec(
      typeName,
    );
  if (timed !== null) return canonicalTime(timed[1] ?? "", timed[2] ?? "");
  const numeric = /^(?:decimal|numeric)(\(\d+(?:,\d+)?\))?$/.exec(typeName);
  if (numeric !== null) return `numeric${numeric[1] ?? ""}`;
  switch (typeName) {
    case "int":
    case "int4":
    case "integer":
      return "integer";
    case "int8":
    case "bigint":
      return "bigint";
    case "int2":
    case "smallint":
      return "smallint";
    case "bool":
    case "boolean":
      return "boolean";
    case "float8":
    case "double precision":
      return "double precision";
    case "float4":
    case "real":
      return "real";
    default:
      return typeName;
  }
}

function canonicalTime(name: string, precision: string): string {
  if (name === "timestamptz" || name === "timestamp with time zone") {
    return `timestamp${precision} with time zone`;
  }
  if (name === "timestamp" || name === "timestamp without time zone") {
    return `timestamp${precision} without time zone`;
  }
  if (name === "timetz" || name === "time with time zone") {
    return `time${precision} with time zone`;
  }
  return `time${precision} without time zone`;
}
