/**
 * Counter SQL, sequence changes, and the fold that makes a round trip empty.
 *
 * The planner imports this. `schema()` does not.
 */

import { OkmError } from "../../../contracts/error.js";
import { catalog } from "../../../contracts/catalog/build.js";
import { column } from "../../../contracts/catalog/object.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  SeriesDefinition,
} from "../../../contracts/catalog/types.js";
import { ddlStep } from "../../ddl-step.js";
import type { LoweredStep } from "../../ddl.js";
import { qualify, quoteIdent } from "../ddl.js";
import { quoteLiteral } from "../quote.js";

const MARK = "-- okm-series ";

/** One warning the plan prints and does not apply. */
export type SeriesWarning = {
  readonly code: string;
  readonly summary: string;
};

type Marker = {
  readonly series: SeriesDefinition;
  readonly table: string;
  readonly column?: string;
  readonly counter: string;
  readonly next: string;
  readonly assign: string;
  readonly index: string;
};

/**
 * Removes generated counter objects and stores the series on the column.
 *
 * A catalog with no marker is returned as given.
 *
 * @param source - Introspected or authored catalog
 * @returns The catalog the planner diffs
 */
export function foldSeries(source: Catalog): Catalog {
  const markers: Marker[] = [];
  for (const object of source.objects) {
    if (object.kind !== "function") continue;
    const marker = readMarker(object.definition.body);
    if (marker !== undefined) markers.push(marker);
  }
  if (markers.length === 0) return source;
  const drop = new Set<string>();
  const seriesByColumn = new Map<string, SeriesDefinition>();
  for (const marker of markers) {
    drop.add(marker.counter);
    drop.add(marker.next);
    drop.add(marker.assign);
    drop.add(marker.index);
    if (marker.column !== undefined) {
      seriesByColumn.set(`${marker.table}.${marker.column}`, marker.series);
    }
  }
  const objects: CatalogObject[] = [];
  for (const object of source.objects) {
    const name = objectName(object);
    if (name !== undefined && drop.has(name)) continue;
    if (parentName(object) !== undefined && drop.has(parentName(object) ?? "")) continue;
    if (object.kind === "column") {
      const series = seriesByColumn.get(`${object.identity.parent.name}.${object.identity.name}`);
      if (series !== undefined) {
        objects.push(withSeries(object, series));
        continue;
      }
    }
    objects.push(object);
  }
  return catalog(objects);
}

/**
 * Refuses a series or sequence the planner cannot apply.
 *
 * @param source - Catalog the plan is moving toward
 * @throws OkmError OKM2121 when a bound is impossible, OKM2122 when a series is still used
 */
export function assertSeries(source: Catalog): void {
  const sequences = new Set<string>();
  for (const object of source.objects) {
    if (object.kind === "sequence") sequences.add(object.identity.name);
  }
  for (const object of source.objects) {
    if (object.kind === "sequence") checkSequence(object.identity.name, object.definition);
    if (object.kind !== "column" || object.definition.series === undefined) continue;
    const series = object.definition.series;
    checkSequence(series.name, {
      dataType: series.as,
      start: series.start,
      increment: series.increment,
      cycle: series.cycle === true,
      ...(series.min !== undefined ? { min: series.min } : {}),
      ...(series.max !== undefined ? { max: series.max } : {}),
      ...(series.cache !== undefined ? { cache: series.cache } : {}),
    });
    if (series.reset !== undefined && series.by === undefined) {
      refuse("OKM2121", `Series ${series.name} resets and needs by, the date column.`);
    }
    if (
      series.reset !== undefined &&
      series.byType === "timestamptz" &&
      (series.at === undefined || series.at.length === 0)
    ) {
      refuse(
        "OKM2121",
        `Series ${series.name} resets a timestamptz and needs at, a time zone such as Asia/Riyadh.`,
      );
    }
  }
  for (const object of source.objects) {
    if (object.kind !== "column") continue;
    const expression = object.definition.defaultExpression;
    if (expression === undefined || !expression.startsWith("nextval(")) continue;
    const name = nextvalName(expression);
    if (name !== undefined && !sequences.has(name)) {
      refuse(
        "OKM2122",
        `Sequence ${name} is still the default of ${object.identity.parent.name}.${object.identity.name}.`,
      );
    }
  }
}

/**
 * `ALTER SEQUENCE` for bounds that can change in place.
 *
 * A different `start` is a warning and is not restarted. A different type is refused.
 *
 * @param before - Sequence already applied
 * @param after - Sequence the plan must reach
 * @param schema - Concrete schema name
 * @returns The statement, if any, and a start warning
 * @throws OkmError OKM2124 when the type would shrink or cannot change in place
 */
export function alterSequence(
  before: { readonly name: string; readonly definition: SequenceShape },
  after: { readonly name: string; readonly definition: SequenceShape },
  schema: string,
): { readonly steps: readonly LoweredStep[]; readonly warning?: SeriesWarning } {
  if (before.definition.dataType !== after.definition.dataType) {
    const left = rank(before.definition.dataType);
    const right = rank(after.definition.dataType);
    const why = right < left ? "below the current type" : "in place";
    refuse(
      "OKM2124",
      `Sequence ${after.name} cannot change from ${before.definition.dataType} to ${after.definition.dataType} ${why}.`,
    );
  }
  const warning =
    before.definition.start !== after.definition.start
      ? {
          code: "OKM2120",
          summary: `Sequence ${after.name} start changed from ${before.definition.start} to ${after.definition.start}. The live sequence is not restarted.`,
        }
      : undefined;
  const parts: string[] = [];
  if (before.definition.increment !== after.definition.increment) {
    parts.push(`increment by ${after.definition.increment}`);
  }
  if (before.definition.min !== after.definition.min) {
    parts.push(
      after.definition.min === undefined ? "no minvalue" : `minvalue ${after.definition.min}`,
    );
  }
  if (before.definition.max !== after.definition.max) {
    parts.push(
      after.definition.max === undefined ? "no maxvalue" : `maxvalue ${after.definition.max}`,
    );
  }
  if (before.definition.cache !== after.definition.cache) {
    parts.push(
      after.definition.cache === undefined ? "cache 1" : `cache ${after.definition.cache}`,
    );
  }
  if (before.definition.cycle !== after.definition.cycle) {
    parts.push(after.definition.cycle ? "cycle" : "no cycle");
  }
  if (parts.length === 0) return { steps: [], ...(warning === undefined ? {} : { warning }) };
  const sql = `alter sequence ${qualify(schema, after.name)} ${parts.join(" ")}`;
  // PostgreSQL 17 takes ShareRowExclusiveLock for `ALTER SEQUENCE`, which does
  // not block readers. Measured in sequences-pg.
  const step = ddlStep(sql, "alter-sequence", "ddl", "SHARE ROW EXCLUSIVE");
  return { steps: [step], ...(warning === undefined ? {} : { warning }) };
}

/**
 * Counter objects for series that appeared, changed, or disappeared.
 *
 * @param before - Previous catalog, already folded
 * @param after - Next catalog, already folded
 * @param schema - Concrete schema name
 * @param createdTables - Tables this plan creates
 * @returns Statements and start warnings
 * @throws OkmError OKM2122 when the counter key would change
 */
export function counterSteps(
  before: Catalog,
  after: Catalog,
  schema: string,
  createdTables: ReadonlySet<string>,
): { readonly steps: readonly LoweredStep[]; readonly warnings: readonly SeriesWarning[] } {
  const previous = seriesColumns(before);
  const next = seriesColumns(after);
  const steps: LoweredStep[] = [];
  const warnings: SeriesWarning[] = [];
  const seen = new Set<string>();
  for (const item of next) {
    if (seen.has(item.series.name)) continue;
    seen.add(item.series.name);
    const prior = previous.find((entry) => entry.series.name === item.series.name);
    const users = next.filter((entry) => entry.series.name === item.series.name);
    if (prior === undefined) {
      steps.push(
        ...createCounter(
          item,
          users,
          schema,
          after,
          !createdTables.has(item.column.identity.parent.name),
        ),
      );
      continue;
    }
    if (shapeKey(prior.series) !== shapeKey(item.series)) {
      refuse(
        "OKM2122",
        `Series ${item.series.name} cannot change its type, reset, or scope after it has issued numbers.`,
      );
    }
    if (prior.series.start !== item.series.start) {
      warnings.push({
        code: "OKM2120",
        summary: `Series ${item.series.name} start changed from ${prior.series.start} to ${item.series.start}. Numbers already issued stay.`,
      });
    }
    if (softKey(prior.series) !== softKey(item.series)) {
      steps.push(...replaceCounter(item, users, schema, after));
    }
  }
  const kept = new Set(next.map((item) => item.series.name));
  const dropped = new Set<string>();
  for (const item of previous) {
    if (kept.has(item.series.name) || dropped.has(item.series.name)) continue;
    dropped.add(item.series.name);
    const users = previous.filter((entry) => entry.series.name === item.series.name);
    steps.push(...dropCounter(item, users, schema));
  }
  return { steps, warnings };
}

/**
 * `OWNED BY` for a native sequence this plan creates.
 *
 * @param sequenceName - Sequence name
 * @param table - Owning table
 * @param columnName - Owning column
 * @param schema - Concrete schema name
 * @returns The statement
 */
export function ownSequenceStep(
  sequenceName: string,
  table: string,
  columnName: string,
  schema: string,
): LoweredStep {
  const sql = `alter sequence ${qualify(schema, sequenceName)} owned by ${qualify(schema, table)}.${quoteIdent(columnName)}`;
  return ddlStep(sql, "alter-sequence", "ddl", "ACCESS EXCLUSIVE");
}

/** Sequence fields the alter compares. */
export type SequenceShape = {
  readonly dataType: string;
  readonly start: string;
  readonly increment: string;
  readonly cycle: boolean;
  readonly min?: string;
  readonly max?: string;
  readonly cache?: string;
};

function createCounter(
  item: SeriesColumn,
  users: readonly SeriesColumn[],
  schema: string,
  source: Catalog,
  seed: boolean,
): LoweredStep[] {
  const names = namesOf(item.series, item.column.identity.name);
  const marker = markerOf(item, names);
  const steps: LoweredStep[] = [
    ddlStep(
      counterTableSql(item.series, names, schema, source, item.column.identity.parent.name),
      "create-table",
      "ddl",
      "ACCESS EXCLUSIVE",
    ),
    ddlStep(
      `revoke all on table ${qualify(schema, names.counter)} from public`,
      "revoke",
      "ddl",
      "ACCESS EXCLUSIVE",
    ),
    ddlStep(
      nextFunctionSql(item.series, names, schema, marker),
      "replace-function",
      "ddl",
      "ACCESS EXCLUSIVE",
    ),
  ];
  for (const user of users) {
    const own = namesOf(user.series, user.column.identity.name);
    const mark = markerOf(user, own);
    steps.push(
      ddlStep(
        assignFunctionSql(
          user,
          own,
          schema,
          mark,
          tableColumns(source, user.column.identity.parent.name),
        ),
        "replace-function",
        "ddl",
        "ACCESS EXCLUSIVE",
      ),
    );
    const trigger = ddlStep(
      triggerSql(user, own, schema),
      "create-trigger",
      "ddl",
      "SHARE ROW EXCLUSIVE",
    );
    steps.push(trigger);
    const index = ddlStep(indexSql(user, own, schema), "create-index", "ddl", "SHARE");
    steps.push(index);
  }
  if (seed)
    steps.push(ddlStep(seedSql(item, users, names, schema), "seed-counter", "ddl", "ROW SHARE"));
  if (item.series.comment !== undefined) {
    steps.push(
      ddlStep(
        `comment on function ${qualify(schema, names.next)} is ${quoteLiteral(item.series.comment)}`,
        "comment",
        "ddl",
        "SHARE UPDATE EXCLUSIVE",
      ),
    );
  }
  return steps;
}

function replaceCounter(
  item: SeriesColumn,
  users: readonly SeriesColumn[],
  schema: string,
  source: Catalog,
): LoweredStep[] {
  const names = namesOf(item.series, item.column.identity.name);
  const steps: LoweredStep[] = [
    ddlStep(
      nextFunctionSql(item.series, names, schema, markerOf(item, names)),
      "replace-function",
      "ddl",
      "ACCESS EXCLUSIVE",
    ),
  ];
  for (const user of users) {
    const own = namesOf(user.series, user.column.identity.name);
    steps.push(
      ddlStep(
        `drop trigger if exists ${quoteIdent(own.assign)} on ${qualify(schema, user.column.identity.parent.name)}`,
        "drop-trigger",
        "ddl",
        "ACCESS EXCLUSIVE",
      ),
    );
    steps.push(
      ddlStep(
        assignFunctionSql(
          user,
          own,
          schema,
          markerOf(user, own),
          tableColumns(source, user.column.identity.parent.name),
        ),
        "replace-function",
        "ddl",
        "ACCESS EXCLUSIVE",
      ),
    );
    steps.push(
      ddlStep(triggerSql(user, own, schema), "create-trigger", "ddl", "SHARE ROW EXCLUSIVE"),
    );
  }
  return steps;
}

function dropCounter(
  item: SeriesColumn,
  users: readonly SeriesColumn[],
  schema: string,
): LoweredStep[] {
  const steps: LoweredStep[] = [];
  for (const user of users) {
    const own = namesOf(user.series, user.column.identity.name);
    steps.push(
      ddlStep(
        `drop trigger if exists ${quoteIdent(own.assign)} on ${qualify(schema, user.column.identity.parent.name)}`,
        "drop-trigger",
        "ddl",
        "ACCESS EXCLUSIVE",
      ),
      ddlStep(
        `drop function if exists ${qualify(schema, own.assign)}()`,
        "drop-function",
        "ddl",
        "ACCESS EXCLUSIVE",
      ),
    );
  }
  const names = namesOf(item.series);
  steps.push(
    ddlStep(
      `drop function if exists ${qualify(schema, names.next)}(${nextArgs(item.series)})`,
      "drop-function",
      "ddl",
      "ACCESS EXCLUSIVE",
    ),
    ddlStep(
      `drop table if exists ${qualify(schema, names.counter)}`,
      "drop-table",
      "ddl",
      "ACCESS EXCLUSIVE",
    ),
  );
  return steps;
}

type Names = {
  readonly counter: string;
  readonly next: string;
  readonly assign: string;
  readonly index: string;
};

function namesOf(series: SeriesDefinition, column = series.name): Names {
  return {
    counter: fit(`okm_ctr_${series.name}`),
    next: fit(`okm_next_${series.name}`),
    assign: fit(`okm_assign_${series.name}_${column}`),
    index: fit(`okm_uq_${series.name}_${column}`),
  };
}

function markerOf(item: SeriesColumn, names: Names): Marker {
  return {
    series: item.series,
    table: item.column.identity.parent.name,
    column: item.column.identity.name,
    counter: names.counter,
    next: names.next,
    assign: names.assign,
    index: names.index,
  };
}

function counterTableSql(
  series: SeriesDefinition,
  names: Names,
  schema: string,
  source: Catalog,
  table: string,
): string {
  const scope = series.scope ?? [];
  const columns = [
    ...scope.map((item) => `${quoteIdent(item.name)} ${item.type} not null`),
    `${quoteIdent("period")} text not null`,
    `${quoteIdent("n")} ${series.as} not null`,
  ];
  const key = [...scope.map((item) => quoteIdent(item.name)), quoteIdent("period")].join(", ");
  const fks = foreignKeys(series, source, schema, table);
  const body = [...columns, `primary key (${key})`, ...fks];
  return `create table ${qualify(schema, names.counter)} (\n  ${body.join(",\n  ")}\n)`;
}

function nextArgs(series: SeriesDefinition): string {
  return [...(series.scope ?? []).map((entry) => entry.type), "text"].join(", ");
}

function foreignKeys(
  series: SeriesDefinition,
  source: Catalog,
  schema: string,
  table: string,
): string[] {
  const scope = new Set((series.scope ?? []).map((item) => item.name));
  if (scope.size === 0) return [];
  const lines: string[] = [];
  for (const object of source.objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "foreignKey") continue;
    if (object.identity.parent.name !== table) continue;
    if (!object.definition.columns.every((name) => scope.has(name))) continue;
    const references = object.definition.references;
    if (references === undefined) continue;
    const targetTable = references.parent.name;
    const cols = object.definition.columns.map((name) => quoteIdent(name)).join(", ");
    const target = references.columns.map((name) => quoteIdent(name)).join(", ");
    lines.push(
      `foreign key (${cols}) references ${qualify(schema, targetTable)} (${target}) on delete cascade`,
    );
  }
  return lines;
}

function nextFunctionSql(
  series: SeriesDefinition,
  names: Names,
  schema: string,
  marker: Marker,
): string {
  const scope = series.scope ?? [];
  const args = [...scope.map((item, index) => `p${String(index)} ${item.type}`), "p_period text"];
  const cols = [
    ...scope.map((item) => quoteIdent(item.name)),
    quoteIdent("period"),
    quoteIdent("n"),
  ];
  const values = [...scope.map((_, index) => `p${String(index)}`), "p_period", series.start];
  const conflict = [...scope.map((item) => quoteIdent(item.name)), quoteIdent("period")].join(", ");
  const table = qualify(schema, names.counter);
  const nextValue = cycleExpression(series, names.counter);
  const bounds = rangeCheck(series);
  const body = `declare
  issued ${series.as};
begin
  ${MARK}${JSON.stringify(marker)}
  insert into ${table} (${cols.join(", ")})
  values (${values.join(", ")})
  on conflict (${conflict}) do update set ${quoteIdent("n")} = ${nextValue}
  returning ${quoteIdent("n")} into issued;
  ${bounds}
  return issued;
end`;
  return `create or replace function ${qualify(schema, names.next)}(${args.join(", ")}) returns ${series.as}
language plpgsql security definer set search_path = pg_catalog, public
as ${dollarQuote(body)}`;
}

/**
 * Dollar-quotes `body` with a tag that does not occur in it.
 *
 * `$okm$` is the first try. A user expression that contains that tag, such as
 * a `when` check, would close the function early, so the tag grows.
 *
 * @param body - The function body, without the quotes
 * @returns The quoted body, including its newlines
 */
function dollarQuote(body: string): string {
  let tag = "okm";
  for (let n = 1; body.includes(`$${tag}$`); n += 1) tag = `okm${String(n)}`;
  return `$${tag}$\n${body}\n$${tag}$`;
}

function assignFunctionSql(
  item: SeriesColumn,
  names: Names,
  schema: string,
  marker: Marker,
  columns: readonly string[],
): string {
  const series = item.series;
  const column = quoteIdent(item.column.identity.name);
  const scopeArgs = (series.scope ?? []).map((entry) => `NEW.${quoteIdent(entry.name)}`).join(", ");
  const period = periodSql(series, "NEW");
  const args = scopeArgs.length === 0 ? period : `${scopeArgs}, ${period}`;
  const guard = moveGuard(series, item.column.identity.name);
  const ready = whenSql(series, columns);
  const body = `begin
  ${MARK}${JSON.stringify(marker)}
  ${guard}
  if NEW.${column} is null then
    ${ready}
    NEW.${column} := ${qualify(schema, names.next)}(${args});
    ${readyEnd(series)}
  end if;
  return NEW;
end`;
  return `create or replace function ${qualify(schema, names.assign)}() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public
as ${dollarQuote(body)}`;
}

function triggerSql(item: SeriesColumn, names: Names, schema: string): string {
  return `create trigger ${quoteIdent(names.assign)} before insert or update on ${qualify(schema, item.column.identity.parent.name)} for each row execute function ${qualify(schema, names.assign)}()`;
}

function indexSql(item: SeriesColumn, names: Names, schema: string): string {
  const series = item.series;
  const keys = [
    ...(series.scope ?? []).map((entry) => quoteIdent(entry.name)),
    ...(series.reset === undefined ? [] : [`(${periodSql(series, "")})`]),
    quoteIdent(item.column.identity.name),
  ];
  return `create unique index ${quoteIdent(names.index)} on ${qualify(schema, item.column.identity.parent.name)} (${keys.join(", ")})`;
}

function seedSql(
  item: SeriesColumn,
  users: readonly SeriesColumn[],
  names: Names,
  schema: string,
): string {
  const series = item.series;
  const user = users[0] ?? item;
  const table = qualify(schema, user.column.identity.parent.name);
  const number = quoteIdent(user.column.identity.name);
  const scope = series.scope ?? [];
  const cols = [
    ...scope.map((entry) => quoteIdent(entry.name)),
    quoteIdent("period"),
    quoteIdent("n"),
  ];
  const period = series.reset === undefined ? "''" : periodSql(series, "");
  const group = [...scope.map((entry) => quoteIdent(entry.name)), period].join(", ");
  const selected = [...scope.map((entry) => quoteIdent(entry.name)), period, `max(${number})`];
  const conflict = [...scope.map((entry) => quoteIdent(entry.name)), quoteIdent("period")].join(
    ", ",
  );
  return `insert into ${qualify(schema, names.counter)} (${cols.join(", ")}) select ${selected.join(", ")} from ${table} where ${number} is not null group by ${group} on conflict (${conflict}) do update set ${quoteIdent("n")} = greatest(${quoteIdent(names.counter)}.${quoteIdent("n")}, excluded.${quoteIdent("n")})`;
}

function moveGuard(series: SeriesDefinition, column: string): string {
  const checks = [
    ...(series.scope ?? []).map(
      (entry) => `NEW.${quoteIdent(entry.name)} is distinct from OLD.${quoteIdent(entry.name)}`,
    ),
    ...(series.by === undefined
      ? []
      : [`NEW.${quoteIdent(series.by)} is distinct from OLD.${quoteIdent(series.by)}`]),
  ];
  if (checks.length === 0) return "";
  const renumber = series.moves === "renumber";
  const action = renumber
    ? `NEW.${quoteIdent(column)} := null;`
    : `raise exception 'series % refuses a change of scope or the reset column after a number is assigned', ${quoteLiteral(series.name)};`;
  return `if TG_OP = 'UPDATE' and OLD.${quoteIdent(column)} is not null and (${checks.join(" or ")}) then ${action} end if;`;
}

function tableColumns(source: Catalog, table: string): string[] {
  const names: string[] = [];
  for (const object of source.objects) {
    if (object.kind === "column" && object.identity.parent.name === table) {
      names.push(object.identity.name);
    }
  }
  return names;
}

function whenSql(series: SeriesDefinition, columns: readonly string[]): string {
  if (series.when === undefined && series.reset === undefined) return "";
  if (series.reset !== undefined && series.by !== undefined && series.when === undefined) {
    return `if NEW.${quoteIdent(series.by)} is null then return NEW; end if;`;
  }
  if (series.when !== undefined) {
    const date =
      series.reset !== undefined && series.by !== undefined
        ? `if NEW.${quoteIdent(series.by)} is null then return NEW; end if;`
        : "";
    return `if not (${qualifyNew(series.when, columns)}) then return NEW; end if; ${date}`;
  }
  return "";
}

function readyEnd(series: SeriesDefinition): string {
  return series.when === undefined && series.reset === undefined ? "" : "";
}

function calendarPeriod(unit: string, source: string): string {
  if (unit === "year") return `(extract(year from ${source})::int)::text`;
  if (unit === "quarter") {
    return `((extract(year from ${source})::int * 4 + extract(quarter from ${source})::int))::text`;
  }
  if (unit === "month") {
    return `((extract(year from ${source})::int * 12 + extract(month from ${source})::int))::text`;
  }
  if (unit === "week") return `((date_trunc('week', ${source})::date - date '0001-01-01'))::text`;
  return `((${source}::date - date '0001-01-01'))::text`;
}

export function periodSql(series: SeriesDefinition, qualifier: string): string {
  if (series.reset === undefined || series.by === undefined) return "''";
  const column =
    qualifier.length === 0 ? quoteIdent(series.by) : `${qualifier}.${quoteIdent(series.by)}`;
  const source =
    series.byType === "timestamptz" && series.at !== undefined
      ? `${column} at time zone ${quoteLiteral(series.at)}`
      : `${column}::timestamp`;
  const reset = series.reset;
  if (typeof reset === "string") return calendarPeriod(reset, source);
  const origin = quoteLiteral(reset.from);
  if (reset.unit === "day" || reset.unit === "week") {
    const span = reset.unit === "week" ? reset.every * 7 : reset.every;
    return `(((${source})::date - ${origin}::date) / ${String(span)})::text`;
  }
  const months = reset.unit === "year" ? 12 : reset.unit === "quarter" ? 3 : 1;
  const every = reset.every * months;
  return `(((extract(year from ${source})::int * 12 + extract(month from ${source})::int) - (extract(year from ${origin}::date)::int * 12 + extract(month from ${origin}::date)::int)) / ${String(every)})::text`;
}

function cycleExpression(series: SeriesDefinition, counter: string): string {
  const current = `${quoteIdent(counter)}.${quoteIdent("n")}`;
  const step = `${current} + ${series.increment}`;
  if (series.cycle !== true) return step;
  const min = series.min ?? defaultMin(series.as, series.increment);
  const max = series.max ?? defaultMax(series.as, series.increment);
  return `case when ${step} > ${max} then ${min} when ${step} < ${min} then ${max} else ${step} end`;
}

function rangeCheck(series: SeriesDefinition): string {
  if (series.cycle === true) return "";
  const min = series.min ?? defaultMin(series.as, series.increment);
  const max = series.max ?? defaultMax(series.as, series.increment);
  return `if issued > ${max} or issued < ${min} then raise exception 'series % is outside % .. %', ${quoteLiteral(series.name)}, ${min}, ${max}; end if;`;
}

function qualifyNew(expression: string, columns: readonly string[]): string {
  let text = expression.replaceAll(/(?<![\w.])"([^"]+)"/g, 'NEW."$1"');
  const names = [...columns].sort((left, right) => right.length - left.length);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replaceAll(
      new RegExp(`(?<![\\w."])${escaped}(?![\\w"])`, "g"),
      `NEW.${quoteIdent(name)}`,
    );
  }
  return text;
}

type SeriesColumn = {
  readonly column: ColumnObject;
  readonly series: SeriesDefinition;
};

function seriesColumns(source: Catalog): SeriesColumn[] {
  const found: SeriesColumn[] = [];
  for (const object of source.objects) {
    if (object.kind === "column" && object.definition.series !== undefined) {
      found.push({ column: object, series: object.definition.series });
    }
  }
  return found;
}

function shapeKey(series: SeriesDefinition): string {
  return JSON.stringify({
    as: series.as,
    reset: series.reset ?? null,
    at: series.at ?? null,
    by: series.by ?? null,
    byType: series.byType ?? null,
    scope: series.scope ?? [],
  });
}

function softKey(series: SeriesDefinition): string {
  return JSON.stringify({
    increment: series.increment,
    min: series.min ?? null,
    max: series.max ?? null,
    cache: series.cache ?? null,
    cycle: series.cycle === true,
    when: series.when ?? null,
    moves: series.moves ?? "refuse",
    comment: series.comment ?? null,
  });
}

function checkSequence(name: string, definition: SequenceShape): void {
  const min = definition.min ?? defaultMin(definition.dataType, definition.increment);
  const max = definition.max ?? defaultMax(definition.dataType, definition.increment);
  if (compareDecimal(min, max) >= 0) {
    refuse("OKM2121", `Sequence ${name} min ${min} must be below max ${max}.`);
  }
  if (compareDecimal(definition.start, min) < 0 || compareDecimal(definition.start, max) > 0) {
    refuse("OKM2121", `Sequence ${name} start ${definition.start} must be from ${min} to ${max}.`);
  }
  if (compareDecimal(definition.start, typeFloor(definition.dataType)) < 0) {
    refuse("OKM2121", `Sequence ${name} start is below ${definition.dataType}.`);
  }
  if (compareDecimal(definition.start, typeCeil(definition.dataType)) > 0) {
    refuse("OKM2121", `Sequence ${name} start is above ${definition.dataType}.`);
  }
}

function defaultMin(dataType: string, increment: string): string {
  return increment.startsWith("-") && increment !== "-0" ? typeFloor(dataType) : "1";
}

function defaultMax(dataType: string, increment: string): string {
  return increment.startsWith("-") && increment !== "-0" ? "-1" : typeCeil(dataType);
}

function typeFloor(dataType: string): string {
  if (dataType === "smallint") return "-32768";
  if (dataType === "integer") return "-2147483648";
  return "-9223372036854775808";
}

function typeCeil(dataType: string): string {
  if (dataType === "smallint") return "32767";
  if (dataType === "integer") return "2147483647";
  return "9223372036854775807";
}

function compareDecimal(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function rank(dataType: string): number {
  if (dataType === "smallint") return 0;
  if (dataType === "integer") return 1;
  return 2;
}

function nextvalName(expression: string): string | undefined {
  const match = /nextval\('([^']+)'::regclass\)/.exec(expression);
  const name = match?.[1];
  if (name === undefined) return undefined;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name : name.slice(dot + 1);
}

/**
 * Reads the series marker stored in a generated function.
 *
 * @param body - Function source
 * @returns The marker, or `undefined` when the function is not one of ours
 */
export function seriesMarker(body: string): Marker | undefined {
  return readMarker(body);
}

function readMarker(body: string): Marker | undefined {
  const at = body.indexOf(MARK);
  if (at < 0) return undefined;
  const line = body.slice(at + MARK.length).split("\n")[0] ?? "";
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Marker;
  } catch {
    return undefined;
  }
}

function withSeries(object: ColumnObject, series: SeriesDefinition): ColumnObject {
  return column({
    parent: object.identity.parent,
    name: object.identity.name,
    dataType: object.definition.dataType,
    nullable: object.definition.nullable,
    owner: object.owner,
    provenance: object.provenance,
    dependencies: object.dependencies.map((edge) => edge.target),
    ...(object.comment !== undefined ? { comment: object.comment } : {}),
    ...(object.definition.defaultExpression !== undefined
      ? { defaultExpression: object.definition.defaultExpression }
      : {}),
    ...(object.definition.collation !== undefined
      ? { collation: object.definition.collation }
      : {}),
    ...(object.definition.identity !== undefined ? { identity: object.definition.identity } : {}),
    ...(object.definition.generated !== undefined
      ? { generated: object.definition.generated }
      : {}),
    ...(object.definition.unvalidatedNotNull !== undefined ? {} : {}),
    series,
  });
}

function parentName(object: CatalogObject): string | undefined {
  if (
    object.kind === "column" ||
    object.kind === "index" ||
    object.kind === "constraint" ||
    object.kind === "trigger" ||
    object.kind === "policy"
  ) {
    return object.identity.parent.name;
  }
  return undefined;
}

function objectName(object: CatalogObject): string | undefined {
  if (
    object.kind === "table" ||
    object.kind === "sequence" ||
    object.kind === "function" ||
    object.kind === "index" ||
    object.kind === "trigger"
  ) {
    return object.identity.name;
  }
  return undefined;
}

function fit(name: string): string {
  let out = name;
  const encoder = new TextEncoder();
  while (encoder.encode(out).length > 63) out = out.slice(0, -1);
  return out;
}

function refuse(code: string, message: string): never {
  throw new OkmError(code, message);
}
