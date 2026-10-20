/**
 * Runs the describe spike and writes `results.json`.
 *
 *   bun packages/spikes/describe/run.ts
 *   DESCRIBE_ONLY=17 bun packages/spikes/describe/run.ts
 *
 * Starts Postgres 15–18 on 127.0.0.1:55415–55418 and PgBouncer 1.26.1 in
 * transaction mode on 56415–56418 when Docker is available. PGlite always
 * runs. Throwaway: nothing under `packages/spikes/` is packed.
 */

import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

import { probePglite, probeTcp, type ServerReport } from "./probe.ts";

const VERSIONS = [15, 16, 17, 18] as const;
const PGBOUNCER =
  "edoburu/pgbouncer:v1.26.1-p0@sha256:488422e38cff912895d0d65d8963fcd306e6ac589a724398b6eb8e294e94d624";

/**
 * Runs the matrix and writes the JSON result next to this file.
 */
async function main(): Promise<void> {
  const only = process.env.DESCRIBE_ONLY;
  const versions = VERSIONS.filter((version) => only === undefined || only === String(version));
  const servers: ServerReport[] = [];
  const notes: string[] = [];
  if (await dockerOk()) {
    await docker(["network", "create", "okm-describe"]).catch(() => undefined);
    for (const version of versions) {
      const url = `postgres://okm:okm@127.0.0.1:${String(55400 + version)}/okm`;
      try {
        await ensurePostgres(version);
        servers.push(await probeTcp(url, String(version), "direct", true));
        console.log(`direct ${String(version)} done`);
      } catch (error) {
        notes.push(`postgres ${String(version)} untested: ${messageOf(error)}`);
        console.error(notes[notes.length - 1]);
      }
      try {
        await ensureBouncer(version);
        const pooler = `postgres://okm:okm@127.0.0.1:${String(56400 + version)}/okm`;
        servers.push(await probeTcp(pooler, `${String(version)}-pgbouncer`, "pgbouncer", false));
        console.log(`pooler ${String(version)} done`);
      } catch (error) {
        notes.push(`pgbouncer ${String(version)} untested: ${messageOf(error)}`);
        console.error(notes[notes.length - 1]);
      }
    }
  } else {
    notes.push("docker is not available; TCP servers were not started");
  }
  try {
    servers.push(await probePglite());
    console.log("pglite done");
  } catch (error) {
    notes.push(`pglite untested: ${messageOf(error)}`);
    console.error(notes[notes.length - 1]);
  }
  const size = await measureClient();
  const result = {
    ranAt: new Date().toISOString(),
    bun: Bun.version,
    neonUrl: process.env.NEON_URL === undefined ? "unset" : "set",
    notes,
    size,
    servers,
  };
  const path = new URL("results.json", import.meta.url);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${path.pathname}`);
  console.log(JSON.stringify(size));
}

async function ensurePostgres(version: number): Promise<void> {
  const name = `okm-desc-pg${String(version)}`;
  const port = String(55400 + version);
  const exists = await docker(["inspect", "-f", "{{.State.Running}}", name]).catch(() => "");
  if (exists.trim() !== "true") {
    await docker(["rm", "-f", name]).catch(() => undefined);
    await docker([
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "okm-describe",
      "-e",
      "POSTGRES_USER=okm",
      "-e",
      "POSTGRES_PASSWORD=okm",
      "-e",
      "POSTGRES_DB=okm",
      "-p",
      `127.0.0.1:${port}:5432`,
      `postgres:${String(version)}`,
    ]);
  }
  await waitReady(name);
}

async function ensureBouncer(version: number): Promise<void> {
  const name = `okm-desc-bouncer${String(version)}`;
  const port = String(56400 + version);
  const exists = await docker(["inspect", "-f", "{{.State.Running}}", name]).catch(() => "");
  if (exists.trim() === "true") return;
  await docker(["rm", "-f", name]).catch(() => undefined);
  await docker([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "okm-describe",
    "-e",
    `DATABASE_URL=postgres://okm:okm@okm-desc-pg${String(version)}:5432/okm`,
    "-e",
    "POOL_MODE=transaction",
    "-e",
    "DEFAULT_POOL_SIZE=1",
    "-e",
    "RESERVE_POOL_SIZE=0",
    "-e",
    "AUTH_TYPE=scram-sha-256",
    "-p",
    `127.0.0.1:${port}:5432`,
    PGBOUNCER,
  ]);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = await docker([
      "exec",
      name,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-p",
      "5432",
      "-U",
      "okm",
      "-d",
      "okm",
    ]).catch(() => "");
    if (ready.includes("accepting")) return;
    await Bun.sleep(300);
  }
  const logs = await docker(["logs", name]).catch(() => "");
  throw new Error(`pgbouncer ${String(version)} did not open: ${logs.slice(-400)}`);
}

async function waitReady(name: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const ready = await docker(["exec", name, "pg_isready", "-U", "okm", "-d", "okm"]).catch(
      () => "",
    );
    if (ready.includes("accepting")) return;
    await Bun.sleep(300);
  }
  throw new Error(`${name} did not become ready`);
}

async function dockerOk(): Promise<boolean> {
  const proc = Bun.spawn(["docker", "version", "--format", "{{.Server.Version}}"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const code = await proc.exited;
  return code === 0;
}

async function docker(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(stderr.trim() || stdout.trim() || `docker ${args.join(" ")} failed`);
  return stdout;
}

async function measureClient(): Promise<{
  sourceBytes: number;
  sourceGzip: number;
  minifiedBytes: number;
  minifiedGzip: number;
}> {
  const file = new URL("protocol.ts", import.meta.url);
  const source = readFileSync(file);
  const built = await Bun.build({
    entrypoints: [file.pathname],
    target: "node",
    minify: true,
    external: ["node:net", "node:crypto"],
  });
  const output = built.outputs[0];
  if (output === undefined || !built.success) throw new Error("client bundle failed");
  const minified = Buffer.from(await output.arrayBuffer());
  return {
    sourceBytes: source.length,
    sourceGzip: gzipSync(source).length,
    minifiedBytes: minified.length,
    minifiedGzip: gzipSync(minified).length,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
