/**
 * Renders the driver compatibility table from a conformance run.
 *
 * The page is generated. A hand edit drifts from the suite and the test fails.
 */

import { registerErrorMappingSuite } from "../packages/harness/src/error-suite.js";
import { registerDriverSuite, type SuiteTest } from "../packages/harness/src/driver-suite.js";
import { postgresDecision } from "../packages/harness/src/docker-gate.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import type { DriverCapabilities, DriverPool } from "../src/contracts/driver.js";
import {
  capabilities as pgliteCapabilities,
  open as openPglite,
} from "../src/adapters/pg/pglite.js";
import {
  capabilities as postgresCapabilities,
  open as openPostgres,
} from "../src/adapters/pg/postgresjs.js";

/** One case on one driver. */
export type CompatibilityCell = {
  readonly driver: string;
  /** Case title with the driver prefix removed. */
  readonly name: string;
  readonly result: "pass" | "skip" | "fail";
};

/**
 * Renders the compatibility page.
 *
 * @param cells - Results from the suites that ran
 * @returns Markdown
 */
export function renderCompatibility(cells: readonly CompatibilityCell[]): string {
  const drivers = [...unique(cells.map((cell) => cell.driver))].sort(
    (left, right) => rank(left) - rank(right),
  );
  const names = unique(cells.map((cell) => cell.name));
  const lookup = new Map(cells.map((cell) => [`${cell.driver}\n${cell.name}`, cell.result]));
  const header = ["Case", ...drivers];
  const lines = [
    "# Driver compatibility",
    "",
    "Generated from the conformance run (`tests/driver-suite.test.ts` and `tests/error-suite.test.ts`). Do not edit by hand.",
    "",
    "PGlite runs in the check job. postgres.js runs in the postgres job (`REQUIRE_DOCKER=1`). A skip means the adapter did not declare the capability that case needs.",
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const name of names) {
    const row = [name];
    for (const driver of drivers) {
      row.push(lookup.get(`${driver}\n${name}`) ?? "not-run");
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Runs the driver and error-mapping suites and records pass or skip.
 *
 * PGlite always runs. postgres.js runs when the topology accepts connections.
 *
 * @returns One cell per case per driver that ran
 */
export async function collectCompatibility(): Promise<readonly CompatibilityCell[]> {
  process.env.TZ = "UTC";
  const cells: CompatibilityCell[] = [];
  await runDriver("pglite", "PGlite", cells, {
    open: () => openPglite({ timeouts: { acquire: 5_000 } }),
    openLimited: () => openPglite({ timeouts: { acquire: 100 } }),
    openOther: () => openPglite(),
    size: 1,
    capabilities: pgliteCapabilities,
  });
  const decision = await postgresDecision();
  if (decision.run) {
    await runDriver("postgres.js", "postgres.js", cells, {
      open: () => openPostgres({ url: primaryUrl(), max: 4, timeouts: { acquire: 5_000 } }),
      openLimited: () => openPostgres({ url: primaryUrl(), max: 1, timeouts: { acquire: 150 } }),
      openOther: () => openPostgres({ url: primaryUrl(), max: 2 }),
      size: 4,
      capabilities: postgresCapabilities,
    });
  }
  return cells;
}

type Openers = {
  readonly open: () => DriverPool | Promise<DriverPool>;
  readonly openLimited: () => DriverPool | Promise<DriverPool>;
  readonly openOther: () => DriverPool | Promise<DriverPool>;
  readonly size: number;
  readonly capabilities: DriverCapabilities;
};

async function runDriver(
  prefix: string,
  driver: string,
  cells: CompatibilityCell[],
  openers: Openers,
): Promise<void> {
  const jobs: { readonly name: string; readonly fn?: () => Promise<void> }[] = [];
  const test = recorder(prefix, jobs);
  registerDriverSuite({
    name: prefix,
    open: openers.open,
    openLimited: openers.openLimited,
    openOther: openers.openOther,
    size: openers.size,
    capabilities: openers.capabilities,
    test,
  });
  registerErrorMappingSuite({
    name: prefix,
    open: openers.open,
    capabilities: openers.capabilities,
    test,
  });
  for (const job of jobs) {
    if (job.fn === undefined) {
      cells.push({ driver, name: job.name, result: "skip" });
      continue;
    }
    try {
      await job.fn();
      cells.push({ driver, name: job.name, result: "pass" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${driver} ${job.name} failed: ${message}`);
    }
  }
}

function recorder(prefix: string, jobs: { name: string; fn?: () => Promise<void> }[]): SuiteTest {
  const register: SuiteTest = (name, fn) => {
    jobs.push({ name: strip(prefix, name), fn });
  };
  register.skip = (name) => {
    jobs.push({ name: strip(prefix, name) });
  };
  return register;
}

function strip(prefix: string, name: string): string {
  const lead = `${prefix} `;
  return name.startsWith(lead) ? name.slice(lead.length) : name;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function rank(name: string): number {
  const preferred = ["postgres.js", "PGlite"];
  const index = preferred.indexOf(name);
  return index === -1 ? preferred.length : index;
}
