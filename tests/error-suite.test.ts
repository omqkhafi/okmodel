/**
 * Error-mapping conformance for postgres.js and PGlite.
 */

import { test } from "bun:test";

import { registerErrorMappingSuite } from "../packages/harness/src/error-suite.js";
import type { SuiteTest } from "../packages/harness/src/driver-suite.js";
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

registerErrorMappingSuite({
  name: "pglite",
  open: () => openPglite(),
  capabilities: pgliteCapabilities,
  test: bunTest,
});

const postgresCases: SuiteTest = (name, fn, timeoutMs) => {
  postgresTest(decision, name, fn, timeoutMs ?? 10_000);
};
postgresCases.skip = (name, fn) => {
  test.skip(name, fn);
};

registerErrorMappingSuite({
  name: "postgres.js",
  open: () => openPostgres({ url: primaryUrl(), max: 4 }),
  capabilities: postgresCapabilities,
  test: postgresCases,
});
