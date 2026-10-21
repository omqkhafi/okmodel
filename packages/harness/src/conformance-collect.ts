/**
 * Registers the conformance suites against a recording test.
 *
 * The bodies are not run. Callers read the tier and the outcome.
 */

import type { DriverCapabilities, DriverPool } from "../../../src/contracts/driver.js";
import type { QuerySchema } from "../../../src/dialects/pg/model.js";
import { createClient } from "../../../src/runtime/client.js";
import type { ConnectOptions, Connected } from "../../../src/runtime/types.js";
import {
  conformanceProfile,
  type CaseOutcome,
  type CaseTier,
  type ConformanceProfile,
  type SuiteTest,
} from "./driver-suite.js";
import { registerDriverSuite } from "./driver-suite.js";
import { registerErrorMappingSuite } from "./error-suite.js";
import { registerTxSuite } from "./tx-suite.js";

/** One case the suites registered. */
export type ConformanceMark = {
  /** Case title, including the probe name prefix. */
  readonly title: string;
  /** Portable, or the registry key or capability gate. */
  readonly tier: CaseTier;
  /** Run, refusal assertion, or unsupported. */
  readonly outcome: CaseOutcome;
  /** Body, when the case was not only recorded. */
  readonly fn?: () => Promise<void>;
};

const STUB: DriverPool = {
  capabilities: { transactions: "none", stream: false, listen: false, cancel: false },
  execute: () => Promise.resolve({ rows: [], count: 0, notices: [] }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
};

/**
 * Registers the driver, error, and transaction suites and returns each case.
 *
 * @param profile - Registry and adapter flags
 * @param memory - When true, cases that need a second connection are unsupported
 * @returns The cases, in registration order
 */
export function collectConformanceMarks(
  profile: ConformanceProfile,
  memory = false,
): readonly ConformanceMark[] {
  const marks: ConformanceMark[] = [];
  const noted = new Map<string, { tier: CaseTier; outcome: CaseOutcome }>();
  const test: SuiteTest = (name, fn) => {
    const note = noted.get(name);
    if (note === undefined) throw new Error(`untagged case ${name}`);
    marks.push({ title: name, tier: note.tier, outcome: note.outcome, fn });
  };
  test.skip = (name) => {
    const note = noted.get(name);
    if (note === undefined) throw new Error(`untagged skip ${name}`);
    marks.push({ title: name, tier: note.tier, outcome: note.outcome });
  };
  test.unsupported = (name) => {
    const note = noted.get(name);
    if (note === undefined) throw new Error(`untagged unsupported ${name}`);
    marks.push({ title: name, tier: note.tier, outcome: "unsupported" });
  };
  test.note = (name, tier, outcome) => {
    noted.set(name, { tier, outcome });
  };
  const open = (): DriverPool => STUB;
  const capabilities: DriverCapabilities = profile.capabilities;
  const shared = conformanceProfile({ ...profile, capabilities });
  registerDriverSuite({
    name: "probe",
    open,
    openLimited: open,
    openOther: open,
    size: 1,
    capabilities,
    statementDescribe: true,
    ...(shared.registry !== undefined ? { registry: shared.registry } : {}),
    ...(shared.dialect !== undefined ? { dialect: shared.dialect } : {}),
    test,
  });
  registerErrorMappingSuite({
    name: "probe",
    open,
    capabilities,
    ...(shared.registry !== undefined ? { registry: shared.registry } : {}),
    ...(shared.dialect !== undefined ? { dialect: shared.dialect } : {}),
    test,
  });
  registerTxSuite({
    name: "probe",
    capabilities,
    open: () => open(),
    connect: <S extends QuerySchema>(pool: DriverPool, options: ConnectOptions<S>): Connected<S> =>
      createClient(options.schema, pool, { ownsPool: false }) as Connected<S>,
    memory,
    notices: true,
    cut: !memory,
    ...(shared.registry !== undefined ? { registry: shared.registry } : {}),
    ...(shared.dialect !== undefined ? { dialect: shared.dialect } : {}),
    test,
  });
  return marks;
}
