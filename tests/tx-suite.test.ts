/**
 * Transaction conformance for the four runtime adapters (spec §15).
 */

import { test } from "bun:test";

import type { SuiteTest } from "../packages/harness/src/driver-suite.js";
import {
  loadPostgresGate,
  postgresTest,
  requirePostgresWhenAsked,
} from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { registerTxSuite } from "../packages/harness/src/tx-suite.js";
import { BUNSQL_CAPABILITIES } from "../src/adapters/capabilities.js";
import {
  capabilities as nodePostgresCapabilities,
  open as openNodePostgres,
} from "../src/adapters/pg/nodepostgres.js";
import {
  capabilities as pgliteCapabilities,
  open as openPglite,
} from "../src/adapters/pg/pglite.js";
import {
  capabilities as postgresCapabilities,
  open as openPostgres,
} from "../src/adapters/pg/postgresjs.js";
import { connect as connectNodePostgres } from "../src/runtime/pg/pg.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

const bunTest: SuiteTest = (name, fn, timeoutMs) => {
  test(name, fn, timeoutMs === undefined ? undefined : { timeout: timeoutMs });
};
bunTest.skip = (name, fn) => {
  test.skip(name, fn);
};

const postgresCases: SuiteTest = (name, fn, timeoutMs) => {
  postgresTest(decision, name, fn, timeoutMs ?? 10_000);
};
postgresCases.skip = (name, fn) => {
  test.skip(name, fn);
};

registerTxSuite({
  name: "pglite",
  capabilities: pgliteCapabilities,
  open: () => openPglite(),
  connect: (pool, options) => connectPglite(pool, options),
  memory: true,
  notices: true,
  test: bunTest,
});

registerTxSuite({
  name: "postgres.js",
  capabilities: postgresCapabilities,
  open: (config) =>
    openPostgres({
      url: config.url ?? primaryUrl(),
      max: config.max,
      searchPath: config.schema,
      ...(config.timeouts !== undefined ? { timeouts: config.timeouts } : {}),
    }),
  connect: (pool, options) => connectPostgres(pool, options),
  memory: false,
  notices: true,
  test: postgresCases,
});

registerTxSuite({
  name: "node-postgres",
  capabilities: nodePostgresCapabilities,
  open: (config) =>
    openNodePostgres({
      url: config.url ?? primaryUrl(),
      max: config.max,
      searchPath: config.schema,
      ...(config.timeouts !== undefined ? { timeouts: config.timeouts } : {}),
    }),
  connect: (pool, options) => connectNodePostgres(pool, options),
  memory: false,
  notices: true,
  test: postgresCases,
});

const bunSql = typeof Bun !== "undefined" && typeof Bun.SQL === "function";
if (bunSql) {
  const adapter = await import("../src/adapters/pg/bunsql.js");
  const runtime = await import("../src/runtime/pg/bun.js");
  registerTxSuite({
    name: "bun.sql",
    capabilities: adapter.capabilities ?? BUNSQL_CAPABILITIES,
    open: (config) =>
      adapter.open({
        url: config.url ?? primaryUrl(),
        max: config.max,
        searchPath: config.schema,
        ...(config.timeouts !== undefined ? { timeouts: config.timeouts } : {}),
      }),
    connect: (pool, options) => runtime.connect(pool, options),
    memory: false,
    notices: false,
    test: postgresCases,
  });
} else {
  test.skip("bun.sql transactions (Bun.sql runs only under Bun)", () => undefined);
}
