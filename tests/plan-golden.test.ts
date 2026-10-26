/**
 * Plan goldens captured from the catalog pairs the migrate tests plan.
 *
 * Each file is one request. The text, the plan JSON, and the step list
 * (sql, class, kind, lock, transactional) must stay byte-identical.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DdlStep } from "../src/dialects/ddl.js";
import { STEP_KINDS } from "../src/dialects/step-class.js";
import { formatPlanJson } from "../src/tooling/migrate/plan-json.js";
import {
  formatPlan,
  parsePlan,
  planMigration,
  type MigrationPlan,
  type PlanRequest,
} from "../src/tooling/migrate/plan.js";

const directory = join(import.meta.dir, "fixtures", "plan-goldens");

type Golden = {
  readonly source?: "parse";
  readonly request?: PlanRequest;
  readonly text: string;
  readonly json: string;
  readonly steps: readonly {
    readonly sql: string;
    readonly class: string;
    readonly kind?: string;
    readonly lock: string;
    readonly transactional: boolean;
  }[];
};

const names = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort();

test("plan goldens match formatPlan, plan JSON, and the step list", () => {
  expect(names.length).toBeGreaterThan(0);
  const failures: string[] = [];
  for (const name of names) {
    const golden = JSON.parse(readFileSync(join(directory, name), "utf8")) as Golden;
    let text = "";
    let json = "";
    let steps: Golden["steps"] = [];
    try {
      const plan = planned(golden);
      text = golden.source === "parse" ? golden.text : formatPlan(plan);
      json = formatPlanJson(plan, []);
      steps = slim(plan.steps);
    } catch (error) {
      failures.push(`${name} threw ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (text !== golden.text) failures.push(`${name} text`);
    if (json !== golden.json) failures.push(`${name} json`);
    if (JSON.stringify(steps) !== JSON.stringify(golden.steps)) failures.push(`${name} steps`);
  }
  expect(failures).toEqual([]);
});

test("every step kind has a golden", () => {
  const seen = new Set<string>();
  for (const name of names) {
    const golden = JSON.parse(readFileSync(join(directory, name), "utf8")) as Golden;
    for (const step of planned(golden).steps) {
      if (step.kind !== undefined) seen.add(step.kind);
    }
  }
  expect(STEP_KINDS.filter((kind) => !seen.has(kind))).toEqual([]);
});

function planned(golden: Golden): MigrationPlan {
  if (golden.source === "parse") return parsePlan(golden.text);
  if (golden.request === undefined) throw new Error("plan golden has no request");
  return planMigration(golden.request);
}

function slim(steps: readonly DdlStep[]): Golden["steps"] {
  return steps.map((step) => ({
    sql: step.sql,
    class: step.class,
    ...(step.kind === undefined ? {} : { kind: step.kind }),
    lock: step.lock,
    transactional: step.transactional,
  }));
}
