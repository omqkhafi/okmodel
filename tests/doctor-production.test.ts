/**
 * `okm doctor --production`: flag parsing and the finding rules that need no
 * database. The Postgres-backed cases are in `doctor-production-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { parseCli } from "../src/tooling/cli/parse.js";
import { COMMANDS } from "../src/tooling/cli/spec.js";
import { errorDoc } from "../src/tooling/errors/registry.js";
import type { MigrateConfig } from "../src/tooling/migrate/config.js";
import {
  buildReport,
  extensionFinding,
  formatReport,
  metaFinding,
  ownerFinding,
  poolerFinding,
  protectionFinding,
  roleConfigFinding,
  roleFinding,
  scrub,
  serverFinding,
  timeoutFindings,
  type ProductionFacts,
} from "../src/tooling/migrate/doctor-production.js";
import { poolerSignal } from "../src/tooling/migrate/policy.js";

const plain: MigrateConfig = { schema: "./schema.ts" };

function usageOf(argv: readonly string[]): string {
  try {
    parseCli(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    return (error as OkmError).message;
  }
  throw new Error("expected a usage error");
}

test("--production is a long-only flag on doctor", () => {
  const doctor = COMMANDS.find((command) => command.id === "doctor");
  const flag = doctor?.flags.find((item) => item.name === "production");
  expect(flag?.type).toBe("boolean");
  expect(flag?.short).toBeUndefined();
  expect(parseCli(["doctor", "--production"]).production).toBe(true);
  expect(parseCli(["doctor", "--production", "--target", "production"]).target).toBe("production");
  expect(parseCli(["doctor"]).production).toBe(false);
  expect(parseCli(["doctor", "--production", "--allow-pooler"]).allowPooler).toBe(true);
});

test("--production refuses a code, --bundle, and a stray --allow-pooler", () => {
  expect(usageOf(["doctor", "OKM1520", "--production"])).toContain("does not take an error code");
  expect(usageOf(["doctor", "--production", "--bundle"])).toContain("--bundle does not");
  expect(usageOf(["doctor", "--allow-pooler"])).toContain("--allow-pooler needs --production");
  expect(usageOf(["doctor", "--bundle", "--allow-pooler"])).toContain("--allow-pooler needs");
  expect(usageOf(["doctor", "--production", "--force-file"])).toContain("--force-file needs");
  expect(usageOf(["doctor", "-p"])).toBeTruthy();
});

test("the pooler patterns are the ones apply refuses", () => {
  expect(poolerSignal("postgres://u:p@db-pooler.example.com/app")).toBe("host");
  expect(poolerSignal("postgres://u:p@pgbouncer.internal/app")).toBe("host");
  expect(poolerSignal("postgres://u:p@db.example.com:6543/app")).toBe("port");
  expect(poolerSignal("postgres://u:p@db.example.com:6432/app")).toBe("port");
  expect(poolerSignal("postgres://u:p@db.example.com/app?pgbouncer=true")).toBe("parameter");
  expect(poolerSignal("postgres://u:p@db.example.com:5432/app")).toBeUndefined();
});

test("pooler: a warning, and a failure when the flag that allows it is on", () => {
  const url = "postgres://zq_user:zq_pass@db-pooler.zq-host.example:6543/app";
  const warned = poolerFinding(url, false);
  expect(warned).toMatchObject({ id: "pooler", severity: "warn", code: "OKM2203" });
  expect(warned.fix.length).toBeGreaterThan(0);
  expect(poolerFinding(url, true)).toMatchObject({
    id: "pooler",
    severity: "fail",
    code: "OKM2203",
  });
  expect(poolerFinding("postgres://u:p@db.example.com:5432/app", true).severity).toBe("ok");
  for (const text of [warned.summary, warned.fix, poolerFinding(url, true).summary]) {
    for (const secret of ["zq_user", "zq_pass", "zq-host", "6543"]) {
      expect(text).not.toContain(secret);
    }
  }
});

test("an unparsable URL is not a pooler finding", () => {
  expect(poolerFinding("not a url", false).severity).toBe("ok");
});

test("protection: only protected: true in config passes", () => {
  expect(protectionFinding({ name: "production", protection: "project" }).severity).toBe("ok");
  expect(protectionFinding({ name: "production", protection: "project-and-store" }).severity).toBe(
    "ok",
  );
  const open = protectionFinding({ name: "production", protection: "open" });
  expect(open).toMatchObject({ id: "target-protection", severity: "fail", code: "OKM2202" });
  const stored = protectionFinding({ name: "staging", protection: "store" });
  expect(stored.severity).toBe("fail");
  expect(stored.summary).toContain("store");
});

test("a name or NODE_ENV never makes a target protected", () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    expect(protectionFinding({ name: "production", protection: "open" }).severity).toBe("fail");
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});

test("okm_meta: a missing table fails and the text says the check cannot see connect()", () => {
  expect(metaFinding(true).severity).toBe("ok");
  const missing = metaFinding(false);
  expect(missing).toMatchObject({ id: "okm-meta", severity: "fail", code: "OKM1520" });
  expect(missing.summary).toContain("cannot see connect() options");
  expect(metaFinding(true).summary).toContain("cannot see connect() options");
});

test("role: superuser and BYPASSRLS fail, an owner warns", () => {
  expect(roleFinding({ superuser: true, bypassRls: false })).toMatchObject({
    id: "role-privilege",
    severity: "fail",
    code: "OKM1707",
  });
  expect(roleFinding({ superuser: false, bypassRls: true }).severity).toBe("fail");
  expect(roleFinding({ superuser: false, bypassRls: false }).severity).toBe("ok");
  expect(roleFinding(undefined).severity).toBe("fail");
  const owner = ownerFinding(2, false);
  expect(owner).toMatchObject({ id: "role-owns-tables", severity: "warn" });
  expect(owner.summary).toContain("fine for the migrator");
  expect(ownerFinding(0, false).severity).toBe("ok");
  expect(ownerFinding(3, true).severity).toBe("ok");
});

test("role-config reports the refusal the role health check raised", () => {
  expect(roleConfigFinding(undefined).severity).toBe("ok");
  const failed = roleConfigFinding({
    code: "OKM1825",
    message: "Role app lacks SELECT.",
    fix: "Grant it.",
  });
  expect(failed).toMatchObject({ id: "role-config", severity: "fail", code: "OKM1825" });
  const plainKind = roleConfigFinding({
    code: "not_found",
    message: "Role missing.",
    fix: "Create it.",
  });
  expect(plainKind.code).toBeUndefined();
});

test("timeouts: apply's own lock_timeout is the one reported, and zero warns", () => {
  const [lock, statement] = timeoutFindings(plain, 0, 30_000);
  expect(lock).toMatchObject({ id: "lock-timeout", severity: "ok" });
  expect(lock?.summary).toContain("okm migrate apply sets lock_timeout to 5000 ms (default)");
  expect(statement).toMatchObject({ id: "statement-timeout", severity: "ok" });
  const configured = timeoutFindings(
    { ...plain, timeouts: { lock: 9_000, statement: 60_000 } },
    1,
    2,
  );
  expect(configured[0]?.summary).toContain("9000 ms (timeouts.lock)");
  expect(configured[1]?.summary).toContain("60000 ms (timeouts.statement)");
  const zero = timeoutFindings({ ...plain, timeouts: { lock: 0 } }, 0, 0);
  expect(zero[0]).toMatchObject({ severity: "warn", code: "OKM2201" });
  expect(zero[1]).toMatchObject({ severity: "warn", code: "OKM2201" });
});

test("server: the supported window is 15 to 18", () => {
  expect(serverFinding(17, undefined).severity).toBe("ok");
  expect(serverFinding(15, undefined).severity).toBe("ok");
  expect(serverFinding(18, undefined).severity).toBe("ok");
  expect(serverFinding(14, undefined)).toMatchObject({ severity: "fail", code: "OKM1803" });
  expect(serverFinding(19, undefined)).toMatchObject({ severity: "warn" });
  const floor = serverFinding(15, {
    code: "OKM1802",
    message: "The server is PostgreSQL 15.",
    fix: "Upgrade.",
  });
  expect(floor).toMatchObject({ severity: "fail", code: "OKM1802" });
});

test("extensions list their versions, or the refusal", () => {
  const ok = extensionFinding({
    required: ["pg_trgm", "vector"],
    versions: new Map([["pg_trgm", "1.6"]]),
    refusal: undefined,
  });
  expect(ok.severity).toBe("ok");
  expect(ok.summary).toContain("pg_trgm 1.6");
  expect(ok.summary).toContain("vector (a migration creates it)");
  expect(extensionFinding({ required: [], versions: new Map(), refusal: undefined }).severity).toBe(
    "ok",
  );
  const failed = extensionFinding({
    required: ["vector"],
    versions: new Map(),
    refusal: { code: "OKM1811", message: "Extension vector is not installed.", fix: "Install it." },
  });
  expect(failed).toMatchObject({ id: "extensions", severity: "fail", code: "OKM1811" });
});

const quiet: ProductionFacts = {
  metaPresent: true,
  role: { superuser: false, bypassRls: false },
  ownedTables: 0,
  sessionLockMs: 5_000,
  sessionStatementMs: 30_000,
  serverMajor: 17,
  minimum: undefined,
  roleConfig: "not-set",
  extensions: { required: [], versions: new Map(), refusal: undefined },
};

test("the report has a fixed order, ids, and counts", () => {
  const report = buildReport(
    {
      target: {
        name: "production",
        protection: "open",
        url: "postgres://zq_user:zq_pass@db.zq-host.example:5432/zq_db",
      },
      config: plain,
      allowPooler: false,
    },
    quiet,
  );
  expect(report.findings.map((item) => item.id)).toEqual([
    "target-protection",
    "pooler",
    "okm-meta",
    "role-privilege",
    "role-owns-tables",
    "lock-timeout",
    "statement-timeout",
    "server-version",
    "extensions",
  ]);
  expect(report.summary).toEqual({ fail: 1, warn: 0, ok: 8 });
  expect(report.target).toBe("production");
  const text = formatReport(report);
  expect(text.startsWith("target `production`\n")).toBe(true);
  expect(text).toContain("fail  target-protection");
  expect(text).toContain("1 fail, 0 warn, 8 ok");
  for (const secret of ["zq_user", "zq_pass", "zq-host", "zq_db", "postgres://"]) {
    expect(text).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(secret);
  }
});

test("a configured role check adds role-config before the timeouts", () => {
  const report = buildReport(
    {
      target: { name: "p", protection: "project", url: "postgres://u:p@h/d" },
      config: plain,
      allowPooler: false,
    },
    { ...quiet, roleConfig: undefined },
  );
  const ids = report.findings.map((item) => item.id);
  expect(ids.indexOf("role-config")).toBe(ids.indexOf("role-owns-tables") + 1);
  expect(ids.indexOf("role-config")).toBeLessThan(ids.indexOf("lock-timeout"));
});

test("scrub removes the URL, host, user, and password from borrowed text", () => {
  const url = "postgres://zq_user:zq%40pass@zq-host.example:5432/zq_db";
  const text = "Role zq_user lacks CREATE on zq-host.example with zq@pass via " + url;
  const cleaned = scrub(text, url);
  for (const secret of ["zq_user", "zq@pass", "zq-host.example", "postgres://"]) {
    expect(cleaned).not.toContain(secret);
  }
  expect(cleaned).toContain("lacks CREATE");
  expect(scrub("Postgres owner", "postgres://postgres:x@h/d")).toBe("Postgres owner");
});

test("each new code has a registry entry", () => {
  for (const code of ["OKM2201", "OKM2202", "OKM2203", "OKM2204"]) {
    expect(errorDoc(code)?.fix.length).toBeGreaterThan(0);
  }
});
