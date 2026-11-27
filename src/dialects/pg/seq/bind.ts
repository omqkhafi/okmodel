/**
 * Copies a series onto the catalog when `schema()` is read.
 *
 * Importing `okmodel/seq` installs it. A schema that never uses a series does not load it.
 */

import { identitySequenceName } from "../../../contracts/catalog/identifier.js";
import { sequence } from "../../../contracts/catalog/object.js";
import type { ObjectIdentity, SeriesDefinition } from "../../../contracts/catalog/types.js";
import { holdGenerated } from "../generated-hold.js";
import { definition } from "../misuse.js";
import {
  counterSeries,
  installSeriesCompiler,
  viaSeries,
  type SeriesCompiler,
  type SeriesDraft,
} from "../series-slot.js";

const compile: SeriesCompiler = (input) => {
  const counter = counterSeries(input.draft, input.options);
  const seqName =
    input.draft.name.length > 0
      ? input.draft.name
      : identitySequenceName(input.sqlName, input.columnSql);
  if (!counter) {
    (input.column.state as { defaultSql?: string }).defaultSql = `nextval('${seqName}'::regclass)`;
    const identity: ObjectIdentity = {
      kind: "sequence",
      namespace: input.namespace,
      name: seqName,
    };
    input.tableDependencies.push(identity);
    if (
      !input.objects.some(
        (object) => object.kind === "sequence" && object.identity.name === seqName,
      )
    ) {
      input.objects.push(
        sequence({
          namespace: input.namespace,
          name: seqName,
          dataType: input.draft.as,
          provenance: input.provenance,
          ...(input.draft.comment !== undefined ? { comment: input.draft.comment } : {}),
          ...(input.draft.start !== undefined ? { start: input.draft.start } : {}),
          ...(input.draft.increment !== undefined ? { increment: input.draft.increment } : {}),
          ...(input.draft.min !== undefined ? { min: input.draft.min } : {}),
          ...(input.draft.max !== undefined ? { max: input.draft.max } : {}),
          ...(input.draft.cache !== undefined ? { cache: input.draft.cache } : {}),
          ...(input.draft.cycle === true ? { cycle: true } : {}),
        }),
      );
    }
    input.finish([identity]);
    return;
  }
  if (input.draft.grants !== undefined) {
    definition(`Sequence ${seqName} is a counter and does not take grants.`);
  }
  (input.column.state as { series?: SeriesDefinition }).series = seriesRecord(
    input.tableName,
    seqName,
    input.draft,
    input.options,
    input.columns,
    input.handles,
  );
  input.finish();
};

installSeriesCompiler(compile);

function seriesRecord(
  tableName: string,
  name: string,
  draft: SeriesDraft,
  options: object | undefined,
  columns: ReadonlyMap<string, { readonly sqlName: string; readonly dataType: string }>,
  handles: Readonly<Record<string, { readonly name: string }>>,
): SeriesDefinition {
  const tenantKeys =
    (options as { readonly tenantKeys?: readonly string[] } | undefined)?.tenantKeys ?? [];
  const extra = draft.scope ?? [];
  if (viaSeries(options) && tenantKeys.length === 0 && extra.length === 0) {
    definition(
      `Table ${tableName} uses via() and needs scope on sequence(). A via() table has no tenant column.`,
    );
  }
  const fields: string[] = [];
  for (const field of [...tenantKeys, ...extra]) {
    if (!fields.includes(field)) fields.push(field);
  }
  const scope = fields.map((field) => {
    const found = columns.get(field);
    if (found === undefined) {
      definition(`Series ${name} scope ${field} is not a column of ${tableName}.`);
    }
    return { name: found.sqlName, type: found.dataType };
  });
  let byType: string | undefined;
  let byName: string | undefined;
  if (draft.by !== undefined) {
    const found = columns.get(draft.by);
    if (found === undefined)
      definition(`Series ${name} by ${draft.by} is not a column of ${tableName}.`);
    byName = found.sqlName;
    byType = found.dataType;
    if (byType !== "date" && byType !== "timestamp" && byType !== "timestamptz") {
      definition(`Series ${name} by ${draft.by} must be date, timestamp, or timestamptz.`);
    }
  }
  if (draft.reset !== undefined && byName === undefined) {
    definition(`Series ${name} resets and needs by, the date column.`);
  }
  if (
    draft.reset !== undefined &&
    byType === "timestamptz" &&
    (draft.at === undefined || draft.at.length === 0)
  ) {
    definition(
      `Series ${name} resets a timestamptz and needs at, a time zone such as Asia/Riyadh.`,
    );
  }
  const when =
    draft.when === undefined
      ? undefined
      : holdGenerated(
          draft.when as (columns: Readonly<Record<string, { readonly name: string }>>) => unknown,
          handles as Readonly<Record<string, import("../table.js").ColumnHandle>>,
          (field) => columns.get(field)?.sqlName ?? field,
        );
  return {
    name,
    as: draft.as,
    start: draft.start ?? "1",
    increment: draft.increment ?? "1",
    counter: true,
    ...(draft.min !== undefined ? { min: draft.min } : {}),
    ...(draft.max !== undefined ? { max: draft.max } : {}),
    ...(draft.cache !== undefined ? { cache: draft.cache } : {}),
    ...(draft.cycle === true ? { cycle: true } : {}),
    ...(draft.reset !== undefined ? { reset: draft.reset } : {}),
    ...(draft.at !== undefined ? { at: draft.at } : {}),
    ...(byName !== undefined ? { by: byName } : {}),
    ...(byType !== undefined ? { byType } : {}),
    ...(scope.length > 0 ? { scope } : {}),
    ...(when !== undefined ? { when } : {}),
    ...(draft.moves === "renumber" ? { moves: "renumber" as const } : {}),
    ...(draft.comment !== undefined ? { comment: draft.comment } : {}),
  };
}
