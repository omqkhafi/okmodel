/**
 * Fleet configuration and the pure scheduler (D366).
 *
 * One `fleet` key. Targets are a list, a function, or an env var. State
 * stays in each database. This module does not open a connection.
 */

import { OkmError } from "../../contracts/error.js";
import { tagOutcome } from "../cli/outcome.js";
import { estimateMs } from "./weight-rate.js";
import type { StepWeight } from "./classify.js";
import type { StoredMigration } from "./files.js";

/** Default targets run together after the canary. */
export const FLEET_PARALLEL = 4;

/** Default concurrent targets that share a host and port. */
export const FLEET_PER_HOST = 2;

/** Default canary size: the smallest database that still needs work. */
export const FLEET_CANARY = 1;

/** How many failures stop scheduling. `0` stops at the first one. */
export type MaxFailures = number | "all" | `${number}%`;

/** One database the fleet can migrate. */
export type FleetTarget = {
  /** Stable name. Printed. Never a URL. */
  readonly name: string;
  /** Direct Postgres URL. Not a pooler. Never printed. */
  readonly url: string;
  /** Labels for {@link FleetGroup.match}. */
  readonly tags?: Readonly<Record<string, string>>;
  /**
   * When true, a contract step on this database needs `--allow-protected`.
   * The same rule as a configured target.
   */
  readonly protected?: boolean;
};

/** Where `fleet.targets` loads its list. */
export type FleetTargetSource =
  | readonly FleetTarget[]
  | (() => readonly FleetTarget[] | Promise<readonly FleetTarget[]>)
  | { readonly env: string };

/** One ordered stage after the canary. The first match wins. */
export type FleetGroup = {
  readonly name: string;
  readonly match: (target: FleetTarget) => boolean;
  /** Overrides {@link FleetConfig.parallel} for this stage. */
  readonly parallel?: number;
};

/**
 * Database-per-tenant rollout.
 *
 * Omitted fields use the defaults: one canary (the smallest database that
 * is behind), then everyone else at parallel 4 and per host 2, stopping at
 * the first failure.
 */
export type FleetConfig = {
  readonly targets: FleetTargetSource;
  /** How many databases run first, or a predicate. Default {@link FLEET_CANARY}. */
  readonly canary?: number | ((target: FleetTarget) => boolean);
  /** Targets in flight. Default {@link FLEET_PARALLEL}. */
  readonly parallel?: number;
  /** Targets in flight on one host and port. Default {@link FLEET_PER_HOST}. */
  readonly perHost?: number;
  /** Stop scheduling after this many migration failures. Default `0`. */
  readonly maxFailures?: MaxFailures;
  /** Ordered stages for targets the canary did not take. */
  readonly groups?: readonly FleetGroup[];
  /** Called after each target finishes. The URL is not on the result. */
  readonly onResult?: (result: FleetTargetEvent) => void | Promise<void>;
};

/** Status words a fleet row can show. */
export type FleetState =
  | "current"
  | "behind"
  | "ahead"
  | "failed"
  | "unreachable"
  | "drifted"
  | "skipped";

/** One target the JSON stream and `onResult` see. */
export type FleetTargetEvent = {
  readonly event: "target";
  readonly name: string;
  readonly state: FleetState;
  readonly behind: number;
  readonly bytes: number;
  readonly migrationId: string;
  readonly catalogHash: string;
  readonly applied: readonly string[];
  readonly code?: string;
  readonly summary?: string;
  readonly fix?: string;
};

/** The last line of a fleet run. */
export type FleetSummaryEvent = {
  readonly event: "summary";
  readonly text: string;
  readonly targets: number;
  readonly failures: number;
  readonly unreachable: number;
  readonly exit: 0 | 1 | 4 | 5;
};

/** A line `applyFleet` yields. */
export type FleetEvent = FleetTargetEvent | FleetSummaryEvent;

/** What `ensureHead` returns. The URL is not included. */
export type EnsureHeadResult = {
  readonly applied: readonly string[];
  readonly text: string;
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/**
 * Parses `--max-failures` and `fleet.maxFailures`.
 *
 * @param value - `0`, a count, `2%`, or `all`. Absent is `0`
 * @returns The limit
 */
export function parseMaxFailures(value: number | string | undefined): MaxFailures {
  if (value === undefined) return 0;
  if (value === "all") return "all";
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw fleetUsage("maxFailures must be 0, a count, a percent, or all.");
    }
    return value;
  }
  const text = value.trim();
  if (text === "all") return "all";
  if (/^\d+$/.test(text)) return Number(text);
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(text);
  if (percent?.[1] !== undefined) return `${percent[1]}%` as `${number}%`;
  throw fleetUsage("maxFailures must be 0, a count, a percent, or all.");
}

/**
 * How many failures are allowed once `started` targets have begun.
 *
 * A percent is of the targets that have started, rounded down. `0` allows
 * none. `"all"` does not stop the schedule.
 *
 * @param limit - Parsed maxFailures
 * @param started - Targets whose apply has started
 * @returns A count, or `"all"`
 */
export function allowedFailures(limit: MaxFailures, started: number): number | "all" {
  if (limit === "all") return "all";
  if (typeof limit === "number") return limit;
  const percent = Number(limit.slice(0, -1));
  return Math.floor((started * percent) / 100);
}

/**
 * Reports whether another failure must stop new work.
 *
 * @param limit - Parsed maxFailures
 * @param started - Targets that have started
 * @param failures - Migration failures so far. Unreachable is not one
 * @returns `true` when no further target should start
 */
export function failuresStop(limit: MaxFailures, started: number, failures: number): boolean {
  const allowed = allowedFailures(limit, started);
  if (allowed === "all") return false;
  return failures > allowed;
}

/**
 * Loads and checks fleet targets.
 *
 * An env value is a JSON array, or one `name url` pair per line. The URL
 * is not repeated in the error.
 *
 * @param source - The `fleet.targets` value
 * @param env - Environment to read. Defaults to `process.env`
 * @returns Unique targets
 */
export async function resolveFleetTargets(
  source: FleetTargetSource,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly FleetTarget[]> {
  const raw = await readSource(source, env);
  const seen = new Set<string>();
  const targets: FleetTarget[] = [];
  for (const target of raw) {
    if (typeof target.name !== "string" || !NAME.test(target.name)) {
      throw new OkmError("OKM1845", "A fleet target name is missing or not a plain name.", {
        kind: "invalid",
        fix: { summary: "Use a name of letters, digits, dots, underscores, or hyphens." },
      });
    }
    if (seen.has(target.name)) {
      throw new OkmError("OKM1845", `Fleet target ${target.name} is listed twice.`, {
        kind: "invalid",
        fix: { summary: "Keep one entry per name." },
      });
    }
    if (typeof target.url !== "string" || !/^postgres(ql)?:\/\//i.test(target.url)) {
      throw new OkmError("OKM1845", `Fleet target ${target.name} has no Postgres URL.`, {
        kind: "invalid",
        fix: { summary: "Set url to a direct postgres:// URL. Do not use a pooler." },
      });
    }
    seen.add(target.name);
    targets.push({
      name: target.name,
      url: target.url,
      ...(target.tags !== undefined ? { tags: target.tags } : {}),
      ...(target.protected === true ? { protected: true } : {}),
    });
  }
  if (targets.length === 0) {
    throw new OkmError("OKM1845", "No fleet target is configured.", {
      kind: "invalid",
      fix: { summary: "Return at least one { name, url } from fleet.targets." },
    });
  }
  return targets;
}

/**
 * Positive integer from config or a flag.
 *
 * @param value - The configured number
 * @param fallback - Used when `value` is omitted
 * @param label - Flag or field name in the error
 * @returns The integer
 */
export function positiveInt(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw fleetUsage(`${label} must be an integer of 1 or more.`);
  }
  return value;
}

/**
 * The first migration that contains a contract or unclassified step.
 *
 * @param migrations - Files in apply order
 * @returns That file and the file before it, or `undefined` when every step is expand
 */
export function contractBoundary(
  migrations: readonly StoredMigration[],
): { readonly migrationId: string; readonly previousId: string | undefined } | undefined {
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (migration === undefined) continue;
    const contract = migration.steps.some(
      (step) => step.class === "contract" || step.class === "unclassified",
    );
    if (!contract) continue;
    return { migrationId: migration.id, previousId: migrations[index - 1]?.id };
  }
  return undefined;
}

/** A status reading the contract gate can see. No URL. */
export type GateReading = {
  readonly name: string;
  readonly state: FleetState;
  readonly pending: readonly string[];
};

/**
 * Refuses a contract migration until every target has the previous expand.
 *
 * An unreachable target counts as behind. `--allow-protected` skips the gate.
 * Per-target protection still applies when the gate is open.
 *
 * @param migrations - Files in apply order
 * @param readings - One per target, after the status pass
 * @param allowProtected - The invocation passed `--allow-protected`
 */
export function assertContractGate(
  migrations: readonly StoredMigration[],
  readings: readonly GateReading[],
  allowProtected: boolean,
): void {
  if (allowProtected) return;
  const boundary = contractBoundary(migrations);
  if (boundary?.previousId === undefined) return;
  const missing = readings.filter((row) => !hasMigration(row, boundary.previousId ?? ""));
  if (missing.length === 0) return;
  const names = missing.map((row) => row.name).join(", ");
  throw new OkmError(
    "OKM2211",
    `The contract migration ${boundary.migrationId} needs ${boundary.previousId} on every target. Missing on ${names}.`,
    {
      kind: "forbidden",
      fix: {
        summary:
          "Apply the expand migration to every target first, including ones this run could not reach. --allow-protected runs the contract anyway.",
      },
    },
  );
}

/**
 * Refuses a frozen-plan target whose head is not the recorded head.
 *
 * @param name - Target name
 * @param planned - Head written by `plan --fleet --out`
 * @param live - Head read now
 */
export function assertFleetHead(
  name: string,
  planned: { readonly migrationId: string; readonly catalogHash: string },
  live: { readonly migrationId: string; readonly catalogHash: string },
): void {
  if (planned.migrationId === live.migrationId && planned.catalogHash === live.catalogHash) return;
  throw new OkmError(
    "OKM1933",
    `Target ${name} moved since the fleet plan. The plan recorded ${planned.migrationId} and the database is at ${live.migrationId}.`,
    {
      kind: "conflict",
      fix: { summary: "Run okm migrate plan --fleet --out again, then apply that file." },
    },
  );
}

/**
 * Whether any pending step is `blocking` or `rewrite`.
 *
 * Those steps cap `perHost` at 1 for the run.
 *
 * @param migrations - Files in apply order
 * @param pending - `${migrationId}:${stepIndex}` still to run, across targets
 * @returns `true` when the cap applies
 */
export function heavyPending(
  migrations: readonly StoredMigration[],
  pending: readonly string[],
): boolean {
  if (pending.length === 0) return false;
  const want = new Set(pending);
  for (const migration of migrations) {
    for (let index = 0; index < migration.steps.length; index += 1) {
      const step = migration.steps[index];
      if (step === undefined || !want.has(`${migration.id}:${String(index)}`)) continue;
      if (step.weight === "blocking" || step.weight === "rewrite") return true;
    }
  }
  return false;
}

/** One target's weighted work, for the plan estimate. */
export type WeightedWork = {
  readonly name: string;
  readonly steps: readonly { readonly weight: StepWeight; readonly rows: number }[];
};

/**
 * Longest target and the total at the chosen parallel.
 *
 * The total is the sum of the target estimates divided by the parallel
 * limit, and it is never shorter than the longest target.
 *
 * @param work - Pending weighted steps per target
 * @param parallel - Targets in flight
 * @returns Milliseconds and the target that dominates
 */
export function estimateFleet(
  work: readonly WeightedWork[],
  parallel: number,
): { readonly longestName: string; readonly longestMs: number; readonly totalMs: number } {
  let longestName = work[0]?.name ?? "-";
  let longestMs = 0;
  let sum = 0;
  for (const target of work) {
    let ms = 0;
    for (const step of target.steps) ms += estimateMs(step.weight, step.rows);
    sum += ms;
    if (ms >= longestMs) {
      longestMs = ms;
      longestName = target.name;
    }
  }
  const lanes = Math.max(1, parallel);
  const totalMs = Math.max(longestMs, Math.round(sum / lanes));
  return { longestName, longestMs, totalMs };
}

/** One stage the runner executes, in order. */
export type FleetStage = {
  readonly name: string;
  readonly targets: readonly FleetTarget[];
  readonly parallel: number;
};

/** A target plus the bytes the status pass read. */
export type SizedTarget = FleetTarget & { readonly bytes: number; readonly actionable: boolean };

/**
 * Canary first, then groups in order, then `rest`.
 *
 * A numeric canary is the smallest actionable databases. A predicate selects
 * its own set. Canary members are not in a later stage.
 *
 * @param targets - Resolved targets with sizes
 * @param canary - Config value. Default 1
 * @param groups - Ordered matchers
 * @param parallel - Default parallel for a stage that does not set its own
 * @returns Stages that have at least one target
 */
export function planStages(
  targets: readonly SizedTarget[],
  canary: number | ((target: FleetTarget) => boolean),
  groups: readonly FleetGroup[],
  parallel: number,
): readonly FleetStage[] {
  const canaryTargets = chooseCanary(targets, canary);
  const canaryNames = new Set(canaryTargets.map((target) => target.name));
  const rest = targets.filter((target) => !canaryNames.has(target.name));
  const stages: FleetStage[] = [];
  if (canaryTargets.length > 0) {
    stages.push({ name: "canary", targets: canaryTargets, parallel });
  }
  const claimed = new Set<string>();
  for (const group of groups) {
    if (group.name === "canary" || group.name === "rest") {
      throw fleetUsage(`The group name ${group.name} is reserved.`);
    }
    const matched = rest.filter(
      (target) => !claimed.has(target.name) && group.match(target) === true,
    );
    for (const target of matched) claimed.add(target.name);
    if (matched.length === 0) continue;
    stages.push({
      name: group.name,
      targets: matched,
      parallel: positiveInt(group.parallel, parallel, `groups.${group.name}.parallel`),
    });
  }
  const leftovers = rest.filter((target) => !claimed.has(target.name));
  if (leftovers.length > 0) stages.push({ name: "rest", targets: leftovers, parallel });
  return stages;
}

/**
 * Runs `worker` with a parallel cap and a per-host cap.
 *
 * When `stop` becomes true, work already running finishes and nothing new starts.
 *
 * @param items - Work items
 * @param limits - Caps. `perHost` is keyed by {@link hostOf}
 * @param hostOf - Host key, usually `host:port`
 * @param stop - Polled before each start
 * @param worker - One item
 */
export async function scheduleTargets<T>(
  items: readonly T[],
  limits: { readonly parallel: number; readonly perHost: number },
  hostOf: (item: T) => string,
  stop: () => boolean,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const left = new Set(items.map((_, index) => index));
  const onHost = new Map<string, number>();
  let active = 0;
  let signaled = false;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    signaled = true;
    const current = wake;
    wake = undefined;
    current?.();
  };
  const park = (): Promise<void> => {
    if (signaled) {
      signaled = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      wake = () => {
        signaled = false;
        resolve();
      };
    });
  };
  const launch = (): void => {
    if (stop()) return;
    for (const index of left) {
      if (active >= limits.parallel) return;
      const item = items[index];
      if (item === undefined) {
        left.delete(index);
        continue;
      }
      const host = hostOf(item);
      if ((onHost.get(host) ?? 0) >= limits.perHost) continue;
      left.delete(index);
      active += 1;
      onHost.set(host, (onHost.get(host) ?? 0) + 1);
      void worker(item).finally(() => {
        active -= 1;
        onHost.set(host, (onHost.get(host) ?? 1) - 1);
        notify();
      });
    }
  };
  for (;;) {
    launch();
    if (active === 0) return;
    await park();
  }
}

/**
 * Removes URLs, userinfo, and long passwords from text that might be shown.
 *
 * A password shorter than 8 characters is left alone so a local user name
 * is not stripped out of ordinary words. Full URLs are always removed.
 *
 * @param text - A line, an error, or a JSON document
 * @param urls - URLs that must not appear
 * @returns Text safe to print
 */
export function redactSecrets(text: string, urls: readonly string[]): string {
  let out = text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]");
  for (const url of urls) {
    if (url.length > 0) out = out.split(url).join("[redacted]");
    try {
      const parsed = new URL(url);
      const password = decodeURIComponent(parsed.password);
      if (password.length >= 8) out = out.split(password).join("[redacted]");
      if (parsed.hostname.length > 0) out = out.split(parsed.hostname).join("[host]");
    } catch {
      // The URL regex already covered a value that is not a URL.
    }
  }
  return out;
}

/**
 * Exit code for a finished fleet.
 *
 * A contract refusal is 4. Any migration failure is 1. Only unreachable
 * targets are 5. Otherwise 0.
 *
 * @param input - Counts and whether the contract gate refused the run
 * @returns The process exit
 */
export function fleetExit(input: {
  readonly guarded: boolean;
  readonly failures: number;
  readonly unreachable: number;
}): 0 | 1 | 4 | 5 {
  if (input.guarded) return 4;
  if (input.failures > 0) return 1;
  if (input.unreachable > 0) return 5;
  return 0;
}

function hasMigration(row: GateReading, migrationId: string): boolean {
  if (row.state === "unreachable") return false;
  const prefix = `${migrationId}:`;
  return !row.pending.some((id) => id.startsWith(prefix));
}

function chooseCanary(
  targets: readonly SizedTarget[],
  canary: number | ((target: FleetTarget) => boolean),
): readonly SizedTarget[] {
  if (typeof canary === "function") return targets.filter((target) => canary(target) === true);
  const count = canary;
  if (!Number.isInteger(count) || count < 0) {
    throw fleetUsage("canary must be 0, a count, or a function.");
  }
  const actionable = targets.filter((target) => target.actionable);
  const ranked = [...actionable].sort((left, right) => {
    if (left.bytes !== right.bytes) return left.bytes - right.bytes;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  return ranked.slice(0, count);
}

async function readSource(
  source: FleetTargetSource,
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly FleetTarget[]> {
  if (typeof source === "function") {
    const listed = await source();
    return listed;
  }
  if (Array.isArray(source)) return source;
  const envSource = source as { readonly env: string };
  const name = envSource.env;
  if (typeof name !== "string" || name.length === 0) {
    throw fleetUsage("fleet.targets.env needs the variable name.");
  }
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new OkmError("OKM1845", `Fleet targets env ${name} is empty.`, {
      kind: "invalid",
      fix: { summary: "Set that variable to a JSON array or one name and URL per line." },
    });
  }
  return parseEnvList(value, name);
}

function parseEnvList(value: string, name: string): readonly FleetTarget[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      throw new OkmError("OKM1845", `Fleet targets env ${name} is not a JSON array.`, {
        kind: "invalid",
        fix: { summary: "Use a JSON array of { name, url } or one name and URL per line." },
      });
    }
    if (!Array.isArray(parsed)) {
      throw new OkmError("OKM1845", `Fleet targets env ${name} is not a JSON array.`, {
        kind: "invalid",
        fix: { summary: "Use a JSON array of { name, url }." },
      });
    }
    return parsed.map((item) => targetFromUnknown(item));
  }
  const targets: FleetTarget[] = [];
  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (text.length === 0 || text.startsWith("#")) continue;
    const split = text.indexOf(" ");
    const pair = split === -1 ? text.split("=") : [text.slice(0, split), text.slice(split + 1)];
    const targetName = pair[0]?.trim() ?? "";
    const url = pair[1]?.trim() ?? "";
    targets.push({ name: targetName, url });
  }
  return targets;
}

function targetFromUnknown(value: unknown): FleetTarget {
  if (typeof value !== "object" || value === null) {
    throw new OkmError("OKM1845", "A fleet target must be an object with name and url.", {
      kind: "invalid",
      fix: { summary: "Each entry is { name, url }." },
    });
  }
  const name = Reflect.get(value, "name");
  const url = Reflect.get(value, "url");
  const tags = Reflect.get(value, "tags");
  const protectedFlag = Reflect.get(value, "protected");
  return {
    name: typeof name === "string" ? name : "",
    url: typeof url === "string" ? url : "",
    ...(isStringRecord(tags) ? { tags } : {}),
    ...(protectedFlag === true ? { protected: true } : {}),
  };
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function fleetUsage(summary: string): OkmError {
  return tagOutcome(
    new OkmError("OKM1895", summary, {
      kind: "invalid",
      fix: { summary: "See okm migrate apply --help." },
    }),
    "usage",
  );
}
