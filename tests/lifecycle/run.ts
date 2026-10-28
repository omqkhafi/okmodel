/**
 * Runs one lifecycle case against real Postgres and checks CLI invariants.
 */

import { openLifecycleProject } from "../../packages/harness/src/lifecycle-project.js";
import { createIsolatedDatabase, openPostgres } from "../../packages/harness/src/postgres.js";
import { readInsertLsn, waitForReplayLsn } from "../../packages/harness/src/replication.js";
import { OkmError } from "../../src/contracts/error.js";
import { applyEvolution, settleRenames } from "./evolve.js";
import { PLANTED_SCRATCH_SCHEMA, prepareDatabase, seedThousand } from "./hostile.js";
import { matchKnownBug } from "./known-bugs.js";
import { sqlName, type Evolution, type LifecycleCase, type SchemaModel } from "./model.js";
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
  if (item.initial.stress === "collide" || item.initial.stress === "long") {
    // schema() refuses these. validity.test.ts checks the code. Apply cannot.
    return { ok: true };
  }
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
  const prepared = await prepareDatabase(database.url, item);
  const project = openLifecycleProject(root, "lifecycle-apply", item.place);
  try {
    project.writeConfig(prepared.writeUrl, item.initial.namespace, prepared.replicaUrl);
    let model = item.initial;
    project.writeSchema(renderSchema(model, root));
    const init = await project.cli(commandFor(item, ["generate", "init"]));
    if (!init.includes(".sql")) throw new Error(`generate init wrote nothing: ${init}`);
    await expectOk(project, commandFor(item, ["migrate", "check"]));
    if (foreignSteps(item)) {
      await expectForeignLedger(project, item, ["migrate", "apply"]);
      return;
    }
    await project.cli(commandFor(item, ["migrate", "apply"]));
    await expectSettled(project, item, prepared.replicaUrl, database.url);
    if (item.start === "rows" && item.evolutions.length === 0) {
      await seedThousand(database.url, model);
      await expectSettled(project, item, prepared.replicaUrl, database.url);
    } else if (item.start !== "rows" && item.withRows) {
      await seedRows(database.url, model);
    }

    for (const step of item.evolutions) {
      if (item.start === "rows") await seedThousand(database.url, model);
      model = applyEvolution(model, step);
      project.writeSchema(renderSchema(model, root));
      await project.generateAllowing();
      // The new snapshot already uses the new name. A later command treats that
      // file as the previous catalog, so renamedFrom must be gone before it.
      model = settleRenames(model);
      project.writeSchema(renderSchema(model, root));
      await expectOk(project, commandFor(item, ["migrate", "check"]));
      await project.cli(commandFor(item, ["migrate", "apply"]));
      await expectSettled(project, item, prepared.replicaUrl, database.url);
    }
  } finally {
    project.close();
    await database.close();
  }
}

async function runPushPath(root: string, item: LifecycleCase): Promise<void> {
  const database = await createIsolatedDatabase();
  const prepared = await prepareDatabase(database.url, item);
  const project = openLifecycleProject(root, "lifecycle-push", item.place);
  try {
    project.writeConfig(prepared.writeUrl, item.initial.namespace, prepared.replicaUrl);
    let model = item.initial;
    project.writeSchema(renderSchema(model, root));
    if (foreignSteps(item)) {
      await expectForeignLedger(project, item, ["push"]);
      return;
    }
    const first = await project.cli(commandFor(item, ["push"]));
    if (!/applied push-/.test(first)) throw new Error(`push did not apply: ${first}`);
    await expectCheck(project, item, prepared.replicaUrl);
    const second = await project.cli(commandFor(item, ["push"]));
    if (/applied/.test(second)) throw new Error(`second push changed the database: ${second}`);
    await assertNoScratch(database.url, prepared.plantedScratch);
    if (item.start === "rows" && item.evolutions.length === 0) {
      await seedThousand(database.url, model);
      await expectCheck(project, item, prepared.replicaUrl);
      await assertNoScratch(database.url, prepared.plantedScratch);
    }

    for (const step of item.evolutions) {
      if (item.start === "rows") await seedThousand(database.url, model);
      model = applyEvolution(model, step);
      project.writeSchema(renderSchema(model, root));
      if (pushDropsRows(item, step)) {
        await expectCode(project, item, ["push"], "OKM1898");
        await project.cli(commandFor(item, ["push", "--allow-data-loss"]));
      } else {
        await project.cli(commandFor(item, ["push"]));
      }
      model = settleRenames(model);
      project.writeSchema(renderSchema(model, root));
      await expectCheck(project, item, prepared.replicaUrl);
      const idle = await project.cli(commandFor(item, ["push"]));
      if (/applied/.test(idle)) throw new Error(`idle push still applied: ${idle}`);
      await assertNoScratch(database.url, prepared.plantedScratch);
    }
  } finally {
    project.close();
    await database.close();
  }
}

/**
 * Database commands on a replica case name a target.
 *
 * `generate` has no `--target`. `okm check` reads the standby. Apply, push,
 * and `migrate check` stay on the primary.
 *
 * @param item - Case
 * @param argv - Command words
 * @returns Argv the CLI receives
 */
function commandFor(item: LifecycleCase, argv: readonly string[]): readonly string[] {
  if (item.role !== "replica") return argv;
  const [head] = argv;
  if (head === "generate") return argv;
  if (head === "check") return ["check", "--target", "replica"];
  return [...argv, "--target", "primary"];
}

function foreignSteps(item: LifecycleCase): boolean {
  return item.start === "clash" && item.clash === "steps";
}

function pushDropsRows(item: LifecycleCase, step: Evolution): boolean {
  return item.start === "rows" && (step.kind === "dropColumn" || step.kind === "dropTable");
}

async function expectForeignLedger(
  project: ReturnType<typeof openLifecycleProject>,
  item: LifecycleCase,
  argv: readonly string[],
): Promise<void> {
  const schema = item.initial.namespace ?? "public";
  const name = `${quoteIdent(schema)}.${quoteIdent("okm_steps")}`;
  await expectCode(project, item, argv, "OKM1899", [name, "another table owns the name"]);
}

async function expectCode(
  project: ReturnType<typeof openLifecycleProject>,
  item: LifecycleCase,
  argv: readonly string[],
  code: string,
  parts: readonly string[] = [],
): Promise<void> {
  try {
    const out = await project.cli(commandFor(item, argv));
    throw new Error(`${argv.join(" ")} was accepted: ${out}`);
  } catch (error) {
    if (!(error instanceof OkmError) || error.code !== code) throw error;
    for (const part of parts) {
      const haystack = part === part.toLowerCase() ? error.message.toLowerCase() : error.message;
      if (!haystack.includes(part)) throw error;
    }
  }
}

async function expectSettled(
  project: ReturnType<typeof openLifecycleProject>,
  item: LifecycleCase,
  replicaUrl: string | undefined,
  databaseUrl: string,
): Promise<void> {
  await expectOk(project, commandFor(item, ["migrate", "check"]));
  await expectCheck(project, item, replicaUrl);
  await expectNoChanges(project);
  await assertNoScratch(databaseUrl, item.start === "clash" && item.clash === "scratch");
}

async function expectCheck(
  project: ReturnType<typeof openLifecycleProject>,
  item: LifecycleCase,
  replicaUrl: string | undefined,
): Promise<void> {
  if (replicaUrl !== undefined) await assertReplicaReady(replicaUrl);
  await expectOk(project, commandFor(item, ["check"]));
}

async function assertReplicaReady(replicaUrl: string): Promise<void> {
  const lsn = await readInsertLsn();
  await waitForReplayLsn("a", lsn);
  const sql = openPostgres(replicaUrl);
  try {
    const rows = await sql<{ recovering: boolean }[]>`select pg_is_in_recovery() as recovering`;
    if (rows[0]?.recovering !== true) {
      throw new Error("okm check target is not in recovery");
    }
  } finally {
    await sql.end({ timeout: 5 });
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

async function assertNoScratch(url: string, plantedScratch: boolean): Promise<void> {
  const sql = openPostgres(url);
  try {
    const rows = await sql<{ line: string }[]>`
      select line from (
        select 'rel ' || c.relname as line from pg_class c where c.relname like 'okm\\_expr%'
        union all
        select 'type ' || t.typname from pg_type t where t.typname like 'okm\\_expr%'
        union all
        select 'con ' || k.conname from pg_constraint k where k.conname like 'okm\\_expr%'
        union all
        select 'schema ' || n.nspname from pg_namespace n
        where n.nspname like 'okm\\_check\\_%'
          and n.nspname is distinct from ${plantedScratch ? PLANTED_SCRATCH_SCHEMA : ""}
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
