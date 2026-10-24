/**
 * Runs one lifecycle case against real Postgres and checks CLI invariants.
 */

import { openLifecycleProject } from "../../packages/harness/src/lifecycle-project.js";
import {
  createIsolatedDatabase,
  giveDatabaseToOwner,
  openPostgres,
} from "../../packages/harness/src/postgres.js";
import { OkmError } from "../../src/contracts/error.js";
import { applyEvolution, settleRenames } from "./evolve.js";
import { matchKnownBug } from "./known-bugs.js";
import { sqlName, type LifecycleCase, type SchemaModel } from "./model.js";
import { formatRepro, renderSchema } from "./render.js";

/** Outcome of one case. */
export type LifecycleOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly known?: string; readonly error: string; readonly repro: string };

/**
 * Executes generate → check → apply → check → push invariants for one case.
 *
 * @param root - Repository root
 * @param item - Generated case
 * @param seed - fast-check seed (for repro text)
 * @returns Pass, known skip, or unknown failure
 */
export async function runLifecycleCase(
  root: string,
  item: LifecycleCase,
  seed: number,
): Promise<LifecycleOutcome> {
  try {
    await runApplyPath(root, item);
    await runPushPath(root, item);
    return { ok: true };
  } catch (error) {
    const message = failureText(error);
    const known = matchKnownBug(item.tags, message);
    const repro = formatRepro(item.initial, root, seed);
    if (known !== undefined) {
      return { ok: false, known: known.id, error: message, repro };
    }
    return { ok: false, error: `${message}\n\n${repro}\ntags: ${item.tags.join(", ")}`, repro };
  }
}

async function runApplyPath(root: string, item: LifecycleCase): Promise<void> {
  const database = await createIsolatedDatabase();
  const url = await giveDatabaseToOwner(database.url);
  const project = openLifecycleProject(root, "lifecycle-apply");
  try {
    project.writeConfig(url, item.initial.namespace);
    let model = item.initial;
    project.writeSchema(renderSchema(model, root));
    const init = await project.cli(["generate", "init"]);
    if (!init.includes(".sql")) throw new Error(`generate init wrote nothing: ${init}`);
    await expectOk(project, ["migrate", "check"]);
    await project.cli(["migrate", "apply"]);
    await expectOk(project, ["migrate", "check"]);
    await expectOk(project, ["check"]);
    await expectNoChanges(project);
    await assertNoScratch(url);
    if (item.withRows) await seedRows(url, model);

    for (const step of item.evolutions) {
      model = applyEvolution(model, step);
      project.writeSchema(renderSchema(model, root));
      await project.generateAllowing();
      // The new snapshot already uses the new name. A later command treats that
      // file as the previous catalog, so renamedFrom must be gone before it.
      model = settleRenames(model);
      project.writeSchema(renderSchema(model, root));
      await expectOk(project, ["migrate", "check"]);
      await project.cli(["migrate", "apply"]);
      await expectOk(project, ["migrate", "check"]);
      await expectOk(project, ["check"]);
      await expectNoChanges(project);
      await assertNoScratch(url);
    }
  } finally {
    project.close();
    await database.close();
  }
}

async function runPushPath(root: string, item: LifecycleCase): Promise<void> {
  const database = await createIsolatedDatabase();
  const url = await giveDatabaseToOwner(database.url);
  const project = openLifecycleProject(root, "lifecycle-push");
  try {
    project.writeConfig(url, item.initial.namespace);
    let model = item.initial;
    project.writeSchema(renderSchema(model, root));
    const first = await project.cli(["push"]);
    if (!/applied push-/.test(first)) throw new Error(`push did not apply: ${first}`);
    await expectOk(project, ["check"]);
    const second = await project.cli(["push"]);
    if (/applied/.test(second)) throw new Error(`second push changed the database: ${second}`);
    await assertNoScratch(url);

    for (const step of item.evolutions) {
      model = applyEvolution(model, step);
      project.writeSchema(renderSchema(model, root));
      await project.cli(["push"]);
      model = settleRenames(model);
      project.writeSchema(renderSchema(model, root));
      await expectOk(project, ["check"]);
      const idle = await project.cli(["push"]);
      if (/applied/.test(idle)) throw new Error(`idle push still applied: ${idle}`);
      await assertNoScratch(url);
    }
  } finally {
    project.close();
    await database.close();
  }
}

async function expectOk(
  project: ReturnType<typeof openLifecycleProject>,
  argv: readonly string[],
): Promise<void> {
  const out = await project.cli(argv);
  if (!out.includes("ok")) throw new Error(`${argv.join(" ")} failed: ${out}`);
}

async function expectNoChanges(project: ReturnType<typeof openLifecycleProject>): Promise<void> {
  const out = await project.cli(["generate"]);
  if (out !== "no changes\n") throw new Error(`expected no changes, got ${JSON.stringify(out)}`);
}

async function assertNoScratch(url: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    const rows = await sql<{ line: string }[]>`
      select line from (
        select 'rel ' || c.relname as line from pg_class c where c.relname like 'okm\\_expr%'
        union all
        select 'type ' || t.typname from pg_type t where t.typname like 'okm\\_expr%'
        union all
        select 'con ' || k.conname from pg_constraint k where k.conname like 'okm\\_expr%'
      ) s
      order by line
    `;
    if (rows.length > 0) {
      throw new Error(`scratch objects left behind: ${rows.map((row) => row.line).join(", ")}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function failureText(error: unknown): string {
  if (error instanceof OkmError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function seedRows(url: string, model: SchemaModel): Promise<void> {
  const sql = openPostgres(url);
  const schemaName = model.namespace ?? "public";
  try {
    for (const table of model.tables) {
      const cols: string[] = [];
      const values: string[] = [];
      for (const column of table.columns) {
        if (column.generated !== undefined || column.type === "identity") continue;
        if (column.references !== undefined && column.nullable) continue;
        const literal =
          column.primaryKey || column.references !== undefined
            ? "1"
            : sqlLiteral(column.type, column.defaultValue);
        cols.push(quoteIdent(sqlName(model.casing, column.name)));
        values.push(literal);
      }
      if (model.tenancy) {
        cols.push(quoteIdent(sqlName(model.casing, "tenantId")));
        values.push("'00000000-0000-4000-8000-000000000099'");
      }
      const target = `${quoteIdent(schemaName)}.${quoteIdent(sqlName(model.casing, table.name))}`;
      if (cols.length === 0) {
        await sql.unsafe(`insert into ${target} default values`);
        continue;
      }
      await sql.unsafe(`insert into ${target} (${cols.join(", ")}) values (${values.join(", ")})`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function sqlLiteral(type: string, fallback?: string): string {
  if (fallback !== undefined) {
    if (type === "boolean") return fallback === "true" ? "true" : "false";
    if (type === "integer" || type === "smallint" || type === "bigint" || type === "numeric") {
      return fallback;
    }
    return `'${fallback.replaceAll("'", "''")}'`;
  }
  switch (type) {
    case "integer":
    case "smallint":
    case "bigint":
    case "numeric":
    case "domain":
      return "1";
    case "boolean":
      return "true";
    case "uuid":
      return "'00000000-0000-4000-8000-000000000001'";
    case "timestamptz":
      return "'2020-01-02T03:04:05Z'";
    case "jsonb":
      return "'{}'";
    case "enum":
      return "'red'";
    default:
      return "'x'";
  }
}
