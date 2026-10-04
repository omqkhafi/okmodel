/**
 * Resolver and emitter of a `manyThrough` relation.
 *
 * The relation object carries both. `schema()` calls the resolver, and the
 * planner calls the emitter with its own helpers, so a schema that has no
 * `manyThrough` ships none of this. A join row or target in another tenant or
 * archived never shows: the same planner predicates apply to both tables.
 */

import { catalogError, throwNamed } from "../../contracts/error.js";
import type { RelationEdge, RelationScope } from "./relations.js";
import type { RelationModel, ThroughEmit } from "./model.js";

const emit: ThroughEmit = (planner, schema, relation, child, sink, parent, alias, depth) => {
  const through = relation.through;
  const join = through === undefined ? undefined : planner.indexes(schema).get(through.table);
  if (through === undefined || join === undefined) {
    return catalogError(
      "OKM1020",
      `Relation ${relation.name} names a join table that is not in the schema.`,
    );
  }
  const { quote } = planner;
  const joinAlias = `j${alias}`;
  sink.mark(`via:${through.table}`);
  sink.text(`${quote(join.model.sql)} ${joinAlias} join ${quote(child.model.sql)} ${alias} on `);
  for (let index = 0; index < through.local.length; index += 1) {
    const local = through.local[index];
    const remote = through.remote[index];
    if (local === undefined || remote === undefined) continue;
    if (index > 0) sink.text(" and ");
    sink.text(`${alias}.${quote(remote)} = ${joinAlias}.${quote(local)}`);
  }
  sink.text(" where ");
  planner.join(sink, parent, joinAlias, relation);
  planner.where(schema, join, undefined, sink, joinAlias, depth + 1, true);
};

/**
 * Resolves a `manyThrough` declaration against the schema's foreign keys.
 *
 * @param scope - What `schema()` knows
 * @param table - Related table name
 * @param through - Join table name
 * @param from - Join table field that references the declaring table, when ambiguous
 * @param to - Join table field that references the related table, when ambiguous
 * @returns The resolved relation, carrying its emitter
 */
export function resolveThrough(
  scope: RelationScope,
  table: string,
  through: string,
  from: string | undefined,
  to: string | undefined,
): RelationModel {
  for (const name of [table, through]) {
    if (!scope.tables.includes(name)) {
      throwNamed(
        "OKM1020",
        name,
        scope.tables,
        `Relation ${scope.owner}.${scope.name} names ${name}, which is not in the schema. Accepted names: ${scope.tables.join(", ")}.`,
      );
    }
  }
  const toOwner = pick(scope, through, scope.owner, from, `${scope.owner}.${scope.name}`, "from");
  const toTable = pick(scope, through, table, to, `${scope.owner}.${scope.name}`, "to");
  if (toOwner === toTable) {
    catalogError(
      "OKM1021",
      `Relation ${scope.owner}.${scope.name} uses ${toOwner.fromField} on ${through} for both ends. Pass from and to.`,
    );
  }
  return {
    name: scope.name,
    kind: "many",
    table,
    local: toOwner.remote,
    remote: toOwner.local,
    through: { table: through, local: toTable.local, remote: toTable.remote, emit },
  };
}

function pick(
  scope: RelationScope,
  through: string,
  target: string,
  field: string | undefined,
  label: string,
  end: "from" | "to",
): RelationEdge {
  const matches = scope.edges.filter(
    (edge) =>
      edge.fromTable === through &&
      edge.toTable === target &&
      (field === undefined || edge.fromField === field),
  );
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return only;
  const fields = matches.map((edge) => edge.fromField).sort();
  catalogError(
    "OKM1021",
    `Relation ${label} through ${through} is ambiguous at ${end}. Accepted columns: ${fields.length === 0 ? "(none)" : fields.join(", ")}.`,
  );
}
