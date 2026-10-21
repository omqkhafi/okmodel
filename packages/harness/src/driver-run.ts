/**
 * Runs the conformance suites for one driver and prints the report.
 *
 * `okm driver test` spawns this file. The cases stay in the harness suites.
 * Each row is a case id, the behavior, and pass, fail, or unsupported.
 * An unsupported row names the capability. The dialect column is `postgres`.
 * The last line counts portable runs, gated runs, refusal assertions, and
 * unsupported cases.
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import type {
  DriverCapabilities,
  DriverPool,
  DriverTimeouts,
} from "../../../src/contracts/driver.js";
import {
  formatConformanceCounts,
  registerDriverSuite,
  type ConformanceCounts,
  type SuiteTest,
} from "./driver-suite.js";
import { registerErrorMappingSuite } from "./error-suite.js";
import { registerTxSuite, type TxSuite } from "./tx-suite.js";

/** One finished case. */
type Row = {
  readonly id: string;
  readonly behavior: string;
  readonly result: "pass" | "fail" | "unsupported";
  readonly capability: string;
  readonly detail?: string;
};

/** What the command prints, and how many cases failed. */
export type DriverReport = {
  readonly text: string;
  readonly failed: number;
};

/** A driver the command can open. */
type Target = {
  readonly name: string;
  readonly capabilities: DriverCapabilities;
  readonly memory: boolean;
  readonly notices: boolean;
  readonly size: number;
  readonly url?: string;
  /** False when the TCP commit-cut proxy cannot sit on this driver. */
  readonly cut: boolean;
  /** The pool can describe a statement. Not a capability flag. */
  readonly statementDescribe?: boolean;
  open(config: {
    readonly schema: string;
    readonly max: number;
    readonly timeouts?: DriverTimeouts;
    readonly url?: string;
  }): DriverPool | Promise<DriverPool>;
  connect: TxSuite["connect"];
};

/**
 * Runs `okm driver test` arguments and returns the report.
 *
 * A failed case sets {@link DriverReport.failed}. Unsupported does not.
 *
 * @param argv - Arguments after `driver test`
 * @returns The report
 */
/** Lowest Bun that may run `okm driver test` (B-42). Declared in package.json engines.bun. */
export const MIN_BUN = "1.4.0";

export async function executeDriverTest(argv: readonly string[]): Promise<DriverReport> {
  process.env.TZ = "UTC";
  refuseOldBun();
  const parsed = parseArgs(argv);
  const target = await loadTarget(parsed.driver, parsed.url);
  const { rows, counts } = await runTarget(target);
  const failed = rows.filter((row) => row.result === "fail").length;
  return { text: render(target.name, rows, counts), failed };
}

/**
 * Stops when this process is Bun below {@link MIN_BUN}.
 *
 * Bun 1.3.13 reported wire cases as pass without running them. A case that
 * does not execute must not be counted as pass.
 */
function refuseOldBun(): void {
  if (typeof Bun === "undefined") return;
  const version = typeof Bun.version === "string" ? Bun.version : "";
  if (bunAtLeast(version, MIN_BUN)) return;
  throw new Error(
    `okm driver test needs Bun >=${MIN_BUN} (package.json engines.bun). This process is ${version === "" ? "Bun (unknown version)" : `Bun ${version}`}.`,
  );
}

/**
 * Whether `version` is at least `minimum` (major.minor.patch).
 *
 * @param version - `Bun.version`
 * @param minimum - Floor such as `1.4.0`
 * @returns `true` when version meets the floor
 */
export function bunAtLeast(version: string, minimum: string): boolean {
  const left = parseSemver(version);
  const right = parseSemver(minimum);
  if (left === undefined || right === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function parseSemver(value: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

if (import.meta.main) {
  executeDriverTest(process.argv.slice(2))
    .then((report) => {
      process.stdout.write(report.text);
      if (report.failed > 0) {
        process.stderr.write(`${String(report.failed)} conformance case(s) failed.\n`);
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}

type ParsedArgs = {
  readonly driver: string;
  readonly url: string | undefined;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  let driver: string | undefined;
  let url: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--url") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("okm driver test --url needs a postgres URL.");
      }
      url = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
      if (url.length === 0) throw new Error("okm driver test --url needs a postgres URL.");
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown flag ${arg}.`);
    if (driver !== undefined) throw new Error("okm driver test takes one driver.");
    driver = arg;
  }
  if (driver === undefined) {
    throw new Error(
      "okm driver test needs a driver: pglite, postgresjs, pg, bun, neon, or a module path.",
    );
  }
  return { driver, url: url ?? process.env.DATABASE_URL };
}

async function loadTarget(driver: string, url: string | undefined): Promise<Target> {
  if (
    driver === "pglite" ||
    driver === "postgresjs" ||
    driver === "pg" ||
    driver === "bun" ||
    driver === "neon"
  ) {
    return firstParty(driver, url);
  }
  if (
    driver.includes("/") ||
    driver.startsWith(".") ||
    driver.endsWith(".ts") ||
    driver.endsWith(".js")
  ) {
    return moduleTarget(driver, url);
  }
  throw new Error(
    `Unknown driver ${driver}. Use pglite, postgresjs, pg, bun, neon, or a module path.`,
  );
}

async function firstParty(driver: string, url: string | undefined): Promise<Target> {
  if (driver === "pglite") {
    const adapter = await import("../../../src/adapters/pg/pglite.js");
    const runtime = await import("../../../src/runtime/pg/pglite.js");
    const { openPreparedPglite } = await import("./pglite-template.js");
    return {
      name: "pglite",
      capabilities: adapter.capabilities,
      memory: true,
      notices: true,
      size: 1,
      cut: true,
      statementDescribe: true,
      open: (config) =>
        openPreparedPglite(
          [],
          config.timeouts?.acquire !== undefined ? { acquire: config.timeouts.acquire } : undefined,
        ),
      connect: (pool, options) => runtime.connect(pool, options),
    };
  }
  if (url === undefined) throw new Error(`okm driver test ${driver} needs --url or DATABASE_URL.`);
  if (driver === "postgresjs") {
    const adapter = await import("../../../src/adapters/pg/postgresjs.js");
    const runtime = await import("../../../src/runtime/pg/postgresjs.js");
    return {
      ...networked(
        "postgres.js",
        adapter.capabilities,
        true,
        url,
        (config) =>
          adapter.open({
            url: config.url ?? url,
            max: config.max,
            searchPath: config.schema,
            ...(config.timeouts !== undefined ? { timeouts: config.timeouts } : {}),
          }),
        (pool, options) => runtime.connect(pool, options),
      ),
      statementDescribe: true,
    };
  }
  if (driver === "pg") {
    const adapter = await import("../../../src/adapters/pg/nodepostgres.js");
    const runtime = await import("../../../src/runtime/pg/pg.js");
    return networked(
      "node-postgres",
      adapter.capabilities,
      true,
      url,
      (config) =>
        adapter.open({
          url: config.url ?? url,
          max: config.max,
          searchPath: config.schema,
          ...(config.timeouts !== undefined ? { timeouts: config.timeouts } : {}),
        }),
      (pool, options) => runtime.connect(pool, options),
    );
  }
  if (driver === "neon") {
    const adapter = await import("../../../src/adapters/pg/neon.js");
    const runtime = await import("../../../src/runtime/pg/neon.js");
    return networked(
      "neon",
      adapter.capabilities,
      false,
      url,
      (config) =>
        adapter.open({
          url: config.url ?? url,
          max: config.max,
          searchPath: config.schema,
          ...(config.timeouts !== undefined ? { timeouts: config.timeouts } : {}),
        }),
      (pool, options) => runtime.connect(pool, options),
      false,
    );
  }
  if (typeof Bun === "undefined" || typeof Bun.SQL !== "function") {
    throw new Error("bun runs only under Bun.");
  }
  const adapter = await import("../../../src/adapters/pg/bunsql.js");
  const runtime = await import("../../../src/runtime/pg/bun.js");
  return networked(
    "bun.sql",
    adapter.capabilities,
    false,
    url,
    (config) =>
      adapter.open({
        url: config.url ?? url,
        max: config.max,
        searchPath: config.schema,
        ...(config.timeouts !== undefined ? { timeouts: config.timeouts } : {}),
      }),
    (pool, options) => runtime.connect(pool, options),
  );
}

function networked(
  name: string,
  capabilities: DriverCapabilities,
  notices: boolean,
  url: string,
  open: Target["open"],
  connect: TxSuite["connect"],
  cut = true,
): Target {
  return {
    name,
    capabilities,
    memory: false,
    notices,
    size: 4,
    url,
    cut,
    open,
    connect,
  };
}

async function moduleTarget(driver: string, url: string | undefined): Promise<Target> {
  const loaded: unknown = await import(pathToFileURL(resolve(driver)).href);
  const body = moduleBody(loaded);
  if (body === undefined) throw new Error(`${driver} must export the driver object.`);
  const name = body.name;
  const open = body.open;
  const connect = body.connect;
  if (typeof name !== "string" || name.trim() === "" || /\s/.test(name)) {
    throw new Error(`${driver} must export a name with no spaces.`);
  }
  if (!isCapabilities(body.capabilities)) {
    throw new Error(`${driver} must export capabilities.`);
  }
  if (typeof open !== "function" || typeof connect !== "function") {
    throw new Error(`${driver} must export open and connect.`);
  }
  const memory = body.memory === true;
  if (!memory && url === undefined) {
    throw new Error(`okm driver test ${name} needs --url or DATABASE_URL.`);
  }
  const notices = body.notices === undefined ? true : body.notices === true;
  const size = typeof body.size === "number" ? body.size : memory ? 1 : 4;
  return {
    name,
    capabilities: body.capabilities,
    memory,
    notices,
    size,
    cut: true,
    ...(url !== undefined ? { url } : {}),
    open: open as Target["open"],
    connect: connect as Target["connect"],
  };
}

function moduleBody(loaded: unknown): Record<string, unknown> | undefined {
  if (!isRecord(loaded)) return undefined;
  return isRecord(loaded.default) ? loaded.default : loaded;
}

function isCapabilities(value: unknown): value is DriverCapabilities {
  if (!isRecord(value)) return false;
  return (
    (value.transactions === "interactive" ||
      value.transactions === "batch" ||
      value.transactions === "none") &&
    typeof value.stream === "boolean" &&
    typeof value.listen === "boolean" &&
    typeof value.cancel === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Job = {
  readonly title: string;
  readonly group: string;
  readonly fn?: () => Promise<void>;
  readonly timeoutMs?: number;
  readonly capability?: string;
};

async function runTarget(target: Target): Promise<{
  readonly rows: readonly Row[];
  readonly counts: ConformanceCounts;
}> {
  const jobs: Job[] = [];
  const counts = { portable: 0, gated: 0, refusal: 0, unsupported: 0 };
  const wire = recorder(target.name, "wire", jobs, counts);
  const errors = recorder(target.name, "error", jobs, counts);
  const tx = recorder(target.name, "tx", jobs, counts);
  registerDriverSuite({
    name: target.name,
    open: () => target.open({ schema: "public", max: target.size, timeouts: { acquire: 5_000 } }),
    openLimited: () =>
      target.open({
        schema: "public",
        max: 1,
        timeouts: { acquire: target.memory ? 100 : 150 },
      }),
    openOther: () => target.open({ schema: "public", max: target.memory ? 1 : 2 }),
    size: target.size,
    capabilities: target.capabilities,
    ...(target.statementDescribe === true ? { statementDescribe: true } : {}),
    ...(target.notices ? {} : { notices: false }),
    test: wire,
  });
  registerErrorMappingSuite({
    name: target.name,
    open: () => target.open({ schema: "public", max: target.size, timeouts: { acquire: 5_000 } }),
    capabilities: target.capabilities,
    test: errors,
  });
  registerTxSuite({
    name: target.name,
    capabilities: target.capabilities,
    open: (config) => target.open(config),
    connect: (pool, options) => target.connect(pool, options),
    memory: target.memory,
    notices: target.notices,
    ...(target.cut ? {} : { cut: false }),
    ...(target.url !== undefined ? { url: target.url } : {}),
    test: tx,
  });
  const rows: Row[] = [];
  for (const job of jobs) {
    rows.push(await runJob(job));
  }
  return { rows, counts };
}

function recorder(
  driver: string,
  group: string,
  jobs: Job[],
  counts: { portable: number; gated: number; refusal: number; unsupported: number },
): SuiteTest {
  const register: SuiteTest = (title, fn, timeoutMs) => {
    jobs.push({
      title: strip(driver, title),
      group,
      fn,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  };
  register.skip = (title) => {
    jobs.push({ title: strip(driver, title), group, capability: "undeclared" });
  };
  register.unsupported = (title, capability) => {
    jobs.push({ title: strip(driver, title), group, capability });
  };
  register.note = (_title, tier, outcome) => {
    if (outcome === "refusal") counts.refusal += 1;
    else if (outcome === "unsupported") counts.unsupported += 1;
    else if (tier.kind === "portable") counts.portable += 1;
    else counts.gated += 1;
  };
  return register;
}

async function runJob(job: Job): Promise<Row> {
  const identified = identify(job.group, job.title);
  if (job.fn === undefined) {
    // Skipped / unsupported cases must not be reported as pass (B-42).
    return {
      id: identified.id,
      behavior: identified.behavior,
      result: "unsupported",
      capability: job.capability ?? "undeclared",
    };
  }
  const timeoutMs = Math.max(job.timeoutMs ?? 0, 20_000);
  try {
    await withTimeout(job.fn(), timeoutMs);
    return { id: identified.id, behavior: identified.behavior, result: "pass", capability: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: identified.id,
      behavior: identified.behavior,
      result: "fail",
      capability: "",
      detail: message,
    };
  }
}

function withTimeout(pending: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${String(timeoutMs)}ms`)),
      timeoutMs,
    );
    pending.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function identify(group: string, title: string): { id: string; behavior: string } {
  const named = /^(r\d+\.[a-z0-9-]+) (.*)$/.exec(title);
  const id = named?.[1];
  const behavior = named?.[2];
  if (id !== undefined && behavior !== undefined) return { id, behavior };
  if (title.startsWith("a commit cut on the wire"))
    return { id: "r2.commit-loss", behavior: title };
  if (title.startsWith("a batch whose commit is cut")) {
    return { id: "r2.batch-commit-loss", behavior: title };
  }
  return { id: `${group}.${slug(title)}`, behavior: title };
}

function slug(title: string): string {
  const text = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text.length > 80 ? text.slice(0, 80).replace(/-+$/g, "") : text;
}

function strip(driver: string, title: string): string {
  const lead = `${driver} `;
  return title.startsWith(lead) ? title.slice(lead.length) : title;
}

function render(driver: string, rows: readonly Row[], counts: ConformanceCounts): string {
  const lines = [`driver ${driver}`, "dialect postgres", "id\tbehavior\tresult\tcapability"];
  for (const row of rows) {
    lines.push(`${row.id}\t${row.behavior}\t${row.result}\t${row.capability}`);
    if (row.detail !== undefined) lines.push(`  ${row.detail}`);
  }
  lines.push(formatConformanceCounts(counts));
  return `${lines.join("\n")}\n`;
}
