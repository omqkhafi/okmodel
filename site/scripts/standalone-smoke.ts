/**
 * Production-like smoke run of a built site. Vercel deploys `site/` alone
 * (Root Directory) and never re-evaluates `next.config.ts` at runtime, so this
 * copies `site/` with its `.next` and `node_modules` outside the repository,
 * drops `next.config.ts`, and starts `next start` on the config the build
 * serialized. Request-time code that reads the repository answers 500 here.
 *
 * It also fails when the build reports a dynamic route that
 * `REQUEST_TIME_ENTRIES` does not list, so the import-graph test covers it.
 *
 *   bun run build && bun ./scripts/standalone-smoke.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REQUEST_TIME_ENTRIES, SITE_DIR } from "./request-time";

const READY_TIMEOUT_MS = 60_000;

/** One request and the status chain it must produce. */
type Probe = {
  readonly path: string;
  readonly markdown?: true;
  readonly expect: readonly number[];
};

const PROBES: readonly Probe[] = [
  { path: "/", expect: [200] },
  { path: "/robots.txt", expect: [200] },
  { path: "/sitemap.xml", expect: [200] },
  { path: "/docs", expect: [200] },
  { path: "/docs/schema/validation", expect: [200] },
  { path: "/docs/schema/validation", markdown: true, expect: [200] },
  { path: "/docs/nope", expect: [404] },
  { path: "/docs/nope", markdown: true, expect: [404] },
  { path: "/docs/define/table/validation", expect: [308, 200] },
  { path: "/docs/start/basic-usage", expect: [308, 200] },
  { path: "/docs/start/from-drizzle", expect: [308, 200] },
  { path: "/api/search?query=table", expect: [200] },
];

const problems = [...unlistedDynamicRoutes()];
const root = mkdtempSync(join(tmpdir(), "okm-site-standalone-"));
const site = join(root, "site");
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  copySiteAlone(site);
  const port = freePort();
  server = Bun.spawn([join(site, "node_modules/.bin/next"), "start", "-p", String(port)], {
    cwd: site,
    env: { ...process.env, __NEXT_PRIVATE_STANDALONE_CONFIG: builtConfig(site) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const origin = `http://127.0.0.1:${String(port)}`;
  await waitReady(origin);
  for (const probe of PROBES) {
    const chain = await statusChain(origin, probe);
    const label = `${probe.path}${probe.markdown ? " (Accept: text/markdown)" : ""}`;
    const ok = chain.join(" ") === probe.expect.join(" ");
    console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(48)} ${chain.join(" -> ")}`);
    if (!ok) problems.push(`${label}: expected ${probe.expect.join(" -> ")}, got ${chain.join(" -> ")}`);
  }
} finally {
  server?.kill();
  const log = server === undefined ? "" : await serverLog(server);
  rmSync(root, { recursive: true, force: true });
  if (problems.length > 0) {
    console.error(`\nstandalone-smoke: ${String(problems.length)} problem(s)`);
    for (const problem of problems) console.error(`- ${problem}`);
    if (log.length > 0) console.error(`\nnext start output:\n${log}`);
    process.exitCode = 1;
  } else {
    console.log("standalone-smoke: site answers from site/ alone");
  }
}

/** Dynamic app routes in the build that the import-graph test does not cover. */
function unlistedDynamicRoutes(): string[] {
  const next = join(SITE_DIR, ".next");
  if (!existsSync(join(next, "BUILD_ID"))) throw new Error("site/.next is missing. Run bun run build first.");
  const routes = JSON.parse(readFileSync(join(next, "app-path-routes-manifest.json"), "utf8")) as Record<
    string,
    string
  >;
  const prerender = JSON.parse(readFileSync(join(next, "prerender-manifest.json"), "utf8")) as {
    routes: Record<string, unknown>;
    dynamicRoutes: Record<string, unknown>;
  };
  const listed = new Set<string>(REQUEST_TIME_ENTRIES);
  const out: string[] = [];
  for (const [entry, route] of Object.entries(routes)) {
    if (route in prerender.routes || route in prerender.dynamicRoutes) continue;
    if (route === "/_global-error") continue;
    const file = [".ts", ".tsx"].map((ext) => `app${entry}${ext}`).find((f) => existsSync(join(SITE_DIR, f)));
    if (file !== undefined && listed.has(file)) continue;
    out.push(`${route} (${file ?? entry}) is dynamic; add it to REQUEST_TIME_ENTRIES in scripts/request-time.ts`);
  }
  return out;
}

/**
 * Copy `site/` with its build and dependencies to a directory outside the repository.
 *
 * @param target - Destination directory
 */
function copySiteAlone(target: string): void {
  const args = process.platform === "darwin" ? ["-Rc"] : ["-R"];
  const copy = Bun.spawnSync(["cp", ...args, SITE_DIR, target]);
  if (copy.exitCode !== 0) throw new Error(`cp failed: ${copy.stderr.toString()}`);
  rmSync(join(target, "next.config.ts"));
}

/**
 * The Next config the build serialized, as the standalone server reads it.
 *
 * @param target - Copied site directory
 */
function builtConfig(target: string): string {
  const files = JSON.parse(readFileSync(join(target, ".next/required-server-files.json"), "utf8")) as {
    config: unknown;
  };
  return JSON.stringify(files.config);
}

/** A TCP port nothing listens on right now. */
function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

/**
 * Poll until the server answers any HTTP response.
 *
 * @param origin - Server origin
 */
async function waitReady(origin: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${origin}/favicon.ico`, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`next start did not answer within ${String(READY_TIMEOUT_MS)} ms`);
}

/**
 * Status codes for one probe, following redirects by hand.
 *
 * @param origin - Server origin
 * @param probe - Request to make
 */
async function statusChain(origin: string, probe: Probe): Promise<number[]> {
  const headers = probe.markdown ? { Accept: "text/markdown" } : undefined;
  const chain: number[] = [];
  let url = new URL(probe.path, origin);
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    await response.arrayBuffer();
    chain.push(response.status);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) break;
    url = new URL(location, url);
  }
  return chain;
}

/**
 * Captured stdout and stderr of the server, last 60 lines.
 *
 * @param proc - Server process
 */
async function serverLog(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  const read = (stream: unknown) =>
    stream instanceof ReadableStream ? new Response(stream).text() : Promise.resolve("");
  const [out, err] = await Promise.all([read(proc.stdout), read(proc.stderr)]);
  return `${out}${err}`.trim().split("\n").slice(-60).join("\n");
}
