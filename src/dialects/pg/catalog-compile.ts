/**
 * Builds the catalog document from descriptors `schema()` already validated.
 *
 * Not a static import of `schema()`. The first `.catalog` read loads this file.
 * A query never reads it. Plan goldens and `catalogHash` see the same objects as before.
 */

import { OkmError } from "../../contracts/error.js";
import { catalog } from "../../contracts/catalog/build.js";
import { enumType } from "../../contracts/catalog/enum.js";
import { extensionObject } from "../../contracts/catalog/extension.js";
import { identitySequenceName } from "../../contracts/catalog/identifier.js";
import {
  compareText,
  constraint,
  index as catalogIndex,
  sequence,
  table as catalogTable,
} from "../../contracts/catalog/object.js";
import type { Catalog, CatalogObject, ObjectIdentity } from "../../contracts/catalog/types.js";
import { compileColumn } from "./compile.js";
import type {
  CatalogCompileInput,
  CompileColumn,
  CompileTable,
  HeldCheck,
} from "./catalog-draft.js";
import { compositeMark, rangeMark } from "./column-mark.js";
import { clearTypeGrants, rememberTypeGrant } from "./composite-mark.js";
import { refuseTemporal } from "./floor.js";
import { holdGenerated } from "./generated-hold.js";
import { definition } from "./misuse.js";
import { declaredRlsSchemas, readEventCompiler } from "./event/slot.js";
import { readPolicyCompiler } from "./policy-slot.js";
import { rememberGrants } from "./role/grant-slot.js";
import { readSeriesCompiler } from "./series-slot.js";

/**
 * Compiles one schema's catalog.
 *
 * Object order matches the old jobs: each table, then its columns, keys, indexes,
 * and checks, then every foreign key, then enums, extensions, and policies.
 *
 * @param input - Descriptors captured while the query model was built
 * @returns The catalog `catalogHash` and migrate read
 */
export function compileCatalog(input: CatalogCompileInput): Catalog {
  clearTypeGrants();
  const objects: CatalogObject[] = [];
  for (const item of input.prepared) emitTable(input, item, objects);
  for (const fk of input.foreignKeys) objects.push(constraint(fk));
  for (const [name, note] of [...input.enums.entries()].sort((left, right) =>
    compareText(left[0], right[0]),
  )) {
    objects.push(
      enumType({
        namespace: input.namespace,
        name,
        labels: note.labels,
        provenance: note.provenance,
        ...(note.comment !== undefined ? { comment: note.comment } : {}),
      }),
    );
    const schemaName = input.namespace.form === "static" ? input.namespace.name : "public";
    rememberTypeGrant(schemaName, name, note.grants);
  }
  contributeListed(input.extensions, objects, input.names);
  contributeListed(input.functions, objects, input.names, input.tables);
  contributeListed(input.schemaTraits, objects, input.names);
  for (const item of input.tables) {
    contributeListed(
      (item.options as { readonly traits?: unknown } | undefined)?.traits,
      objects,
      input.names,
    );
  }
  contributeListed(input.triggers, objects, input.names);
  contributeListed(input.views, objects, input.names);
  if (
    objects.some(
      (object) =>
        object.kind === "constraint" &&
        (object.definition.withoutOverlaps === true || object.definition.period === true),
    )
  ) {
    refuseTemporal(input.requires);
  }
  if (
    input.extra.gist &&
    !objects.some((object) => object.kind === "extension" && object.identity.name === "btree_gist")
  ) {
    objects.push(
      extensionObject({
        name: "btree_gist",
        schema: "public",
        provenance: { origin: "file", name: "btree_gist" },
      }),
    );
  }
  if (Array.isArray(input.sequences)) {
    for (const item of input.sequences) {
      (
        item as {
          contribute(namespace: CatalogCompileInput["namespace"], objects: CatalogObject[]): void;
        }
      ).contribute(input.namespace, objects);
    }
  }
  rememberSequenceGrants(input.prepared);
  if (tablesWantPolicies(input.tables)) {
    const compile = readPolicyCompiler();
    if (compile === undefined) {
      throw new OkmError(
        "OKM1924",
        "Import okmodel/policy before schema() when a table sets policies or rls.",
        { fix: { summary: "Import okmodel/policy in the file that calls schema()." } },
      );
    }
    compile(
      input.tables,
      (tsName) => {
        const item = input.prepared.find((candidate) => candidate.tsName === tsName);
        if (item === undefined) return undefined;
        return {
          sqlName: item.sqlName,
          parent: item.parent,
          provenance: item.provenance,
          column: (field) => {
            const column = item.byField.get(field);
            return column === undefined
              ? undefined
              : { sql: column.sqlName, dataType: column.dataType };
          },
        };
      },
      objects,
    );
  }
  const rlsSchemas = declaredRlsSchemas(input.triggers);
  if (rlsSchemas !== undefined) {
    refuseDisabledRls(input.tables, objects, rlsSchemas, input.names);
    const events = readEventCompiler();
    if (events === undefined) {
      throw new OkmError(
        "OKM1931",
        "Import okmodel/event before schema() when a trigger uses enableRls.",
        { fix: { summary: "Import okmodel/event in the file that calls schema()." } },
      );
    }
    events.stampRls(objects, rlsSchemas);
  }
  return catalog(objects);
}

function emitTable(input: CatalogCompileInput, item: CompileTable, objects: CatalogObject[]): void {
  objects.push(
    catalogTable({
      namespace: input.namespace,
      name: item.sqlName,
      provenance: item.provenance,
      ...(item.options?.comment !== undefined ? { comment: item.options.comment } : {}),
      ...(item.tableDependencies.length > 0 ? { dependencies: item.tableDependencies } : {}),
    }),
  );
  for (const column of item.columns) emitColumn(input, item, column, objects);
  if (item.primaryKey !== undefined) objects.push(constraint(item.primaryKey));
  for (const exclusion of item.exclusions) objects.push(constraint(exclusion));
  for (const unique of item.namedUniques) objects.push(constraint(unique));
  for (const index of item.indexes) objects.push(catalogIndex(index));
  for (const check of item.checks) emitCheck(objects, check);
}

function emitColumn(
  input: CatalogCompileInput,
  item: CompileTable,
  column: CompileColumn,
  objects: CatalogObject[],
): void {
  bindGenerated(column, item);
  const identity = column.state.identity;
  const draft = column.state.seriesDraft;
  if (identity !== undefined) {
    const seqName = identitySequenceName(item.sqlName, column.sqlName);
    const seq = sequence({
      namespace: input.namespace,
      name: seqName,
      dataType:
        column.state.baseType === "integer" || column.state.baseType === "smallint"
          ? column.state.baseType
          : "bigint",
      provenance: item.provenance,
      dependencies: [{ kind: "table", namespace: input.namespace, name: item.sqlName }],
      ...(identity.comment !== undefined ? { comment: identity.comment } : {}),
      ...(identity.start !== undefined ? { start: identity.start } : {}),
      ...(identity.increment !== undefined ? { increment: identity.increment } : {}),
      ...(identity.min !== undefined ? { min: identity.min } : {}),
      ...(identity.max !== undefined ? { max: identity.max } : {}),
      ...(identity.cache !== undefined ? { cache: identity.cache } : {}),
      ...(identity.cycle === true ? { cycle: true } : {}),
    });
    objects.push(seq);
    pushCompiled(objects, column, {
      parent: item.parent,
      name: column.sqlName,
      provenance: column.provenance,
      dependencies: [seq.identity],
    });
    return;
  }
  if (draft !== undefined) {
    const compile = readSeriesCompiler();
    if (compile === undefined) {
      definition("Import sequence from okmodel/seq before schema() when a column uses sequence().");
    }
    compile({
      tableName: item.tsName,
      sqlName: item.sqlName,
      columnSql: column.sqlName,
      column,
      draft,
      options: item.options,
      namespace: input.namespace,
      provenance: item.provenance,
      parent: item.parent,
      columnProvenance: column.provenance,
      columns: item.byField,
      handles: item.handles,
      tableDependencies: item.tableDependencies,
      objects,
      finish: (dependencies) =>
        pushCompiled(objects, column, {
          parent: item.parent,
          name: column.sqlName,
          provenance: column.provenance,
          ...(dependencies !== undefined ? { dependencies } : {}),
        }),
    });
    return;
  }
  pushCompiled(objects, column, {
    parent: item.parent,
    name: column.sqlName,
    provenance: column.provenance,
  });
}

function emitCheck(objects: CatalogObject[], check: HeldCheck): void {
  const made = constraint(check.input);
  if (check.enforced === false) (made as { enforced?: false }).enforced = false;
  objects.push(made);
}

function bindGenerated(column: CompileColumn, item: CompileTable): void {
  const generated = column.state.generated;
  if (
    generated === undefined ||
    generated.build === undefined ||
    generated.expression !== undefined
  ) {
    return;
  }
  (generated as { expression: string }).expression = holdGenerated(
    generated.build,
    item.handles,
    (field) => item.byField.get(field)?.sqlName ?? field,
  );
}

function pushCompiled(
  objects: CatalogObject[],
  column: CompileColumn,
  spec: {
    readonly parent: CompileTable["parent"];
    readonly name: string;
    readonly provenance: CompileColumn["provenance"];
    readonly dependencies?: readonly ObjectIdentity[];
  },
): void {
  const compiled = compileColumn(column, spec);
  objects.push(compiled.column);
  if (compiled.check !== undefined) objects.push(compiled.check);
  if (compiled.unique !== undefined) objects.push(compiled.unique);
  column.state.domain?.emit?.(spec.parent.namespace, spec.provenance, objects);
  const ranged = rangeMark(column.state.encode);
  if (ranged?.emit !== undefined) {
    ranged.emit(spec.parent, spec.provenance, objects, spec.name, column.state.nullable);
  }
  const mark = compositeMark(column.state.encode);
  if (mark !== undefined) {
    if (column.state.generated?.stored === false) {
      definition(
        `A virtual generated column cannot use composite type ${mark.type}. PostgreSQL refuses it (0A000). Store the column.`,
      );
    }
    mark.emit(spec.parent, spec.provenance, objects, spec.name, column.state.nullable);
  }
}

function rememberSequenceGrants(prepared: readonly CompileTable[]): void {
  for (const item of prepared) {
    for (const column of item.columns) {
      const grants = column.state.identity?.grants;
      if (grants === undefined) continue;
      rememberGrants(
        "sequence",
        "public",
        identitySequenceName(item.sqlName, column.sqlName),
        grants,
      );
    }
  }
  for (const item of prepared) {
    for (const column of item.columns) {
      const draft = column.state.seriesDraft;
      if (
        draft?.grants === undefined ||
        draft.reset !== undefined ||
        draft.when !== undefined ||
        (draft.scope?.length ?? 0) > 0
      ) {
        continue;
      }
      const name =
        draft.name.length > 0 ? draft.name : identitySequenceName(item.sqlName, column.sqlName);
      rememberGrants("sequence", "public", name, draft.grants);
    }
  }
}

/**
 * `rls: false` in a schema `enableRls` covers is OKM1931.
 *
 * The policy compiler omits row security when it is off, so the catalog
 * object cannot tell an explicit false from a default. The table options
 * still can. A table's schema is the namespace on its catalog object after
 * trigger placement. A table that has not moved is `public`.
 *
 * @param tables - Tables passed to `schema()`
 * @param objects - Catalog objects built so far, after trigger placement
 * @param schemas - Schema names the preset covers
 * @param names - SQL names for the tables
 */
function refuseDisabledRls(
  tables: CatalogCompileInput["tables"],
  objects: readonly CatalogObject[],
  schemas: readonly string[],
  names: CatalogCompileInput["names"],
): void {
  const covered = new Set(schemas);
  const home = new Map<string, string>();
  for (const object of objects) {
    if (object.kind !== "table" || object.identity.namespace.form !== "static") continue;
    home.set(object.identity.name, object.identity.namespace.name);
  }
  for (const item of tables) {
    const schemaName = home.get(names.table(item)) ?? "public";
    if (!covered.has(schemaName)) continue;
    const options = item.options as { readonly rls?: unknown } | undefined;
    const rls = options?.rls;
    const off =
      rls === false ||
      (typeof rls === "object" &&
        rls !== null &&
        "enable" in rls &&
        (rls as { readonly enable?: unknown }).enable === false);
    if (!off) continue;
    throw new OkmError(
      "OKM1931",
      `Table ${item.name} sets rls: false, and enableRls covers schema ${schemaName}.`,
      { fix: { summary: "Remove rls: false, or take the table's schema out of enableRls." } },
    );
  }
}

function tablesWantPolicies(tables: CatalogCompileInput["tables"]): boolean {
  for (const item of tables) {
    const options = item.options as
      | { readonly policies?: unknown; readonly rls?: unknown }
      | undefined;
    if (options?.policies !== undefined || options?.rls !== undefined) return true;
  }
  return false;
}

function contributeListed(
  value: unknown,
  objects: CatalogObject[],
  names: CatalogCompileInput["names"],
  sources?: readonly object[],
): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const produced = (
      item as {
        contribute(
          peers: unknown,
          built: unknown,
          names: CatalogCompileInput["names"],
          sources?: readonly object[],
        ): unknown;
      }
    ).contribute(value, objects, names, sources);
    if (Array.isArray(produced)) {
      for (const object of produced) objects.push(object as CatalogObject);
    }
  }
}
