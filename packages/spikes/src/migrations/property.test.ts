/**
 * Catalog pairs applied on Postgres must introspect to the target.
 */

import { expect } from "bun:test";

import { isolatedSchemaName, withPostgres } from "@okmodel/harness";

import { staticNamespace } from "../catalog/object.js";
import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { postgresRunner } from "../catalog/runners.js";
import { applyAndCompare } from "./apply.js";
import { PROPERTY_SEEDS, migrationPair, renamePair, typeChangePair } from "./generate.js";
import { type NamespaceBinding } from "../catalog/render.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

function bindingsFor(schema: string): readonly NamespaceBinding[] {
  return [{ logical: staticNamespace("app"), concrete: schema }];
}

postgresTest(
  decision,
  "random catalog pairs land on the target after the plan",
  async () => {
    const failures: {
      seed: number;
      structural: readonly string[];
      expressions: readonly string[];
    }[] = [];
    const started = performance.now();
    await withPostgres(async (sql) => {
      const runner = postgresRunner(sql);
      for (const seed of PROPERTY_SEEDS) {
        const pair = migrationPair(seed);
        const schema = isolatedSchemaName();
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
            structural: report.structural,
            expressions: report.expressions,
          });
        }
      }
    });
    console.log(
      JSON.stringify({
        event: "migration-property",
        cases: PROPERTY_SEEDS.length,
        failures: failures.length,
        ms: Math.round(performance.now() - started),
      }),
    );
    expect(failures).toEqual([]);
  },
  180_000,
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
