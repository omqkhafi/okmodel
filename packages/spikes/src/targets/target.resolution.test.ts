/**
 * Invariant G: the registry resolves Targets. It is not a connection.
 */

import { expect, test } from "bun:test";

import { openPostgres, primaryUrl } from "@okmodel/harness";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { dropEmptyDatabase } from "./admin.js";
import { connectionDetailHits } from "./plan.js";
import { createMemoryRegistry } from "./registry.js";
import { connectionUrl, resolveTarget } from "./resolver.js";
import { sharedTarget } from "./target.js";
import { TargetError } from "./error.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

test("target.resolution", () => {
  const registry = createMemoryRegistry({
    strategy: "schemaPerTenant",
    origin: primaryUrl(),
    appPassword: "app-secret",
    migrationPassword: "mig-secret",
    database: "okm",
    prefix: "unused",
  });
  const acme = registry.addTenant("acme");
  const uuid = registry.addTenant("550e8400-e29b-41d4-a716-446655440000");

  expect("execute" in registry).toBe(false);
  expect("query" in registry).toBe(false);
  expect("reserve" in registry).toBe(false);
  expect(connectionDetailHits(registry.list())).toEqual([]);
  expect(acme.strategy).toBe("schemaPerTenant");
  expect(acme.namespace).toBe("tenant_{id}");
  expect(acme.tenantId).toBe("acme");
  expect(uuid.tenantId).toBe("550e8400e29b41d4a716446655440000");
  expect(registry.schemaName("acme")).toBe("tenant_acme");
  expect(registry.schemaName("550e8400-e29b-41d4-a716-446655440000")).toBe(
    "tenant_550e8400e29b41d4a716446655440000",
  );

  const app = connectionUrl(registry.resolve("acme", { role: "app" }));
  const migration = connectionUrl(registry.resolve("acme", { role: "migration" }));
  expect(new URL(app).pathname).toBe("/okm");
  expect(new URL(migration).pathname).toBe("/okm");
  expect(new URL(app).password).toBe("app-secret");
  expect(new URL(migration).password).toBe("mig-secret");
  expect(connectionUrl(registry.resolve(uuid.tenantId ?? "", { role: "migration" }))).toBe(
    migration,
  );

  const source = { database: primaryUrl(), tenants: registry };
  expect(connectionUrl(resolveTarget(source, acme, "migration"))).toBe(migration);
  expect(connectionUrl(resolveTarget(source, sharedTarget("default", true), "migration"))).toBe(
    primaryUrl(),
  );

  expect(() => registry.addTenant("Acme")).toThrow(TargetError);
  expect(() => registry.addTenant("a;drop")).toThrow(/OKM1120/);
  expect(() => registry.resolve("missing", { role: "app" })).toThrow(/OKM1845/);
});

test("database-per-tenant targets name a database and not a connection", () => {
  const registry = createMemoryRegistry({
    strategy: "databasePerTenant",
    origin: primaryUrl(),
    appPassword: "okm",
    migrationPassword: "okm",
    database: "okm",
    prefix: "p08b_names",
  });
  const first = registry.addTenant("one");
  const second = registry.addTenant("two");
  expect(connectionDetailHits([first, second])).toEqual([]);
  expect(first.namespace).toBe("public");
  expect(registry.databaseName("one")).not.toBe(registry.databaseName("two"));
  const one = new URL(connectionUrl(registry.resolve("one", { role: "migration" })));
  const two = new URL(connectionUrl(registry.resolve("two", { role: "migration" })));
  expect(one.pathname).not.toBe(two.pathname);
  expect(one.pathname).toBe(`/${registry.databaseName("one")}`);
});

postgresTest(decision, "database-per-tenant create opens an empty database", async () => {
  const admin = openPostgres();
  const prefix = `p08b_${crypto.randomUUID().slice(0, 8)}`;
  const registry = createMemoryRegistry({
    strategy: "databasePerTenant",
    origin: primaryUrl(),
    appPassword: "okm",
    migrationPassword: "okm",
    database: "okm",
    prefix,
    admin,
  });
  registry.addTenant("one");
  try {
    await registry.create?.("one");
    const url = connectionUrl(registry.resolve("one", { role: "migration" }));
    const tenant = openPostgres(url);
    try {
      const rows = await tenant`select current_database() as name`;
      expect(rows[0]?.name).toBe(registry.databaseName("one"));
    } finally {
      await tenant.end({ timeout: 5 });
    }
  } finally {
    await dropEmptyDatabase(admin, registry.databaseName("one"));
    await admin.end({ timeout: 5 });
  }
});
