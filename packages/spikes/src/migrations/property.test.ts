/**
 * Catalog pairs applied on Postgres must introspect to the target.
 */

import { expect } from "bun:test";

import { isolatedSchemaName, withPostgres } from "@okmodel/harness";

import { staticNamespace } from "../catalog/object.js";
import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { type SqlRunner } from "../catalog/introspect.js";
import { postgresRunner } from "../catalog/runners.js";
import { quoteLiteral } from "../catalog/sql.js";
import { applyAndCompare } from "./apply.js";
import {
  describePair,
  migrationPair,
  propertyCaseCount,
  renamePair,
  typeChangePair,
} from "./generate.js";
import { type NamespaceBinding } from "../catalog/render.js";

/** Contrib extensions this spike will install when the server provides them. */
const EXTENSION_CANDIDATES = [
  "btree_gist",
  "citext",
  "hstore",
  "pgcrypto",
  "pg_trgm",
  "unaccent",
  "uuid-ossp",
] as const;

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

async function extensionAvailability(
  runner: SqlRunner,
): Promise<{ allowed: readonly string[]; skipped: readonly string[] }> {
  const list = EXTENSION_CANDIDATES.map((name) => quoteLiteral(name)).join(", ");
  const availableRows = await runner.query(
    `select name from pg_available_extensions where name in (${list})`,
  );
  const installedRows = await runner.query(
    `select extname as name from pg_extension where extname in (${list})`,
  );
  const available = new Set(availableRows.map((row) => text(row, "name")));
  const installed = new Set(installedRows.map((row) => text(row, "name")));
  const allowed: string[] = [];
  const skipped: string[] = [];
  for (const name of EXTENSION_CANDIDATES) {
    if (!available.has(name)) {
      skipped.push(`${name}: not available in this database`);
      continue;
    }
    if (installed.has(name)) {
      skipped.push(`${name}: already installed, so a failed create would still look installed`);
      continue;
    }
    allowed.push(name);
  }
  return { allowed, skipped };
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function bindingsFor(schema: string): readonly NamespaceBinding[] {
  return [{ logical: staticNamespace("app"), concrete: schema }];
}

postgresTest(
  decision,
  "random catalog pairs land on the target after the plan",
  async () => {
    const failures: { seed: number; pair: string; cause: string }[] = [];
    const started = performance.now();
    const cases = propertyCaseCount();
    let extensions: { allowed: readonly string[]; skipped: readonly string[] } = {
      allowed: [],
      skipped: [],
    };
    await withPostgres(async (sql) => {
      const runner = postgresRunner(sql);
      extensions = await extensionAvailability(runner);
      console.log(
        JSON.stringify({
          event: "migration-extensions",
          allowed: extensions.allowed,
          skipped: extensions.skipped,
        }),
      );
      for (let seed = 1; seed <= cases; seed += 1) {
        const pair = migrationPair(seed, { extensions: extensions.allowed });
        const schema = isolatedSchemaName();
        try {
          const report = await applyAndCompare(
            runner,
            schema,
            pair.before,
            pair.after,
            bindingsFor,
            pair.renames,
          );
          if (report.structural.length > 0 || report.expressions.length > 0) {
            failures.push({
              seed,
              pair: describePair(pair),
              cause: [...report.structural, ...report.expressions].join(" | "),
            });
          }
        } catch (error) {
          const cause = error instanceof Error ? error.message : String(error);
          failures.push({ seed, pair: describePair(pair), cause });
        }
      }
    });
    console.log(
      JSON.stringify({
        event: "migration-property",
        cases,
        failures: failures.length,
        ms: Math.round(performance.now() - started),
        extensions,
      }),
    );
    for (const failure of failures) {
      console.log(JSON.stringify({ event: "migration-property-failure", ...failure }));
    }
    expect(failures).toEqual([]);
  },
  Math.max(180_000, propertyCaseCount() * 2_000),
);

postgresTest(
  decision,
  "a column type change and a declared rename land on the target",
  async () => {
    await withPostgres(async (sql) => {
      const runner = postgresRunner(sql);
      const typeChange = typeChangePair();
      const typed = await applyAndCompare(
        runner,
        isolatedSchemaName(),
        typeChange.before,
        typeChange.after,
        bindingsFor,
      );
      expect(typed.structural).toEqual([]);
      expect(typed.expressions).toEqual([]);
      expect(typed.plan.steps.some((item) => /\bcascade\b/i.test(item.sql))).toBe(false);

      const rename = renamePair();
      const renamed = await applyAndCompare(
        runner,
        isolatedSchemaName(),
        rename.before,
        rename.after,
        bindingsFor,
        rename.renames,
      );
      expect(renamed.structural).toEqual([]);
      expect(renamed.expressions).toEqual([]);
      expect(renamed.plan.steps.some((item) => /\bcascade\b/i.test(item.sql))).toBe(false);
    });
  },
  60_000,
);
