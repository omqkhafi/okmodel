/**
 * Regenerates plan goldens from the request stored in each file.
 *
 *   bun ./scripts/plan-goldens.ts --write
 *
 * `--write` replans every stored request and writes the coverage requests for
 * step kinds no captured pair produces. A `source: "parse"` file is raw SQL:
 * the planner never emits that kind, so the golden is `parsePlan` output.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import { canonicalJson, type Json } from "../src/contracts/catalog/json.js";
import { staticNamespace } from "../src/contracts/catalog/identity.js";
import { column, sequence, table } from "../src/contracts/catalog/object.js";
import { policyObject } from "../src/contracts/catalog/policy.js";
import { defaultPrivilegeObject, roleObject } from "../src/contracts/catalog/privilege.js";
import { sha256 } from "../src/contracts/sha256.js";
import type { DdlStep } from "../src/dialects/ddl.js";
import { schema, t, table as defineTable } from "../src/dialects/pg/index.js";
import { formatPlanJson } from "../src/tooling/migrate/plan-json.js";
import {
  formatPlan,
  parsePlan,
  planMigration,
  type PlanRequest,
} from "../src/tooling/migrate/plan.js";
import { repoRoot } from "./root.js";

const directory = join(repoRoot(), "tests/fixtures/plan-goldens");
const provenance = { origin: "file", name: "schema.ts" } as const;
const namespace = staticNamespace("public");
const parent = { namespace, name: "notes" };

type Golden = {
  readonly source?: "parse";
  readonly request?: PlanRequest;
  readonly text: string;
  readonly json: string;
  readonly steps: ReturnType<typeof slim>;
};

const RAW_SQL = "-- name: hand\n\nselect 1;\n";

const write = process.argv.includes("--write");
const names = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort();
let changed = 0;

for (const name of names) {
  const path = join(directory, name);
  const raw = readFileSync(path, "utf8");
  const golden = JSON.parse(raw) as Golden;
  const next = render(golden);
  if (next !== raw) {
    changed += 1;
    if (write) writeFileSync(path, next);
    else console.log(`stale ${name}`);
  }
}

for (const request of coverageRequests()) {
  const name = `${sha256(canonicalJson(jsonRequest(request))).slice(0, 16)}.json`;
  const path = join(directory, name);
  const golden: Golden = { request, text: "", json: "", steps: [] };
  const next = render(golden);
  const previous = names.includes(name) ? readFileSync(path, "utf8") : undefined;
  if (previous !== next) {
    changed += 1;
    if (write) writeFileSync(path, next);
    else console.log(`missing ${name}`);
  }
}

const rawPath = join(directory, "raw-sql.json");
const rawGolden: Golden = { source: "parse", text: RAW_SQL, json: "", steps: [] };
const rawNext = render(rawGolden);
const rawPrevious = names.includes("raw-sql.json") ? readFileSync(rawPath, "utf8") : undefined;
if (rawPrevious !== rawNext) {
  changed += 1;
  if (write) writeFileSync(rawPath, rawNext);
  else console.log("missing raw-sql.json");
}

if (!write && changed > 0) {
  console.error(`plan-goldens: ${String(changed)} file(s) differ. Run with --write.`);
  process.exit(1);
}
console.log(`plan-goldens: ${write ? "wrote" : "checked"} ${String(changed)} change(s)`);

function coverageRequests(): readonly PlanRequest[] {
  const bare = catalog([
    table({ namespace, name: "notes", provenance }),
    column({
      parent,
      name: "id",
      dataType: "bigint",
      nullable: false,
      provenance,
    }),
  ]);
  const policy = policyObject({
    parent,
    name: "notes_tenant",
    command: "all",
    expression: "(true)",
    force: true,
    provenance,
  });
  const seq = sequence({ namespace, name: "job_no", provenance });
  const role = roleObject({ name: "app", provenance });
  const privilege = defaultPrivilegeObject({
    forRole: "app",
    namespace,
    objectKind: "table",
    grantee: "reader",
    privilege: "select",
    provenance,
  });
  return [
    { before: catalog([]), after: catalog([seq]), name: "create-sequence" },
    { before: catalog([seq]), after: catalog([]), name: "drop-sequence" },
    {
      before: schema({ tables: [defineTable("jobs", { n: t.bigint().primaryKey() })] }).catalog,
      after: schema({ tables: [defineTable("jobs", { n: t.identity() })] }).catalog,
      name: "add-identity",
    },
    { before: catalog([...bare.objects, policy]), after: bare, name: "drop-policy" },
    {
      before: catalog([role, privilege]),
      after: catalog([role]),
      name: "revoke-default",
    },
  ];
}

function render(golden: Golden): string {
  if (golden.source === "parse") {
    const plan = parsePlan(golden.text);
    return `${JSON.stringify({ source: "parse", text: golden.text, json: formatPlanJson(plan, []), steps: slim(plan.steps) })}\n`;
  }
  if (golden.request === undefined) throw new Error("plan golden has no request");
  const plan = planMigration(golden.request);
  return `${JSON.stringify({ request: golden.request, text: formatPlan(plan), json: formatPlanJson(plan, []), steps: slim(plan.steps) })}\n`;
}

function jsonRequest(request: PlanRequest): Json {
  return JSON.parse(JSON.stringify(request)) as Json;
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
