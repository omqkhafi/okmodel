/**
 * Conformance v1 for the postgres.js and PGlite adapters.
 */

import { expect, test } from "bun:test";

import { registerDriverSuite, type SuiteTest } from "../packages/harness/src/driver-suite.js";
import {
  loadPostgresGate,
  postgresTest,
  requirePostgresWhenAsked,
} from "../packages/harness/src/postgres-test.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { capabilities as pgliteCapabilities } from "../src/adapters/pg/pglite.js";
import { openPreparedPglite } from "../packages/harness/src/pglite-template.js";
import {
  open as openPostgres,
  capabilities as postgresCapabilities,
} from "../src/adapters/pg/postgresjs.js";
import {
  open as openNodePostgres,
  capabilities as nodePostgresCapabilities,
} from "../src/adapters/pg/nodepostgres.js";
import { BUNSQL_CAPABILITIES } from "../src/adapters/capabilities.js";

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
  open: () => openPreparedPglite([], { acquire: 5_000 }),
  openLimited: () => openPreparedPglite([], { acquire: 100 }),
  openOther: () => openPreparedPglite([]),
  size: 1,
  capabilities: pgliteCapabilities,
  statementDescribe: true,
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
  statementDescribe: true,
  test: postgresCases,
});

registerDriverSuite({
  name: "node-postgres",
  open: () => openNodePostgres({ url: primaryUrl(), max: 4, timeouts: { acquire: 5_000 } }),
  openLimited: () => openNodePostgres({ url: primaryUrl(), max: 1, timeouts: { acquire: 150 } }),
  openOther: () => openNodePostgres({ url: primaryUrl(), max: 2 }),
  size: 4,
  capabilities: nodePostgresCapabilities,
  test: postgresCases,
});

const bunSql = bunSqlAvailable() ? await import("../src/adapters/pg/bunsql.js") : undefined;
const bunUnavailable = (): never => {
  throw new Error("Bun.sql runs only under Bun");
};

registerDriverSuite({
  name: "bun.sql",
  open: () =>
    bunSql?.open({ url: primaryUrl(), max: 4, timeouts: { acquire: 5_000 } }) ?? bunUnavailable(),
  openLimited: () =>
    bunSql?.open({ url: primaryUrl(), max: 1, timeouts: { acquire: 150 } }) ?? bunUnavailable(),
  openOther: () => bunSql?.open({ url: primaryUrl(), max: 2 }) ?? bunUnavailable(),
  size: 4,
  capabilities: bunSql?.capabilities ?? BUNSQL_CAPABILITIES,
  notices: false,
  test: bunSql === undefined ? skipped("Bun.sql runs only under Bun") : postgresCases,
});

postgresTest(decision, "a driver-suite case drops its okm_ tables", async () => {
  const jobs: { name: string; fn?: () => Promise<void> }[] = [];
  const registrar = Object.assign(
    (name: string, fn: () => Promise<void>) => {
      jobs.push({ name, fn });
    },
    {
      skip(name: string) {
        jobs.push({ name });
      },
    },
  );
  registerDriverSuite({
    name: "cleanup-check",
    open: () => openPostgres({ url: primaryUrl(), max: 2, timeouts: { acquire: 5_000 } }),
    openLimited: () => openPostgres({ url: primaryUrl(), max: 1, timeouts: { acquire: 150 } }),
    openOther: () => openPostgres({ url: primaryUrl(), max: 1 }),
    size: 2,
    capabilities: postgresCapabilities,
    test: registrar,
  });
  const batch = jobs.find((job) => job.name.includes("batch commits every statement"));
  if (batch?.fn === undefined) throw new Error("expected the batch commits case");
  await batch.fn();
  const pool = openPostgres({ url: primaryUrl(), max: 1 });
  try {
    const result = await pool.execute(`
      select tablename
      from pg_tables
      where schemaname = current_schema()
        and tablename like 'okm\\_%' escape '\\'
      order by 1`);
    expect(result.rows).toEqual([]);
  } finally {
    await pool.close();
  }
});

/**
 * Reports whether this process can open Bun.sql.
 *
 * @returns `true` on Bun
 */
function bunSqlAvailable(): boolean {
  return typeof Bun !== "undefined" && typeof Bun.SQL === "function";
}

/**
 * Skips every case with one reason.
 *
 * @param reason - Why the driver is not running
 * @returns A registrar that skips
 */
function skipped(reason: string): SuiteTest {
  const register: SuiteTest = (name, fn) => {
    test.skip(`${name} (${reason})`, fn);
  };
  register.skip = (name, fn) => {
    test.skip(`${name} (${reason})`, fn);
  };
  return register;
}
