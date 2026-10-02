/**
 * Conformance v1 for the postgres.js and PGlite adapters.
 */

import { test } from "bun:test";

import { registerDriverSuite, type SuiteTest } from "../packages/harness/src/driver-suite.js";
import {
  loadPostgresGate,
  postgresTest,
  requirePostgresWhenAsked,
} from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import {
  open as openPglite,
  capabilities as pgliteCapabilities,
} from "../src/adapters/pg/pglite.js";
import {
  open as openPostgres,
  capabilities as postgresCapabilities,
} from "../src/adapters/pg/postgresjs.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

const bunTest: SuiteTest = (name, fn, timeoutMs) => {
  test(name, fn, timeoutMs === undefined ? undefined : { timeout: timeoutMs });
};
bunTest.skip = (name, fn, timeoutMs) => {
  test.skip(name, fn, timeoutMs === undefined ? undefined : { timeout: timeoutMs });
};

registerDriverSuite({
  name: "pglite",
  open: () => openPglite({ timeouts: { acquire: 5_000 } }),
  openLimited: () => openPglite({ timeouts: { acquire: 100 } }),
  openOther: () => openPglite(),
  size: 1,
  capabilities: pgliteCapabilities,
  test: bunTest,
});

const postgresCases: SuiteTest = (name, fn, timeoutMs) => {
  postgresTest(decision, name, fn, timeoutMs ?? 10_000);
};
postgresCases.skip = (name, fn) => {
  test.skip(name, fn);
};

registerDriverSuite({
  name: "postgres.js",
  open: () => openPostgres({ url: primaryUrl(), max: 4, timeouts: { acquire: 5_000 } }),
  openLimited: () => openPostgres({ url: primaryUrl(), max: 1, timeouts: { acquire: 150 } }),
  openOther: () => openPostgres({ url: primaryUrl(), max: 2 }),
  size: 4,
  capabilities: postgresCapabilities,
  test: postgresCases,
});
