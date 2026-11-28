/**
 * Fleet status, plan, and apply (D366).
 *
 * The fleet schedules {@link applyDirect}. Locks, fill, blocking, pooler
 * refusal, and an empty database's snapshot stay on that path. A transient
 * connect error is retried, then reported as unreachable.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { parseCatalog } from "../../contracts/catalog/document.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import {
  isConnectionFailure,
  isConnectionSqlstate,
  isSqlstate,
  readCode,
} from "../../contracts/connection.js";
import { OkmError } from "../../contracts/error.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import type { RolesInput } from "../../dialects/pg/role/index.js";
import { tagOutcome } from "../cli/outcome.js";
import { driverUrl } from "./driver-url.js";
import { applyDirect } from "./apply.js";
import { catalogNamespace } from "./export.js";
import { loadMigrations, type StoredMigration } from "./files.js";
import {
  FLEET_CANARY,
  FLEET_PARALLEL,
  FLEET_PER_HOST,
  assertContractGate,
  assertFleetHead,
  estimateFleet,
  failuresStop,
  fleetExit,
  heavyPending,
  parseMaxFailures,
  planStages,
  positiveInt,
  type SizedTarget,
  redactSecrets,
  resolveFleetTargets,
  scheduleTargets,
  type EnsureHeadResult,
  type FleetConfig,
  type FleetEvent,
  type FleetState,
  type FleetSummaryEvent,
  type FleetTarget,
  type FleetTargetEvent,
  type MaxFailures,
} from "./fleet-config.js";
import { postgresEndpoint } from "./fingerprint.js";
import type { InvokeFlags } from "./policy.js";
import { loadConfig } from "./project.js";
import { projectContext, projectPath, type ProjectContext } from "./paths.js";
import { inspectTargetHistory, type StepProgress } from "./status.js";
import type { StepWeight } from "./classify.js";
import { durationPhrase } from "./weight.js";

/** Options for {@link applyFleet}, {@link statusFleet}, and {@link planFleet}. */
export type FleetRunOptions = {
  /** Project directory. Defaults to the process cwd. */
  readonly cwd?: string;
  /** Config path, the same as `--config`. */
  readonly config?: string;
  /** Overrides `fleet.maxFailures`. */
  readonly maxFailures?: MaxFailures;
  /** Overrides `fleet.parallel`. */
  readonly parallel?: number;
  /** Overrides `fleet.perHost`. */
  readonly perHost?: number;
  /** Run one stage: `canary`, a group name, or `rest`. */
  readonly group?: string;
  /** Run these target names only. */
  readonly only?: readonly string[];
  /** Frozen plan from `plan --fleet --out`. */
  readonly planPath?: string;
  /** Same as `--allow-protected`. */
  readonly allowProtected?: boolean;
  /** Same as `--allow-blocking`. */
  readonly allowBlocking?: boolean;
  /** Same as `--allow-pooler`. */
  readonly allowPooler?: boolean;
  /** Same as `--lock-wait`. */
  readonly lockWaitMs?: number;
  /** Same as `--lock-timeout`. */
  readonly lockTimeoutMs?: number;
  /** Same as `--statement-timeout`. */
  readonly statementTimeoutMs?: number;
  /** Compare each database with the catalog its history names. */
  readonly drift?: boolean;
  /** Human progress lines, each already ending with a newline. */
  readonly onProgress?: (line: string) => void;
  /** When true, this database's contract steps need `--allow-protected`. `ensureHead` only. */
  readonly protected?: boolean;
};

/** `okm.fleet/1` document. It stores names, heads, and steps. It has no URL. */
export type FleetPlanFile = {
  readonly schema: "okm.fleet/1";
  readonly migrations: readonly {
    readonly id: string;
    readonly catalogHash: string;
    readonly steps: readonly {
      readonly index: number;
      readonly class: string;
      readonly weight?: string;
      readonly sql: string;
    }[];
  }[];
  readonly heavy: boolean;
  readonly parallel: number;
  readonly perHost: number;
  /** Database this plan would run first. Absent on a file written before this field. */
  readonly canary?: string | null;
  readonly targets: readonly {
    readonly name: string;
    readonly state: FleetState;
    readonly behind: number;
    readonly migrationId: string;
    readonly catalogHash: string;
    readonly bytes: number;
  }[];
};

const PLAN_SCHEMA = "okm.fleet/1" as const;
const BACKOFF_MS = [0, 500, 1_500, 4_000] as const;
const CONNECT_SECONDS = 30;

type Reading = FleetTargetEvent & {
  readonly pending: readonly string[];
  readonly rows: Readonly<Record<string, number>>;
  readonly host: string;
};

type Loaded = {
  readonly project: ProjectContext;
  readonly namespace: string;
  readonly migrations: readonly StoredMigration[];
  readonly directory: string;
  readonly roles: RolesInput | undefined;
  readonly allowPooler: boolean;
};

/**
 * Reads one row per target.
 *
 * @param fleet - Config object, including a targets function
 * @param options - Project, drift, and concurrency
 * @returns Rows and the text `okm migrate status --fleet` prints
 */
export async function statusFleet(
  fleet: FleetConfig,
  options: FleetRunOptions = {},
): Promise<{ readonly rows: readonly FleetTargetEvent[]; readonly text: string }> {
  const loaded = await loadProject(options);
  const targets = await selectedTargets(fleet, options);
  const readings = await readAll(loaded, targets, options, limitsOf(fleet, options));
  const rows = readings.map(eventOf);
  return {
    rows,
    text: redactSecrets(
      formatStatus(rows),
      targets.map((target) => target.url),
    ),
  };
}

/**
 * Plans the fleet and, when `planPath` is set, writes that file.
 *
 * @param fleet - Config object
 * @param options - Project and the optional output path
 * @returns The plan and the text `okm migrate plan --fleet` prints
 */
export async function planFleet(
  fleet: FleetConfig,
  options: FleetRunOptions = {},
): Promise<{ readonly plan: FleetPlanFile; readonly text: string }> {
  const loaded = await loadProject(options);
  const limits = limitsOf(fleet, options);
  const targets = await selectedTargets(fleet, options);
  const readings = await readAll(loaded, targets, { ...options, drift: false }, limits);
  const pending = readings.flatMap((row) => [...row.pending]);
  const heavy = heavyPending(loaded.migrations, pending);
  const plan: FleetPlanFile = {
    schema: PLAN_SCHEMA,
    migrations: loaded.migrations.map((migration) => ({
      id: migration.id,
      catalogHash: migration.catalogHash,
      steps: migration.steps.map((step, index) => ({
        index,
        class: step.class,
        ...(step.weight !== undefined ? { weight: step.weight } : {}),
        sql: step.sql,
      })),
    })),
    heavy,
    parallel: limits.parallel,
    perHost: heavy ? 1 : limits.perHost,
    canary: plannedCanary(targets, readings, fleet, limits.parallel),
    targets: readings.map((row) => ({
      name: row.name,
      state: row.state,
      behind: row.behind,
      migrationId: row.migrationId,
      catalogHash: row.catalogHash,
      bytes: row.bytes,
    })),
  };
  if (options.planPath !== undefined) {
    writeFileSync(options.planPath, `${JSON.stringify(plan, null, 2)}\n`);
  }
  return {
    plan,
    text: redactSecrets(
      formatPlan(plan, readings, loaded.migrations),
      targets.map((target) => target.url),
    ),
  };
}

/**
 * Applies the reviewed migrations to each database that is behind.
 *
 * A current target is skipped. An ahead target is not touched. A failed or
 * unreachable canary stops later stages. A frozen plan names its canary. When
 * that database is unreachable, apply uses the smallest reachable database
 * that still needs work and says so. Re-running retries the targets that are
 * still behind.
 *
 * @param fleet - Config object. `onResult` runs after each target
 * @param options - Limits, a frozen plan, and the flags passed to each apply
 * @yields One event per target, then a summary
 */
export async function* applyFleet(
  fleet: FleetConfig,
  options: FleetRunOptions = {},
): AsyncGenerator<FleetEvent, void, void> {
  const loaded = await loadProject(options);
  const limit = parseMaxFailures(options.maxFailures ?? fleet.maxFailures);
  const everyone = await resolveFleetTargets(fleet.targets);
  const targets = pickOnly(everyone, options.only);
  const urls = everyone.map((target) => target.url);
  const limits = limitsOf(fleet, options);
  const readings = await readAll(loaded, targets, { ...options, drift: false }, limits);
  const gateRows =
    targets.length === everyone.length
      ? readings
      : await readAll(loaded, everyone, { ...options, drift: false }, limits);
  const byName = new Map(readings.map((row) => [row.name, row]));
  const pending = readings.flatMap((row) => [...row.pending]);
  const heavy = heavyPending(loaded.migrations, pending);
  const perHost = heavy ? 1 : limits.perHost;
  const frozen = options.planPath === undefined ? undefined : readPlanFile(options.planPath);
  if (frozen !== undefined) assertPlanMatchesCheckout(frozen, loaded.migrations);
  try {
    assertContractGate(
      loaded.migrations,
      gateRows.map((row) => ({ name: row.name, state: row.state, pending: row.pending })),
      options.allowProtected === true,
    );
  } catch (error) {
    const failure = described(error, urls);
    const text = `${failure.summary}\n${failure.fix}\n`;
    options.onProgress?.(text);
    yield summaryOf([], text, { guarded: true, failures: 0, unreachable: 0 });
    return;
  }
  const sized = sizedTargets(targets, readings);
  const chosenCanary = applyCanary(fleet.canary ?? FLEET_CANARY, frozen?.canary, sized, byName);
  if (chosenCanary.note !== undefined) options.onProgress?.(`${chosenCanary.note}\n`);
  const stages = planStages(sized, chosenCanary.canary, fleet.groups ?? [], limits.parallel);
  const chosen =
    options.group === undefined ? stages : stages.filter((stage) => stage.name === options.group);
  if (options.group !== undefined && chosen.length === 0) {
    throw tagOutcome(
      new OkmError("OKM1895", `Fleet group ${options.group} is not a stage in this run.`, {
        kind: "invalid",
        fix: { summary: "Use canary, rest, or a name from fleet.groups." },
      }),
      "usage",
    );
  }
  const produced: FleetTargetEvent[] = [];
  let failures = 0;
  let started = 0;
  let unreachable = readings.filter((row) => row.state === "unreachable").length;
  let stop = false;
  for (const stage of chosen) {
    if (stop) break;
    options.onProgress?.(
      `stage ${stage.name}  ${String(stage.targets.length)}  parallel ${String(stage.parallel)}  per host ${String(perHost)}\n`,
    );
    const stageResults: FleetTargetEvent[] = [];
    await scheduleTargets(
      [...stage.targets].sort(byNameOrder),
      { parallel: stage.parallel, perHost },
      (target) => hostKey(target.url),
      () => stop || failuresStop(limit, started, failures),
      async (target) => {
        const row = byName.get(target.name);
        const result = await runOne(loaded, target, row, frozen, options, urls, () => {
          started += 1;
        });
        if (result.state === "failed") failures += 1;
        if (result.state === "unreachable" && row?.state !== "unreachable") unreachable += 1;
        stageResults.push(result);
        produced.push(result);
        options.onProgress?.(`  ${result.name}  ${lineOf(result)}\n`);
        await notify(fleet, result, urls);
      },
    );
    for (const result of stageResults) yield result;
    if (stage.name === "canary") {
      const blocked = stageResults.find(
        (result) => result.state === "failed" || result.state === "unreachable",
      );
      if (blocked !== undefined) {
        stop = true;
        options.onProgress?.(
          blocked.state === "unreachable"
            ? "canary unreachable; later stages were not started\n"
            : "canary failed; later stages were not started\n",
        );
      }
    }
  }
  for (const row of readings) {
    if (produced.some((item) => item.name === row.name)) continue;
    const event = eventOf(row);
    produced.push(event);
    options.onProgress?.(`  ${event.name}  ${lineOf(event)}\n`);
    await notify(fleet, event, urls);
    yield event;
  }
  const text = `${chosenCanary.note === undefined ? "" : `${chosenCanary.note}\n`}${formatStatus(produced)}${formatFailures(produced)}`;
  yield summaryOf(produced, redactSecrets(text, urls), {
    guarded: false,
    failures,
    unreachable,
  });
}

/**
 * Installs the head snapshot on an empty database, or replays what is pending.
 *
 * Signup calls this once. A later call is the retry: history already recorded
 * is skipped.
 *
 * @param url - Direct Postgres URL. It is not included in the result
 * @param options - Project path and the same flags as one apply
 * @returns Applied ids and the CLI text, with the URL removed
 */
export async function ensureHead(
  url: string,
  options: FleetRunOptions = {},
): Promise<EnsureHeadResult> {
  const loaded = await loadProject(options);
  const name = postgresEndpoint(url).database || "tenant";
  const report = await withTransient(() =>
    applyDirect(
      loaded.project,
      { name, url, ...(options.protected === true ? { protected: true } : {}) },
      flagsOf(options),
    ),
  );
  return { applied: report.report.applied, text: redactSecrets(report.text, [url]) };
}

function eventOf(row: Reading): FleetTargetEvent {
  return {
    event: "target",
    name: row.name,
    state: row.state,
    behind: row.behind,
    bytes: row.bytes,
    migrationId: row.migrationId,
    catalogHash: row.catalogHash,
    applied: row.applied,
    ...(row.code !== undefined ? { code: row.code } : {}),
    ...(row.summary !== undefined ? { summary: row.summary } : {}),
    ...(row.fix !== undefined ? { fix: row.fix } : {}),
  };
}

function sizedTargets(
  targets: readonly FleetTarget[],
  readings: readonly Reading[],
): SizedTarget[] {
  const byReading = new Map(readings.map((row) => [row.name, row]));
  return targets.map((target) => {
    const row = byReading.get(target.name);
    return {
      ...target,
      bytes: row?.bytes ?? Number.MAX_SAFE_INTEGER,
      actionable: row?.state === "behind" || row?.state === "failed",
    };
  });
}

function plannedCanary(
  targets: readonly FleetTarget[],
  readings: readonly Reading[],
  fleet: FleetConfig,
  parallel: number,
): string | null {
  const sized = sizedTargets(targets, readings);
  const stage = planStages(sized, fleet.canary ?? FLEET_CANARY, fleet.groups ?? [], parallel).find(
    (item) => item.name === "canary",
  );
  return stage?.targets[0]?.name ?? null;
}

function applyCanary(
  configured: number | ((target: FleetTarget) => boolean),
  planned: string | null | undefined,
  sized: readonly SizedTarget[],
  byName: Map<string, Reading>,
): {
  readonly canary: number | ((target: FleetTarget) => boolean);
  readonly note?: string;
} {
  if (typeof planned !== "string" || planned.length === 0) return { canary: configured };
  const reading = byName.get(planned);
  if (reading?.state === "unreachable") {
    const next = [...sized]
      .filter((target) => target.actionable)
      .sort((left, right) => left.bytes - right.bytes || left.name.localeCompare(right.name))[0];
    if (next === undefined) return { canary: configured };
    return {
      canary: (target) => target.name === next.name,
      note: `canary ${planned} was unreachable; used ${next.name} because ${planned} did not accept a connection`,
    };
  }
  if (reading?.state === "behind" || reading?.state === "failed") {
    return { canary: (target) => target.name === planned };
  }
  return { canary: configured };
}

async function runOne(
  loaded: Loaded,
  target: FleetTarget,
  row: Reading | undefined,
  frozen: FleetPlanFile | undefined,
  options: FleetRunOptions,
  urls: readonly string[],
  markStarted: () => void,
): Promise<FleetTargetEvent> {
  const base = row ?? unreachableReading(target, "The target was not read.");
  if (frozen !== undefined && base.state !== "unreachable") {
    const planned = frozen.targets.find((item) => item.name === target.name);
    if (planned === undefined) {
      return failedEvent(
        base,
        "OKM1933",
        `Target ${target.name} is not in the fleet plan.`,
        "Plan again so every target is recorded.",
      );
    }
    try {
      assertFleetHead(target.name, planned, {
        migrationId: base.migrationId,
        catalogHash: base.catalogHash,
      });
    } catch (error) {
      const failure = described(error, urls);
      return failedEvent(base, failure.code, failure.summary, failure.fix);
    }
  }
  if (base.state === "current" || base.state === "ahead" || base.state === "unreachable") {
    return eventOf({ ...base, applied: [] });
  }
  markStarted();
  try {
    const report = await withTransient(() =>
      applyDirect(
        loaded.project,
        {
          name: target.name,
          url: target.url,
          ...(target.protected === true ? { protected: true } : {}),
        },
        flagsOf(options),
      ),
    );
    const head = loaded.migrations.at(-1);
    return {
      ...eventOf(base),
      state: "current",
      behind: 0,
      applied: report.report.applied,
      migrationId: head?.id ?? base.migrationId,
      catalogHash: head?.catalogHash ?? base.catalogHash,
    };
  } catch (error) {
    const failure = described(error, urls);
    if (isTransientConnect(error)) {
      return {
        ...eventOf(base),
        state: "unreachable",
        applied: [],
        code: "unavailable",
        summary: failure.summary,
        fix: "The database did not accept a connection after retries. Run the fleet again.",
      };
    }
    return failedEvent(base, failure.code, failure.summary, failure.fix);
  }
}

function failedEvent(base: Reading, code: string, summary: string, fix: string): FleetTargetEvent {
  return { ...eventOf(base), state: "failed", applied: [], code, summary, fix };
}

async function readAll(
  loaded: Loaded,
  targets: readonly FleetTarget[],
  options: FleetRunOptions,
  limits: { readonly parallel: number; readonly perHost: number },
): Promise<readonly Reading[]> {
  const readings: Reading[] = [];
  await scheduleTargets(
    targets,
    limits,
    (target) => hostKey(target.url),
    () => false,
    async (target) => {
      readings.push(await readOne(loaded, target, options.drift === true, loaded.allowPooler));
    },
  );
  return readings;
}

async function readOne(
  loaded: Loaded,
  target: FleetTarget,
  drift: boolean,
  allowPooler: boolean,
): Promise<Reading> {
  try {
    return await withTransient(() => readConnected(loaded, target, drift, allowPooler));
  } catch (error) {
    const failure = described(error, [target.url]);
    if (!isTransientConnect(error)) {
      return {
        ...unreachableReading(target, failure.summary),
        state: "failed",
        code: failure.code,
        summary: failure.summary,
        fix: failure.fix,
      };
    }
    return unreachableReading(target, failure.summary);
  }
}

async function readConnected(
  loaded: Loaded,
  target: FleetTarget,
  drift: boolean,
  allowPooler: boolean,
): Promise<Reading> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(driverUrl(target.url, "okmodel-fleet"), {
    max: 1,
    connect_timeout: CONNECT_SECONDS,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    if (loaded.namespace !== "public") {
      await sql.unsafe(`set search_path to ${quoteIdent(loaded.namespace)}`);
    }
    const inspected = await inspectTargetHistory(async (text, params) => {
      const query = sql.unsafe(text, params === undefined ? [] : [...params]);
      return { rows: await cellsOf(query) };
    }, loaded.migrations);
    const bytesRows = await cellsOf(
      sql.unsafe("select pg_database_size(current_database())::text as bytes"),
    );
    const bytes = Number(bytesRows[0]?.[0] ?? "0");
    const countRows = await cellsOf(
      sql.unsafe(
        `select c.relname, c.reltuples::float8::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relkind in ('r', 'p')`,
        [loaded.namespace],
      ),
    );
    const rows: Record<string, number> = {};
    for (const row of countRows) {
      const name = row[0];
      const tuples = Number(row[1] ?? "-1");
      if (typeof name === "string" && Number.isFinite(tuples) && tuples >= 0) rows[name] = tuples;
    }
    const described = inspected.described;
    const behind = behindFiles(loaded.migrations, described.pending);
    let state = stateOf(described.state, inspected.steps, behind);
    if (drift && (state === "current" || state === "behind" || state === "failed")) {
      const catalog = catalogAt(loaded, described.version);
      if (
        catalog !== undefined &&
        (await isDrifted(target.url, catalog, loaded.roles, allowPooler))
      ) {
        state = "drifted";
      }
    }
    return {
      event: "target",
      name: target.name,
      state,
      behind,
      bytes: Number.isFinite(bytes) ? bytes : 0,
      migrationId: described.version,
      catalogHash: described.catalogHash,
      applied: [],
      pending: described.pending,
      rows,
      host: hostKey(target.url),
    };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function isDrifted(
  url: string,
  catalog: Catalog,
  roles: RolesInput | undefined,
  allowPooler: boolean,
): Promise<boolean> {
  const { assertAuthorDrift } = await import("./drift.js");
  try {
    await assertAuthorDrift(
      url,
      catalog,
      roles,
      allowPooler,
      undefined,
      undefined,
      CONNECT_SECONDS,
    );
    return false;
  } catch (error) {
    if (OkmError.from(error).code === "OKM1520") return true;
    throw error;
  }
}

function catalogAt(loaded: Loaded, version: string): Catalog | undefined {
  const id = version.replace(/^(provisioned|baselined)@/, "");
  if (id === "-" || id.length === 0) return undefined;
  try {
    return parseCatalog(readFileSync(projectPath(loaded.directory, `${id}.catalog.json`), "utf8"));
  } catch {
    return undefined;
  }
}

function stateOf(described: string, steps: readonly StepProgress[], behind: number): FleetState {
  if (
    described === "ahead by expand" ||
    described === "ahead by contract" ||
    described.startsWith("ahead")
  ) {
    return "ahead";
  }
  if (
    steps.some(
      (step) => step.state === "failed" || step.state === "started" || step.state === "retry",
    )
  ) {
    return "failed";
  }
  if (behind === 0) return "current";
  return "behind";
}

function behindFiles(migrations: readonly StoredMigration[], pending: readonly string[]): number {
  let count = 0;
  for (const migration of migrations) {
    const pendingStep = migration.steps.some((_, index) =>
      pending.includes(`${migration.id}:${String(index)}`),
    );
    if (pendingStep) count += 1;
  }
  return count;
}

function unreachableReading(target: FleetTarget, summary: string): Reading {
  return {
    event: "target",
    name: target.name,
    state: "unreachable",
    behind: 0,
    bytes: 0,
    migrationId: "-",
    catalogHash: "-",
    applied: [],
    pending: [],
    rows: {},
    host: hostKey(target.url),
    code: "unavailable",
    summary: redactSecrets(summary, [target.url]),
    fix: "The database did not accept a connection after retries. Run the fleet again.",
  };
}

async function withTransient<T>(run: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt += 1) {
    const wait = BACKOFF_MS[attempt] ?? 0;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await run();
    } catch (error) {
      last = error;
      if (!isTransientConnect(error) || attempt === BACKOFF_MS.length - 1) throw error;
    }
  }
  throw last;
}

/**
 * A connect failure worth retrying: reset, refusal, 53300, 57P03, or a cold start.
 *
 * A SQLSTATE outside the connection classes is a migration error and is not retried.
 *
 * @param error - A thrown value
 * @returns `true` when another attempt may succeed
 */
export function isTransientConnect(error: unknown): boolean {
  if (sqlstateChain(error) === "53300") return true;
  if (isConnectionFailure(error)) return true;
  const state = sqlstateChain(error);
  if (state !== undefined && isSqlstate(state) && !isConnectionSqlstate(state)) return false;
  return /could not connect|connection reset|ECONNRESET|ECONNREFUSED|ETIMEDOUT|too many connections|the database system is starting|remaining connection slots|timeout expired/i.test(
    messageOf(error),
  );
}

function sqlstateChain(error: unknown): string | undefined {
  const state = readCode(error, "sqlstate") ?? readCode(error, "code");
  if (state !== undefined && isSqlstate(state)) return state;
  if (typeof error === "object" && error !== null) {
    const cause: unknown = Reflect.get(error, "cause");
    if (cause !== undefined && cause !== error) return sqlstateChain(cause);
  }
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

function described(
  error: unknown,
  urls: readonly string[],
): { readonly code: string; readonly summary: string; readonly fix: string } {
  const mapped = OkmError.from(error);
  return {
    code: mapped.code,
    summary: redactSecrets(mapped.message, urls),
    fix: redactSecrets(mapped.fix?.summary ?? "Look at this target and run the fleet again.", urls),
  };
}

function cellText(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "string") return cell;
  if (typeof cell === "number" || typeof cell === "boolean" || typeof cell === "bigint") {
    return String(cell);
  }
  return null;
}

async function cellsOf(query: {
  values: () => Promise<readonly (readonly unknown[])[]>;
}): Promise<(string | null)[][]> {
  const values = await query.values();
  return values.map((row) => row.map(cellText));
}

function hostKey(url: string): string {
  try {
    const endpoint = postgresEndpoint(url);
    return `${endpoint.host}:${endpoint.port}`;
  } catch {
    return "unknown";
  }
}

function flagsOf(options: FleetRunOptions): InvokeFlags {
  return {
    allowProtected: options.allowProtected === true,
    allowPooler: options.allowPooler === true,
    ...(options.allowBlocking === true ? { allowBlocking: true } : {}),
    ...(options.lockWaitMs !== undefined ? { lockWaitMs: options.lockWaitMs } : {}),
    ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
    ...(options.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: options.statementTimeoutMs }
      : {}),
  };
}

async function loadProject(options: FleetRunOptions): Promise<Loaded> {
  const project = projectContext(options.cwd ?? process.cwd(), options.config);
  const config = await loadConfig(project);
  const directory = projectPath(project.cwd, config.migrations ?? "migrations");
  return {
    project,
    namespace: catalogNamespace(config),
    migrations: loadMigrations(directory),
    directory,
    roles: config.roles,
    allowPooler: options.allowPooler === true || config.allowPooler === true,
  };
}

async function selectedTargets(
  fleet: FleetConfig,
  options: FleetRunOptions,
): Promise<readonly FleetTarget[]> {
  return pickOnly(await resolveFleetTargets(fleet.targets), options.only);
}

function pickOnly(
  resolved: readonly FleetTarget[],
  only: readonly string[] | undefined,
): readonly FleetTarget[] {
  if (only === undefined || only.length === 0) return resolved;
  const want = new Set(only);
  const picked = resolved.filter((target) => want.has(target.name));
  const missing = [...want].filter((name) => !picked.some((target) => target.name === name));
  if (missing.length > 0) {
    throw new OkmError("OKM1845", `Fleet target ${missing.join(", ")} is not configured.`, {
      kind: "invalid",
      fix: { summary: "Pass a name returned by fleet.targets." },
    });
  }
  return picked;
}

function limitsOf(
  fleet: FleetConfig,
  options: FleetRunOptions,
): { readonly parallel: number; readonly perHost: number } {
  return {
    parallel: positiveInt(options.parallel ?? fleet.parallel, FLEET_PARALLEL, "parallel"),
    perHost: positiveInt(options.perHost ?? fleet.perHost, FLEET_PER_HOST, "perHost"),
  };
}

function formatStatus(rows: readonly FleetTargetEvent[]): string {
  const lines = ["target\tstate\tbehind\tbytes\tversion"];
  for (const row of [...rows].sort(byEventName)) {
    const state = row.state === "behind" ? `behind ${String(row.behind)}` : row.state;
    lines.push(
      [row.name, state, String(row.behind), String(row.bytes), row.migrationId].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatFailures(rows: readonly FleetTargetEvent[]): string {
  const bad = rows.filter((row) => row.state === "failed" || row.state === "unreachable");
  if (bad.length === 0) return "";
  const lines = ["failures", "target\tcode\tfix"];
  for (const row of bad.sort(byEventName)) {
    lines.push([row.name, row.code ?? "-", row.fix ?? row.summary ?? ""].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function formatPlan(
  plan: FleetPlanFile,
  readings: readonly Reading[],
  migrations: readonly StoredMigration[],
): string {
  const work = readings
    .filter((row) => row.state === "behind" || row.state === "failed")
    .map((row) => ({ name: row.name, steps: weightedSteps(migrations, row) }));
  const estimate = estimateFleet(work, Math.max(1, plan.parallel));
  const lines = [
    formatStatus(readings.map(eventOf)).trimEnd(),
    plan.heavy
      ? "blocking or rewrite steps cap per host at 1"
      : "per host cap is the configured limit",
    `longest\t${estimate.longestName}\t${durationPhrase(estimate.longestMs)}`,
    `parallel\t${String(plan.parallel)}\tper host\t${String(plan.perHost)}`,
    `total\t${durationPhrase(estimate.totalMs)}`,
  ];
  return `${lines.join("\n")}\n`;
}

function weightedSteps(
  migrations: readonly StoredMigration[],
  row: Reading,
): readonly { readonly weight: StepWeight; readonly rows: number }[] {
  const steps: { weight: StepWeight; rows: number }[] = [];
  for (const migration of migrations) {
    for (let index = 0; index < migration.steps.length; index += 1) {
      const step = migration.steps[index];
      if (step?.weight === undefined) continue;
      if (!row.pending.includes(`${migration.id}:${String(index)}`)) continue;
      const table = step.tables?.[0];
      steps.push({ weight: step.weight, rows: table === undefined ? 0 : (row.rows[table] ?? 0) });
    }
  }
  return steps;
}

function lineOf(result: FleetTargetEvent): string {
  if (result.applied.length > 0) return `applied ${result.applied.join(" ")}`;
  if (result.state === "behind") return `behind ${String(result.behind)}`;
  if (result.state === "ahead") return "ahead, not touched";
  if (result.code !== undefined) return `${result.state} ${result.code}`;
  return result.state;
}

function summaryOf(
  rows: readonly FleetTargetEvent[],
  text: string,
  counts: { readonly guarded: boolean; readonly failures: number; readonly unreachable: number },
): FleetSummaryEvent {
  const failures = Math.max(rows.filter((row) => row.state === "failed").length, counts.failures);
  const unreachable = Math.max(
    rows.filter((row) => row.state === "unreachable").length,
    counts.unreachable,
  );
  return {
    event: "summary",
    text,
    targets: rows.length,
    failures,
    unreachable,
    exit: fleetExit({ guarded: counts.guarded, failures, unreachable }),
  };
}

function readPlanFile(path: string): FleetPlanFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw tagOutcome(
      new OkmError("OKM1895", "The fleet plan file could not be read.", {
        kind: "invalid",
        fix: { summary: "Pass the file written by okm migrate plan --fleet --out." },
      }),
      "usage",
    );
  }
  if (!isPlan(parsed)) {
    throw tagOutcome(
      new OkmError("OKM1895", "The fleet plan file is not an okm.fleet/1 document.", {
        kind: "invalid",
        fix: { summary: "Write it again with okm migrate plan --fleet --out." },
      }),
      "usage",
    );
  }
  return parsed;
}

function assertPlanMatchesCheckout(
  plan: FleetPlanFile,
  migrations: readonly StoredMigration[],
): void {
  const live = migrations.map((migration) => `${migration.id}:${migration.catalogHash}`).join("\n");
  const frozen = plan.migrations
    .map((migration) => `${migration.id}:${migration.catalogHash}`)
    .join("\n");
  if (live === frozen) return;
  throw new OkmError("OKM1933", "The checkout migrations do not match the fleet plan.", {
    kind: "conflict",
    fix: { summary: "Run okm migrate plan --fleet --out again, then apply that file." },
  });
}

function isPlan(value: unknown): value is FleetPlanFile {
  if (typeof value !== "object" || value === null) return false;
  if (Reflect.get(value, "schema") !== PLAN_SCHEMA) return false;
  const text = JSON.stringify(value);
  if (text.includes("postgres://") || text.includes("postgresql://")) {
    throw tagOutcome(
      new OkmError("OKM1895", "The fleet plan contains a connection URL.", {
        kind: "invalid",
        fix: { summary: "Write the plan again. A fleet plan stores names and heads only." },
      }),
      "usage",
    );
  }
  return (
    Array.isArray(Reflect.get(value, "targets")) && Array.isArray(Reflect.get(value, "migrations"))
  );
}

async function notify(
  fleet: FleetConfig,
  result: FleetTargetEvent,
  urls: readonly string[],
): Promise<void> {
  if (fleet.onResult === undefined) return;
  try {
    await fleet.onResult(result);
  } catch (error) {
    const failure = described(error, urls);
    throw new OkmError(failure.code, failure.summary, { fix: { summary: failure.fix } });
  }
}

function byNameOrder(left: FleetTarget, right: FleetTarget): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function byEventName(left: FleetTargetEvent, right: FleetTargetEvent): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}
