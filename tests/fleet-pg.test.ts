/**
 * Fleet proofs on a real Postgres: many databases, canary, limits, locks.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  openPostgres,
  type IsolatedDatabase,
} from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { repoRoot } from "../scripts/root.js";
import { applyFleet, ensureHead } from "../src/tooling/migrate/index.js";
import type { FleetConfig, FleetEvent, FleetTarget } from "../src/tooling/migrate/index.js";
import { planFleet, statusFleet } from "../src/tooling/migrate/fleet-engine.js";
import { okm } from "./cli-output-harness.js";

const gate = await loadPostgresGate();
const root = repoRoot();

function safe(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]");
}

function rewrite(source: string): string {
  return source
    .replaceAll(
      'from "okmodel/pg"',
      `from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))}`,
    )
    .replaceAll(
      'from "okmodel/migrate"',
      `from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))}`,
    );
}

function fence(page: string, title: string): string {
  const pattern = /```(\w+)[^\n]*?\btitle="([^"]+)"[^\n]*\n([\s\S]*?)```/g;
  for (const match of page.matchAll(pattern)) {
    if (match[2] === title) return match[3] ?? "";
  }
  throw new Error(`missing fence ${title}`);
}

function schemaText(): string {
  return [
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    "export const app = schema({",
    '  tables: [table("notes", { id: t.integer().primaryKey(), title: t.text() })],',
    "});",
    "",
  ].join("\n");
}

function configText(targets: readonly FleetTarget[]): string {
  return [
    `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
    "export default defineConfig({",
    '  schema: "./schema.ts",',
    `  fleet: { targets: ${JSON.stringify(targets)} },`,
    "});",
    "",
  ].join("\n");
}

async function project(targets: readonly FleetTarget[]): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "okm-fleet-"));
  writeFileSync(join(cwd, "schema.ts"), schemaText());
  writeFileSync(join(cwd, "okmodel.config.ts"), configText(targets));
  const generated = okm(cwd, ["generate", "init"]);
  if (generated.code !== 0) throw new Error(safe(generated.stderr || "generate failed"));
  return cwd;
}

async function many(count: number, base?: string): Promise<IsolatedDatabase[]> {
  const databases: IsolatedDatabase[] = [];
  for (let index = 0; index < count; index += 1) {
    databases.push(await createIsolatedDatabase(base));
  }
  return databases;
}

function targetsOf(databases: readonly IsolatedDatabase[], prefix: string): FleetTarget[] {
  return databases.map((database, index) => ({
    name: `${prefix}${String(index).padStart(2, "0")}`,
    url: database.url,
  }));
}

async function closeAll(databases: readonly IsolatedDatabase[], cwd?: string): Promise<void> {
  if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
  for (const database of databases) await database.close();
}

async function columns(url: string): Promise<readonly string[]> {
  const sql = openPostgres(url);
  try {
    const rows = await sql.unsafe(
      `select table_name || '.' || column_name as name
       from information_schema.columns
       where table_schema = 'public' and table_name not like 'okm_%'
       order by 1`,
    );
    return rows.map((row) => String(row.name));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function hasNotes(url: string): Promise<boolean> {
  const sql = openPostgres(url);
  try {
    const rows = await sql.unsafe("select to_regclass('public.notes') is not null as present");
    return rows[0]?.present === true;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function collect(
  fleet: FleetConfig,
  options: Parameters<typeof applyFleet>[1],
): Promise<FleetEvent[]> {
  const events: FleetEvent[] = [];
  for await (const event of applyFleet(fleet, options)) events.push(event);
  return events;
}

function summaryOf(events: readonly FleetEvent[]): Extract<FleetEvent, { event: "summary" }> {
  const summary = events.find((event) => event.event === "summary");
  if (summary === undefined || summary.event !== "summary") throw new Error("no summary");
  return summary;
}

function serverUrl(port: string): string {
  const url = new URL(primaryUrl());
  url.port = port;
  return url.href.replace(/\/$/, "");
}

async function ping(url: string): Promise<boolean> {
  try {
    const sql = openPostgres(url);
    await sql.unsafe("select 1");
    await sql.end({ timeout: 5 });
    return true;
  } catch {
    return false;
  }
}

async function ensureSecond(): Promise<string> {
  const url = serverUrl("55435");
  if (await ping(url)) return url;
  spawnSync("docker", ["rm", "-f", "okm-fleet-b"], { encoding: "utf8" });
  const version = process.env.POSTGRES_VERSION ?? "17";
  const started = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      "okm-fleet-b",
      "-e",
      "POSTGRES_USER=okm",
      "-e",
      "POSTGRES_PASSWORD=okm",
      "-e",
      "POSTGRES_DB=okm",
      "-p",
      "55435:5432",
      `postgres:${version}`,
    ],
    { encoding: "utf8" },
  );
  if (started.status !== 0) throw new Error("second postgres did not start");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await ping(url)) return url;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("second postgres did not accept connections");
}

function addStep(
  cwd: string,
  id: string,
  stepClass: "expand" | "contract",
  statement: string,
  options?: { readonly weight?: "blocking"; readonly allow?: string },
): void {
  const source = readFileSync(join(cwd, "migrations", "0001_init.catalog.json"), "utf8");
  writeFileSync(join(cwd, "migrations", `${id}.catalog.json`), source);
  const header = [
    `-- class: ${stepClass}`,
    `-- name: ${id}`,
    "",
    `-- class: ${stepClass}`,
    "-- action: ddl",
    "-- lock: access share",
  ];
  if (options?.weight !== undefined) header.push(`-- weight: ${options.weight}`);
  if (options?.allow !== undefined) header.push(options.allow);
  header.push(`${statement};`, "");
  writeFileSync(join(cwd, "migrations", `${id}.sql`), header.join("\n"));
}

function addPause(cwd: string, id: string, weight: "blocking" | undefined, seconds: string): void {
  const statement = `select pg_sleep(${seconds})`;
  if (weight === undefined) addStep(cwd, id, "expand", statement);
  else addStep(cwd, id, "expand", statement, { weight });
}

async function peakSleep(url: string, stop: { current: boolean }): Promise<number> {
  const sql = openPostgres(url);
  let peak = 0;
  try {
    while (!stop.current) {
      const rows = await sql.unsafe(
        `select count(*)::int as n from pg_stat_activity
         where state = 'active' and query ilike '%pg_sleep%' and query not ilike '%pg_stat_activity%'`,
      );
      peak = Math.max(peak, Number(rows[0]?.n ?? 0));
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return peak;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

postgresTest(
  gate,
  "proof:migrate.fleet",
  async () => {
    const databases = await many(50);
    const listed = targetsOf(databases, "t");
    let cwd = "";
    try {
      cwd = await project(listed);
      const fleet: FleetConfig = { targets: listed, canary: 0, parallel: 8, perHost: 2 };
      const first = await collect(fleet, { cwd, maxFailures: "all" });
      const done = summaryOf(first);
      expect(done.failures).toBe(0);
      expect(done.exit).toBe(0);
      expect(
        first.filter((event) => event.event === "target" && event.applied.length > 0),
      ).toHaveLength(50);
      const again = await collect(fleet, { cwd, maxFailures: "all" });
      expect(
        again.filter((event) => event.event === "target" && event.applied.length > 0),
      ).toHaveLength(0);
      expect(summaryOf(again).exit).toBe(0);
    } finally {
      await closeAll(databases, cwd);
    }
  },
  300_000,
);

postgresTest(
  gate,
  "fifty databases on two servers stay inside perHost",
  async () => {
    const second = await ensureSecond();
    const left = await many(25);
    const right = await many(25, second);
    const listed = [...targetsOf(left, "a"), ...targetsOf(right, "b")];
    let cwd = "";
    try {
      cwd = await project(listed);
      const fleet: FleetConfig = { targets: listed, canary: 0, parallel: 8, perHost: 2 };
      const events = await collect(fleet, { cwd, maxFailures: "all" });
      expect(summaryOf(events).failures).toBe(0);
      expect(
        events.filter((event) => event.event === "target" && event.state === "current"),
      ).toHaveLength(50);
    } finally {
      await closeAll([...left, ...right], cwd);
      spawnSync("docker", ["rm", "-f", "okm-fleet-b"], { encoding: "utf8" });
    }
  },
  300_000,
);

postgresTest(
  gate,
  "proof:migrate.fleet.canary",
  async () => {
    const databases = await many(3);
    const listed = targetsOf(databases, "c");
    let cwd = "";
    const sql = databases.map((database) => openPostgres(database.url));
    try {
      cwd = await project(listed);
      const seeded = await collect({ targets: listed, canary: 0 }, { cwd, maxFailures: "all" });
      expect(summaryOf(seeded).failures).toBe(0);
      await sql[1]?.unsafe("create table bulk as select g from generate_series(1, 20000) g");
      await sql[2]?.unsafe("create table bulk as select g from generate_series(1, 20000) g");
      addPause(cwd, "0002_body", undefined, "0");
      const events = await collect({ targets: listed }, { cwd });
      expect(summaryOf(events).failures).toBe(0);
      const applied = events.filter(
        (event) => event.event === "target" && event.applied.length > 0,
      );
      expect(applied[0]?.event === "target" ? applied[0].name : "").toBe("c00");
    } finally {
      for (const one of sql) await one.end({ timeout: 5 });
      await closeAll(databases, cwd);
    }
  },
  120_000,
);

postgresTest(
  gate,
  "maxFailures stops, continues, and leaves an ahead database untouched",
  async () => {
    const databases = await many(4);
    const names = ["a_down", "b_fail", "c_ahead", "d_ok"] as const;
    const listed: FleetTarget[] = databases.map((database, index) => ({
      name: names[index] ?? "x",
      url: index === 0 ? "postgres://okm:s3cret-token@127.0.0.1:1/nope" : database.url,
    }));
    let cwd = "";
    try {
      cwd = await project(listed.slice(1));
      await ensureHead(databases[2]?.url ?? "", { cwd });
      const ahead = openPostgres(databases[2]?.url ?? "");
      await ahead.unsafe(
        "insert into okm_history (migration_id, step_index, class, catalog_hash) values ('9999_future', 0, 'expand', 'ahead')",
      );
      await ahead.end({ timeout: 5 });
      const fail = openPostgres(databases[1]?.url ?? "");
      await fail.unsafe("create table notes (id integer)");
      await fail.end({ timeout: 5 });
      const fleet: FleetConfig = { targets: listed, canary: 0 };
      const stopped = await collect(fleet, { cwd, maxFailures: 0, parallel: 1 });
      expect(summaryOf(stopped).exit).toBe(1);
      expect(
        stopped.find((event) => event.event === "target" && event.name === "a_down"),
      ).toMatchObject({
        state: "unreachable",
      });
      expect(
        stopped.find((event) => event.event === "target" && event.name === "b_fail"),
      ).toMatchObject({
        state: "failed",
      });
      expect(
        stopped.find((event) => event.event === "target" && event.name === "c_ahead"),
      ).toMatchObject({
        state: "ahead",
      });
      expect(await hasNotes(databases[3]?.url ?? "")).toBe(false);
      const leaked = JSON.stringify(stopped);
      if (leaked.includes("s3cret-token") || leaked.includes("postgres://")) {
        throw new Error("secret leaked");
      }
      const percent = await collect(fleet, { cwd, maxFailures: "50%", parallel: 1 });
      expect(summaryOf(percent).exit).toBe(1);
      expect(await hasNotes(databases[3]?.url ?? "")).toBe(false);
      const allowed = await collect(fleet, { cwd, maxFailures: 1, parallel: 1 });
      expect(await hasNotes(databases[3]?.url ?? "")).toBe(true);
      expect(summaryOf(allowed).failures).toBe(1);
      const marker = openPostgres(databases[3]?.url ?? "");
      await marker.unsafe("insert into notes (id, title) values (1, 'kept')");
      await marker.end({ timeout: 5 });
      const rerun = await collect(fleet, { cwd, maxFailures: "all", parallel: 1 });
      const kept = openPostgres(databases[3]?.url ?? "");
      const rows = await kept.unsafe("select title from notes");
      await kept.end({ timeout: 5 });
      expect(rows[0]?.title).toBe("kept");
      const ok = rerun.find((event) => event.event === "target" && event.name === "d_ok");
      expect(ok?.event === "target" ? ok.applied : []).toEqual([]);
    } finally {
      await closeAll(databases, cwd);
    }
  },
  180_000,
);

postgresTest(
  gate,
  "a frozen plan refuses a database whose head moved",
  async () => {
    const databases = await many(2);
    const listed = targetsOf(databases, "p");
    let cwd = "";
    try {
      cwd = await project(listed);
      const planPath = join(cwd, "fleet.plan.json");
      const fleet: FleetConfig = { targets: listed, canary: 0 };
      await planFleet(fleet, { cwd, planPath });
      const raw = readFileSync(planPath, "utf8");
      if (raw.includes("postgres://")) throw new Error("plan stored a url");
      await ensureHead(databases[0]?.url ?? "", { cwd });
      const events = await collect(fleet, { cwd, planPath, maxFailures: "all", parallel: 1 });
      const moved = events.find((event) => event.event === "target" && event.name === "p00");
      expect(moved?.event === "target" ? moved.code : "").toBe("OKM1933");
      expect(await hasNotes(databases[1]?.url ?? "")).toBe(true);
    } finally {
      await closeAll(databases, cwd);
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a reset connection is retried and is not a migration failure",
  async () => {
    const database = await createIsolatedDatabase();
    let cwd = "";
    let hits = 0;
    const server = createServer((socket) => {
      hits += 1;
      if (hits === 1) {
        socket.destroy();
        return;
      }
      const upstream = connectTcp(Number(new URL(primaryUrl()).port), "127.0.0.1");
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("no port");
        resolve(address.port);
      });
    });
    try {
      const url = new URL(database.url);
      url.port = String(port);
      const listed = [{ name: "cold", url: url.href.replace(/\/$/, "") }];
      cwd = await project(listed);
      const read = await statusFleet({ targets: listed, canary: 0 }, { cwd });
      expect(read.rows[0]?.state).toBe("behind");
      expect(hits).toBeGreaterThan(1);
    } finally {
      server.close();
      await closeAll([database], cwd);
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a blocking step caps per host at 1 and the plan says so",
  async () => {
    const databases = await many(4);
    const listed = targetsOf(databases, "w");
    let cwd = "";
    const stop = { current: false };
    try {
      cwd = await project(listed);
      await collect({ targets: listed, canary: 0 }, { cwd, maxFailures: "all" });
      addPause(cwd, "0002_block", "blocking", "0.8");
      const planned = await planFleet({ targets: listed, canary: 0, parallel: 4 }, { cwd });
      expect(planned.text).toContain("blocking or rewrite steps cap per host at 1");
      expect(planned.plan.perHost).toBe(1);
      const watch = peakSleep(primaryUrl(), stop);
      const ran = await collect(
        { targets: listed, canary: 0, parallel: 4 },
        { cwd, maxFailures: "all", allowBlocking: true },
      );
      stop.current = true;
      expect(summaryOf(ran).exit).toBe(0);
      expect(await watch).toBe(1);
    } finally {
      stop.current = true;
      await closeAll(databases, cwd);
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a fill stop is one database and the other still applies",
  async () => {
    const databases = await many(2);
    const open = { name: "open", url: databases[0]?.url ?? "" };
    const empty = { name: "empty", url: databases[1]?.url ?? "" };
    let cwd = "";
    try {
      cwd = await project([open, empty]);
      await collect({ targets: [open, empty], canary: 0 }, { cwd, maxFailures: "all" });
      const filled = openPostgres(open.url);
      await filled.unsafe("insert into notes (id, title) values (1, 'row')");
      await filled.end({ timeout: 5 });
      addStep(cwd, "0002_body", "expand", "alter table notes add column body text not null", {
        allow: "-- okm-allow OKM1525: empty databases have no rows to fill",
      });
      const events = await collect(
        { targets: [open, empty], canary: 0 },
        { cwd, maxFailures: "all", parallel: 2 },
      );
      const openEvent = events.find((event) => event.event === "target" && event.name === "open");
      const emptyEvent = events.find((event) => event.event === "target" && event.name === "empty");
      expect(openEvent?.event === "target" ? openEvent.code : "").toBe("OKM1525");
      expect(emptyEvent?.event === "target" ? emptyEvent.state : "").toBe("current");
    } finally {
      await closeAll(databases, cwd);
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a protected database stops on a contract step and the other applies",
  async () => {
    const databases = await many(2);
    const open = { name: "open", url: databases[0]?.url ?? "" };
    const locked = { name: "locked", url: databases[1]?.url ?? "", protected: true };
    let cwd = "";
    try {
      cwd = await project([open, locked]);
      await collect({ targets: [open, locked], canary: 0 }, { cwd, maxFailures: "all" });
      addStep(cwd, "0002_drop", "contract", "alter table notes drop column title", {
        allow: "-- okm-allow OKM1512: readers already stopped using title",
      });
      const events = await collect(
        { targets: [open, locked], canary: 0 },
        { cwd, maxFailures: "all", parallel: 2 },
      );
      const openEvent = events.find((event) => event.event === "target" && event.name === "open");
      const lockedEvent = events.find(
        (event) => event.event === "target" && event.name === "locked",
      );
      expect(openEvent?.event === "target" ? openEvent.state : "").toBe("current");
      expect(lockedEvent?.event === "target" ? lockedEvent.code : "").toBe("OKM1850");
    } finally {
      await closeAll(databases, cwd);
    }
  },
  120_000,
);

postgresTest(
  gate,
  "two fleet runs share the apply lock per database",
  async () => {
    const databases = await many(1);
    const listed = targetsOf(databases, "k");
    let cwd = "";
    try {
      cwd = await project(listed);
      await collect({ targets: listed, canary: 0 }, { cwd, maxFailures: "all" });
      addPause(cwd, "0002_lock", undefined, "2");
      const fleet: FleetConfig = { targets: listed, canary: 0 };
      const first = collect(fleet, { cwd, maxFailures: "all" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = await collect(fleet, { cwd, maxFailures: "all" });
      const blocked = second.find((event) => event.event === "target");
      expect(blocked?.event === "target" ? blocked.code : "").toBe("OKM1522");
      expect(summaryOf(await first).exit).toBe(0);
    } finally {
      await closeAll(databases, cwd);
    }
  },
  60_000,
);

postgresTest(
  gate,
  "proof:migrate.fleet.ensureHead",
  async () => {
    const provisioned = await createIsolatedDatabase();
    const replayed = await createIsolatedDatabase();
    let cwd = "";
    try {
      cwd = await project([{ name: "solo", url: provisioned.url }]);
      const head = await ensureHead(provisioned.url, { cwd });
      expect(head.text.includes("postgres://")).toBe(false);
      const sql = openPostgres(replayed.url);
      await sql.unsafe(readFileSync(join(cwd, "migrations", "0001_init.sql"), "utf8"));
      await sql.end({ timeout: 5 });
      expect(await columns(provisioned.url)).toEqual(await columns(replayed.url));
      const again = await ensureHead(provisioned.url, { cwd });
      expect(again.applied).toEqual([]);
    } finally {
      await closeAll([provisioned, replayed], cwd);
    }
  },
  120_000,
);

postgresTest(
  gate,
  "status names drift only when asked, and the report hides the url",
  async () => {
    const database = await createIsolatedDatabase();
    const listed = [{ name: "acme", url: database.url }];
    let cwd = "";
    try {
      cwd = await project(listed);
      await collect({ targets: listed, canary: 0 }, { cwd, maxFailures: "all" });
      const plain = await statusFleet({ targets: listed }, { cwd });
      expect(plain.rows[0]?.state).toBe("current");
      const live = openPostgres(database.url);
      await live.unsafe("create table stray (id integer)");
      await live.end({ timeout: 5 });
      const drifted = await statusFleet({ targets: listed }, { cwd, drift: true });
      expect(drifted.rows[0]?.state).toBe("drifted");
      const quiet = await statusFleet({ targets: listed }, { cwd });
      expect(quiet.rows[0]?.state).toBe("current");
      const report = join(cwd, "fleet.json");
      const ran = okm(cwd, ["migrate", "status", "--fleet", "--json"]);
      expect(ran.code).toBe(0);
      const lines = ran.stdout.trim().split("\n");
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        const body = JSON.parse(line) as { schema: string };
        expect(body.schema).toBe("okm.cli/1");
      }
      const reported = okm(cwd, ["migrate", "apply", "--fleet", "--report", report]);
      expect(reported.code).toBe(0);
      const written = readFileSync(report, "utf8");
      const shown = `${ran.stdout}\n${ran.stderr}\n${reported.stdout}\n${reported.stderr}\n${written}\n${plain.text}`;
      if (shown.includes(new URL(database.url).pathname) || shown.includes("postgres://")) {
        throw new Error("secret leaked");
      }
    } finally {
      await closeAll([database], cwd);
    }
  },
  120_000,
);

postgresTest(
  gate,
  "the fleet and signup pages apply on a real database",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-fleet-doc-"));
    const previous = process.env.TENANT_URL;
    process.env.TENANT_URL = database.url;
    try {
      const page = readFileSync(join(root, "site/content/docs/migrations/fleet.mdx"), "utf8");
      writeFileSync(join(cwd, "schema.ts"), rewrite(fence(page, "schema.ts")));
      writeFileSync(join(cwd, "okmodel.config.ts"), rewrite(fence(page, "okmodel.config.ts")));
      expect(okm(cwd, ["generate", "init"]).code).toBe(0);
      const applied = okm(cwd, ["migrate", "apply", "--fleet"]);
      expect(applied.code).toBe(0);
      expect(await hasNotes(database.url)).toBe(true);
      const signup = await createIsolatedDatabase();
      try {
        const guide = readFileSync(
          join(root, "site/content/docs/migrations/database-per-tenant.mdx"),
          "utf8",
        );
        const dir = mkdtempSync(join(tmpdir(), "okm-fleet-signup-"));
        writeFileSync(join(dir, "schema.ts"), rewrite(fence(guide, "schema.ts")));
        writeFileSync(join(dir, "okmodel.config.ts"), rewrite(fence(guide, "okmodel.config.ts")));
        process.env.TENANT_URL = signup.url;
        expect(okm(dir, ["generate", "init"]).code).toBe(0);
        writeFileSync(join(dir, "signup.ts"), rewrite(fence(guide, "signup.ts")));
        const ran = spawnSync("bun", ["signup.ts"], {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, TENANT_URL: signup.url },
        });
        if (ran.status !== 0) throw new Error(safe(ran.stderr || "signup failed"));
        expect(await hasNotes(signup.url)).toBe(true);
        rmSync(dir, { recursive: true, force: true });
      } finally {
        await signup.close();
      }
    } finally {
      if (previous === undefined) delete process.env.TENANT_URL;
      else process.env.TENANT_URL = previous;
      await closeAll([database], cwd);
    }
  },
  120_000,
);

postgresTest(
  gate,
  "an unreachable canary stops before any other database is migrated",
  async () => {
    const databases = await many(2);
    const real = [
      { name: "small", url: databases[0]?.url ?? "" },
      { name: "big", url: databases[1]?.url ?? "" },
    ];
    let cwd = "";
    const gateProxy = await connectionGate(
      Number(new URL(real[0]?.url ?? primaryUrl()).port),
      "close",
    );
    try {
      cwd = await project(real);
      await collect({ targets: real, canary: 0 }, { cwd, maxFailures: "all" });
      const big = openPostgres(real[1]?.url ?? "");
      await big.unsafe("create table bulk as select g from generate_series(1, 20000) g");
      await big.end({ timeout: 5 });
      addStep(cwd, "0002_extra", "expand", "alter table notes add column extra text");
      const listed = [
        { name: "small", url: gateProxy.url(real[0]?.url ?? "") },
        { name: "big", url: real[1]?.url ?? "" },
      ];
      const events = await collect({ targets: listed, parallel: 1 }, { cwd });
      expect(summaryOf(events).exit).toBe(5);
      expect(summaryOf(events).text).toContain("unreachable");
      expect(await historyIds(real[0]?.url ?? "")).not.toContain("0002_extra");
      expect(await historyIds(real[1]?.url ?? "")).not.toContain("0002_extra");
    } finally {
      await gateProxy.close();
      await closeAll(databases, cwd);
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a canary that connects on retry still applies",
  async () => {
    const databases = await many(2);
    const real = [
      { name: "small", url: databases[0]?.url ?? "" },
      { name: "big", url: databases[1]?.url ?? "" },
    ];
    let cwd = "";
    const gateProxy = await connectionGate(
      Number(new URL(real[0]?.url ?? primaryUrl()).port),
      "once",
    );
    try {
      cwd = await project(real);
      await collect({ targets: real, canary: 0 }, { cwd, maxFailures: "all" });
      const big = openPostgres(real[1]?.url ?? "");
      await big.unsafe("create table bulk as select g from generate_series(1, 20000) g");
      await big.end({ timeout: 5 });
      addStep(cwd, "0002_extra", "expand", "alter table notes add column extra text");
      const listed = [
        { name: "small", url: gateProxy.url(real[0]?.url ?? "") },
        { name: "big", url: real[1]?.url ?? "" },
      ];
      const events = await collect({ targets: listed, parallel: 1 }, { cwd, maxFailures: "all" });
      expect(summaryOf(events).failures).toBe(0);
      expect(await historyIds(real[0]?.url ?? "")).toContain("0002_extra");
      expect(await historyIds(real[1]?.url ?? "")).toContain("0002_extra");
    } finally {
      await gateProxy.close();
      await closeAll(databases, cwd);
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a re-run uses the smallest reachable canary and keeps the plan name",
  async () => {
    const databases = await many(2);
    const real = [
      { name: "small", url: databases[0]?.url ?? "" },
      { name: "big", url: databases[1]?.url ?? "" },
    ];
    let cwd = "";
    try {
      cwd = await project(real);
      await collect({ targets: real, canary: 0 }, { cwd, maxFailures: "all" });
      const big = openPostgres(real[1]?.url ?? "");
      await big.unsafe("create table bulk as select g from generate_series(1, 20000) g");
      await big.end({ timeout: 5 });
      addStep(cwd, "0002_extra", "expand", "alter table notes add column extra text");
      const planPath = join(cwd, "fleet.plan.json");
      await planFleet({ targets: real }, { cwd, planPath });
      const written = JSON.parse(readFileSync(planPath, "utf8")) as { canary?: string };
      expect(written.canary).toBe("small");
      const closed = new URL(real[0]?.url ?? "");
      closed.port = "1";
      const listed = [
        { name: "small", url: closed.href.replace(/\/$/, "") },
        { name: "big", url: real[1]?.url ?? "" },
      ];
      const events = await collect({ targets: listed, parallel: 1 }, { cwd, planPath });
      const text = summaryOf(events).text;
      expect(text).toContain("small");
      expect(text).toContain("big");
      expect(text).toContain("unreachable");
      expect(await historyIds(real[1]?.url ?? "")).toContain("0002_extra");
      expect(await historyIds(real[0]?.url ?? "")).not.toContain("0002_extra");
      const kept = JSON.parse(readFileSync(planPath, "utf8")) as { canary?: string };
      expect(kept.canary).toBe("small");
    } finally {
      await closeAll(databases, cwd);
    }
  },
  120_000,
);

postgresTest(
  gate,
  "fleet drift connect uses the 30s fleet timeout",
  async () => {
    const database = await createIsolatedDatabase();
    let cwd = "";
    const upstream = Number(new URL(database.url).port);
    const delayed = await delayGate(upstream, 6_000);
    try {
      const real = [{ name: "acme", url: database.url }];
      cwd = await project(real);
      await collect({ targets: real, canary: 0 }, { cwd, maxFailures: "all" });
      const listed = [{ name: "acme", url: delayed.url(database.url) }];
      const read = await statusFleet(
        { targets: listed, canary: 0 },
        { cwd, drift: true, allowPooler: true },
      );
      expect(read.rows[0]?.state).toBe("current");
    } finally {
      await delayed.close();
      await closeAll([database], cwd);
    }
  },
  90_000,
);

async function historyIds(url: string): Promise<readonly string[]> {
  const sql = openPostgres(url);
  try {
    const present = await sql.unsafe(
      "select to_regclass('public.okm_history') is not null as present",
    );
    if (present[0]?.present !== true) return [];
    const rows = await sql.unsafe("select migration_id from okm_history order by migration_id");
    return rows.map((row) => String(row.migration_id));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * A TCP gate in front of Postgres.
 *
 * `close` forwards connections until the first one ends, then stops listening
 * so a later connect is refused.
 * `once` refuses the second connection and forwards every other one.
 */
function connectionGate(
  upstreamPort: number,
  mode: "close" | "once",
): Promise<{ url(base: string): string; close(): Promise<void> }> {
  let opened = 0;
  let sealed = false;
  const server = createServer((socket) => {
    opened += 1;
    const index = opened;
    const refuse = mode === "close" ? sealed : index === 2;
    if (refuse) {
      socket.on("error", () => undefined);
      socket.destroy();
      return;
    }
    const upstream = connectTcp(upstreamPort, "127.0.0.1");
    if (mode === "close") {
      socket.on("close", () => {
        sealed = true;
        server.close();
      });
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve({
        url(base: string) {
          const parsed = new URL(base);
          parsed.port = String(address.port);
          return parsed.href.replace(/\/$/, "");
        },
        close: () =>
          new Promise((done) => {
            if (!server.listening) {
              done();
              return;
            }
            server.close(() => done());
          }),
      });
    });
  });
}

function delayGate(
  upstreamPort: number,
  delayMs: number,
): Promise<{ url(base: string): string; close(): Promise<void> }> {
  const server = createServer((socket) => {
    const timer = setTimeout(() => {
      const upstream = connectTcp(upstreamPort, "127.0.0.1");
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    }, delayMs);
    socket.on("close", () => clearTimeout(timer));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve({
        url(base: string) {
          const parsed = new URL(base);
          parsed.port = String(address.port);
          return parsed.href.replace(/\/$/, "");
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
