/**
 * Bounded kill-storm recovery for postgres.js and node-postgres (B-02, B-43, B-44).
 *
 * Six workers loop for 3 s on an app role (max: 4) while a killer terminates
 * that role's backends every 20 ms. After the storm every call has settled, a
 * post-storm count succeeds, and the process stays up.
 */

import { expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "postgres";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { open as openPostgresJs } from "../src/adapters/pg/postgresjs.js";
import { connect as connectPostgresJs } from "../src/runtime/pg/postgresjs.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const PASSWORD = "stormappsecret";

const items = table("items", {
  id: id(),
  name: text(),
});
const app = schema({
  casing: "snake",
  tables: [items],
});

async function withAppRole<T>(
  run: (admin: Sql, schemaName: string, role: string, appUrl: string) => Promise<T>,
): Promise<T> {
  return withPostgresSchema(async (admin, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await admin.unsafe(statement);
    }
    const role = `s_${schemaName}`;
    try {
      await admin.unsafe(
        `create role ${role} login password '${PASSWORD}' nosuperuser nobypassrls`,
      );
      await admin.unsafe(`grant connect on database okm to ${role}`);
      await admin.unsafe(`grant usage on schema ${schemaName} to ${role}`);
      await admin.unsafe(
        `grant select, insert, update, delete on all tables in schema ${schemaName} to ${role}`,
      );
      for (let i = 0; i < 8; i += 1) {
        await admin.unsafe(
          `insert into ${schemaName}.items (id, name) values (gen_random_uuid(), 'n${String(i)}')`,
        );
      }
      const url = new URL(primaryUrl());
      url.username = role;
      url.password = PASSWORD;
      return await run(admin, schemaName, role, url.toString());
    } finally {
      await admin.unsafe(`drop owned by ${role} cascade`).catch(() => undefined);
      await admin.unsafe(`drop role if exists ${role}`);
    }
  });
}

function timed<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${String(ms)}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function node24(): string | undefined {
  try {
    const proc = Bun.spawnSync(["node", "--version"], { stdout: "pipe" });
    const version = proc.stdout.toString().trim();
    if (proc.exitCode !== 0) return undefined;
    const major = Number(version.replace(/^v/, "").split(".")[0] ?? "0");
    return major >= 20 ? "node" : undefined;
  } catch {
    return undefined;
  }
}

type StormReport = {
  readonly pending: number;
  readonly recoveryMs: number;
  readonly recovered: boolean;
  readonly crashes: string[];
};

async function spawnStorm(
  driver: "postgresjs" | "pg",
  appUrl: string,
  schemaName: string,
  role: string,
  callTimeout?: number,
  runtime: "bun" | "node" = "bun",
): Promise<StormReport> {
  const adminUrl = primaryUrl();
  const args = [
    "tests/driver-storm.worker.ts",
    driver,
    appUrl,
    adminUrl,
    schemaName,
    role,
    ...(callTimeout !== undefined ? [String(callTimeout)] : []),
  ];
  if (runtime === "bun") {
    const proc = Bun.spawn(["bun", ...args], {
      cwd: repoRoot(),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, stderr).toBe(0);
    const line = stdout.trim().split("\n").at(-1) ?? "";
    return JSON.parse(line) as StormReport;
  }
  const node = node24();
  if (node === undefined) throw new Error("node missing");
  const dir = mkdtempSync(join(tmpdir(), "okm-storm-"));
  const outfile = join(dir, "storm.mjs");
  const built = Bun.spawnSync(
    ["bun", "build", "tests/driver-storm.worker.ts", "--target", "node", "--outfile", outfile],
    { cwd: repoRoot() },
  );
  expect(built.exitCode).toBe(0);
  const nodeChild = Bun.spawnSync([node, outfile, ...args.slice(1)], {
    cwd: repoRoot(),
    timeout: 120_000,
    env: process.env,
  });
  expect(nodeChild.exitCode, nodeChild.stderr?.toString() ?? "").toBe(0);
  const line = (nodeChild.stdout?.toString() ?? "").trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as StormReport;
}

for (const driver of ["postgresjs", "pg"] as const) {
  postgresTest(
    gate,
    `${driver}: kill storm settles and recovers within 3 s (B-02, B-43)`,
    async () => {
      await withAppRole(async (_admin, schemaName, role, appUrl) => {
        const report = await spawnStorm(driver, appUrl, schemaName, role);
        expect(report.pending).toBe(0);
        expect(report.recovered).toBe(true);
        expect(report.recoveryMs).toBeLessThanOrEqual(3_000);
        expect(report.crashes).toEqual([]);
        console.info(
          `${driver} bun storm pending=${String(report.pending)} recoveryMs=${String(report.recoveryMs)}`,
        );
        if (node24() !== undefined) {
          const nodeReport = await spawnStorm(driver, appUrl, schemaName, role, undefined, "node");
          expect(nodeReport.pending).toBe(0);
          expect(nodeReport.recovered).toBe(true);
          expect(nodeReport.recoveryMs).toBeLessThanOrEqual(3_000);
          expect(nodeReport.crashes).toEqual([]);
          console.info(
            `${driver} node storm pending=${String(nodeReport.pending)} recoveryMs=${String(nodeReport.recoveryMs)}`,
          );
        }
      });
    },
    180_000,
  );

  postgresTest(
    gate,
    `${driver}: kill storm with per-call timeout: 2000 settles`,
    async () => {
      await withAppRole(async (_admin, schemaName, role, appUrl) => {
        const report = await spawnStorm(driver, appUrl, schemaName, role, 2000);
        expect(report.pending).toBe(0);
        expect(report.recovered).toBe(true);
        expect(report.recoveryMs).toBeLessThanOrEqual(3_000);
        expect(report.crashes).toEqual([]);
      });
    },
    180_000,
  );
}

postgresTest(
  gate,
  "postgres.js reserve rejects within timeouts.acquire when no connection answers",
  async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {},
        data() {},
        close() {},
      },
    });
    try {
      const url = `postgres://okm:okm@127.0.0.1:${String(server.port)}/okm`;
      const pool = openPostgresJs({
        url,
        max: 1,
        timeouts: { acquire: 200 },
      });
      const started = Date.now();
      const error = await pool.reserve?.().then(
        () => undefined,
        (value: unknown) => value,
      );
      const elapsed = Date.now() - started;
      expect(error).toBeInstanceOf(OkmError);
      if (error instanceof OkmError) expect(error.code).toBe("OKM1846");
      expect(elapsed).toBeLessThan(2_000);
      await pool.close().catch(() => undefined);
    } finally {
      server.stop(true);
    }
  },
  20_000,
);

postgresTest(
  gate,
  "a call queued on an ending connection settles under a concurrent kill",
  async () => {
    await withAppRole(async (admin, schemaName, role, appUrl) => {
      const pool = openPostgresJs({ url: appUrl, searchPath: schemaName, max: 2 });
      const db = connectPostgresJs(pool, { schema: app });
      try {
        await db.connected;
        const slow = timed(
          db.tx(async (tx) => {
            await tx.items.count();
            await Bun.sleep(300);
            return tx.items.count();
          }),
          10_000,
        );
        await Bun.sleep(50);
        await admin.unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity where usename = '${role}'`,
        );
        const result = await slow.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        expect(result.ok || result.error instanceof OkmError).toBe(true);
      } finally {
        await db.close().catch(() => undefined);
        await pool.close().catch(() => undefined);
      }
    });
  },
  30_000,
);

postgresTest(
  gate,
  "node-postgres idle backend kill does not crash the process (B-44)",
  async () => {
    const databaseUrl = primaryUrl();
    const proc = Bun.spawn(["bun", "tests/pg-idle-kill.worker.ts", databaseUrl], {
      cwd: repoRoot(),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("idle-ok");
    expect(stdout).toContain("crashes 0");

    const node = node24();
    if (node !== undefined) {
      const dir = mkdtempSync(join(tmpdir(), "okm-idle-kill-"));
      const outfile = join(dir, "idle-kill.mjs");
      const built = Bun.spawnSync(
        ["bun", "build", "tests/pg-idle-kill.worker.ts", "--target", "node", "--outfile", outfile],
        { cwd: repoRoot() },
      );
      expect(built.exitCode).toBe(0);
      const nodeChild = Bun.spawnSync([node, outfile, databaseUrl], { timeout: 30_000 });
      expect(nodeChild.exitCode, nodeChild.stderr?.toString() ?? "").toBe(0);
      expect(nodeChild.stdout?.toString() ?? "").toContain("idle-ok");
      expect(nodeChild.stdout?.toString() ?? "").toContain("crashes 0");
    }
  },
  60_000,
);
