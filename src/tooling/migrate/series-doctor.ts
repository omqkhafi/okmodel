/**
 * Read-only sequence and counter checks for `okm doctor`.
 *
 * A sequence behind its column prints the exact `setval`. Nothing here writes.
 */

import type { ProductionFinding } from "./doctor-production.js";
import type { StatementRunner } from "./server-requirements.js";
import { qualify, quoteIdent } from "../../dialects/pg/ddl.js";
import { periodSql, seriesMarker } from "../../dialects/pg/seq/engine.js";

/**
 * Sequences and counters that have fallen behind the rows, and ranges half used.
 *
 * @param runner - Read-only connection
 * @param schema - Schema to read
 * @returns Findings. Empty when every series matches its rows
 */
export async function sequenceFindings(
  runner: StatementRunner,
  schema: string,
): Promise<readonly ProductionFinding[]> {
  const findings: ProductionFinding[] = [];
  const sequences = await runner.execute(
    `select c.relname as seq_name, s.seqmin::text as seq_min, s.seqmax::text as seq_max,
            pg_sequence_last_value(c.oid)::text as seq_last,
            coalesce(owned.relname, '') as owned_table, coalesce(a.attname, '') as owned_column
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_sequence s on s.seqrelid = c.oid
     left join pg_depend d on d.objid = c.oid and d.deptype in ('a', 'i') and d.classid = 'pg_class'::regclass
     left join pg_class owned on owned.oid = d.refobjid
     left join pg_attribute a on a.attrelid = owned.oid and a.attnum = d.refobjsubid
     where n.nspname = $1 and c.relkind = 'S'
     order by c.relname`,
    [schema],
  );
  for (const row of sequences.rows) {
    const name = text(row[0]);
    const min = text(row[1]);
    const max = text(row[2]);
    const last = text(row[3]);
    const table = text(row[4]);
    const column = text(row[5]);
    if (table.length > 0 && column.length > 0) {
      const highest = await runner.execute(
        `select max(${quoteIdent(column)})::text from ${qualify(schema, table)}`,
      );
      const peak = text(highest.rows[0]?.[0]);
      if (peak.length > 0 && (last.length === 0 || compare(peak, last) > 0)) {
        findings.push({
          id: `sequence-behind-${name}`,
          severity: "warn",
          code: "OKM2205",
          summary: `Sequence ${name} is behind ${table}.${column}. select setval('${schema}.${name}', ${peak}, true);`,
          fix: "Run that setval, then the next value follows the highest stored id.",
        });
      }
    }
    if (last.length > 0 && min.length > 0 && max.length > 0 && max !== min) {
      const used = rangePercent(last, min, max);
      if (used >= 50) {
        findings.push({
          id: `sequence-range-${name}`,
          severity: "warn",
          code: "OKM2206",
          summary: `Sequence ${name} has used ${String(used)}% of its range.`,
          fix: "Widen the sequence type or max before it reaches the end.",
        });
      }
    }
  }
  const functions = await runner.execute(
    `select p.prosrc from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = $1 and p.prosrc like '%okm-series%'
     order by p.proname`,
    [schema],
  );
  const seen = new Set<string>();
  for (const row of functions.rows) {
    const marker = seriesMarker(text(row[0]));
    if (marker?.column === undefined || seen.has(marker.counter)) continue;
    seen.add(marker.counter);
    const scope = marker.series.scope ?? [];
    const names = scope.map((item) => quoteIdent(item.name));
    const period = marker.series.reset === undefined ? "''::text" : periodSql(marker.series, "");
    const groupKeys = marker.series.reset === undefined ? names : [...names, period];
    const selected = [
      ...names,
      `${period} as period_key`,
      `max(${quoteIdent(marker.column)})::text`,
    ];
    const grouped = groupKeys.length === 0 ? "" : ` group by ${groupKeys.join(", ")}`;
    const peak = await runner.execute(
      `select ${selected.join(", ")} from ${qualify(schema, marker.table)} where ${quoteIdent(marker.column)} is not null${grouped}`,
    );
    for (const data of peak.rows) {
      const high = text(data[data.length - 1]);
      const periodValue = text(data[data.length - 2]);
      if (high.length === 0) continue;
      const where = [
        ...names.map((key, index) => `${key} = ${sqlLiteral(text(data[index]))}`),
        `${quoteIdent("period")} = ${sqlLiteral(periodValue)}`,
      ].join(" and ");
      const current = await runner.execute(
        `select ${quoteIdent("n")}::text from ${qualify(schema, marker.counter)} where ${where}`,
      );
      const held = text(current.rows[0]?.[0]);
      if (held.length === 0 || compare(high, held) > 0) {
        findings.push({
          id: `counter-behind-${marker.series.name}`,
          severity: "warn",
          code: "OKM2207",
          summary: `Counter ${marker.series.name} is behind ${marker.table}.${marker.column} (${high}).`,
          fix: "Insert is assigned by the trigger. A value written by hand can leave the counter behind.",
        });
      }
    }
  }
  return findings;
}

function text(value: string | null | undefined): string {
  return value ?? "";
}

function compare(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function rangePercent(last: string, min: string, max: string): number {
  const span = BigInt(max) - BigInt(min);
  if (span <= 0n) return 0;
  const used = ((BigInt(last) - BigInt(min)) * 10000n) / span;
  return Number(used) / 100;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
