/**
 * Snaplink example: a link shortener on Hono, Cloudflare Workers, and Neon.
 *
 * Always: the Worker bundles under Cloudflare's free-plan size limit with
 * `nodejs_compat`, `wrangler types` output typechecks the source and the
 * script under strict `tsc`, and an unknown `NEON_MODE` answers 500. With the
 * Postgres topology: `okm migrate apply` runs the committed migration, then the
 * bundled Worker runs in Miniflare against the repository's local Neon
 * endpoint in `websocket` and `http` mode, covering create, redirect, the
 * click written after the response, and delete (a transaction in `websocket`,
 * a batch in `http`).
 */

import { expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { convertV4MiniflareOptions, Miniflare } from "miniflare";

import { createIsolatedDatabase, openPostgres } from "../../packages/harness/src/postgres.js";
import { startNeonLocal } from "../../packages/harness/src/neon-local.js";
import { repoRoot } from "../../scripts/root.js";
import { gate, linkOkmodel, postgresTest, primaryUrl } from "../shared/support.js";

const exampleDir = join(import.meta.dir);

/** Cloudflare Workers free plan script size limit (compressed), as documented. */
const CF_FREE_GZIP_LIMIT = 3 * 1024 * 1024;

const config = Bun.JSONC.parse(readFileSync(join(exampleDir, "wrangler.jsonc"), "utf8")) as {
  compatibility_date: string;
  compatibility_flags: string[];
};

type Mode = "websocket" | "http";
type Link = { id: string; slug: string; url: string; createdAt: string };
type LinkStats = Link & { clicks: number; recent: string[] };

async function run(cmd: string[], env?: Record<string, string>): Promise<string> {
  const child = spawn({
    cmd,
    cwd: exampleDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const code = await child.exited;
  const log = `${await new Response(child.stdout).text()}\n${await new Response(child.stderr).text()}`;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed:\n${log}`);
  return log;
}

const bundles = new Map<string, Promise<{ script: string; gzipKiB: number }>>();

/** Bundles an entry with `wrangler deploy --dry-run`, once per entry. */
function bundle(entry = "src/index.ts"): Promise<{ script: string; gzipKiB: number }> {
  let pending = bundles.get(entry);
  if (pending === undefined) {
    pending = (async () => {
      linkOkmodel(exampleDir);
      const outDir = join(exampleDir, ".wrangler-bundle", entry.replaceAll("/", "_"));
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      const log = await run([
        "bunx",
        "wrangler",
        "deploy",
        entry,
        "--dry-run",
        `--outdir=${outDir}`,
      ]);
      const match = log.match(/Total Upload:\s*([\d.]+)\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/);
      if (match === null) throw new Error(`wrangler size line missing:\n${log}`);
      const name = entry.split("/").at(-1)!.replace(/\.ts$/, ".js");
      return { script: readFileSync(join(outDir, name), "utf8"), gzipKiB: Number(match[2]) };
    })();
    bundles.set(entry, pending);
  }
  return pending;
}

function worker(script: string, bindings: Record<string, string>): Miniflare {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      bindings,
    }),
  );
}

/**
 * Sends a request to the Worker's own URL.
 *
 * Not `dispatchFetch`: under Bun it ignores Miniflare 5's dispatcher and
 * dials `localhost` itself.
 */
async function call(mf: Miniflare, path: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(path, await mf.ready), init);
}

function postLink(mf: Miniflare, body: unknown): Promise<Response> {
  return call(mf, "/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Creates, redirects, counts, and deletes one link through the Worker in one mode. */
async function exercise(mf: Miniflare, mode: Mode): Promise<void> {
  const health = await call(mf, "/health");
  expect(await health.json()).toEqual({ ok: true, mode });

  const slug = `snap-${mode}`;
  const target = "https://example.dev/a-long-path?with=query";
  const created = await postLink(mf, { url: target, slug });
  if (created.status !== 201) {
    throw new Error(`POST /links answered ${created.status}: ${await created.text()}`);
  }
  const link = (await created.json()) as Link;
  expect(link.slug).toBe(slug);
  expect(link.url).toBe(target);
  expect(link.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

  const taken = await postLink(mf, { url: target, slug });
  expect(taken.status).toBe(409);
  expect(await taken.json()).toEqual({ error: "slug taken" });

  const invalid = await postLink(mf, { url: "ftp://example.dev/file" });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: "url must be an http(s) URL" });

  const generated = await postLink(mf, { url: target });
  expect(generated.status).toBe(201);
  expect(((await generated.json()) as Link).slug).toMatch(/^[a-z0-9-]{8}$/);

  // The click is written after the response: the middleware closes only after it settles.
  const redirect = await call(mf, `/r/${slug}`, { redirect: "manual" });
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("location")).toBe(target);

  const deadline = Date.now() + 10_000;
  let stats: LinkStats | undefined;
  while (stats === undefined || (stats.clicks < 1 && Date.now() < deadline)) {
    const response = await call(mf, `/links/${slug}`);
    expect(response.status).toBe(200);
    stats = (await response.json()) as LinkStats;
    if (stats.clicks < 1) await Bun.sleep(100);
  }
  expect(stats.clicks).toBe(1);
  expect(stats.recent).toHaveLength(1);

  const missingRedirect = await call(mf, "/r/nope-nope", { redirect: "manual" });
  expect(missingRedirect.status).toBe(404);

  const deleted = await call(mf, `/links/${slug}`, { method: "DELETE" });
  expect(deleted.status).toBe(204);
  expect((await call(mf, `/links/${slug}`)).status).toBe(404);
  expect((await call(mf, `/links/${slug}`, { method: "DELETE" })).status).toBe(404);

  const other = await call(mf, "/nope");
  expect(other.status).toBe(404);
  expect(await other.text()).toBe("not found");
}

test("snaplink bundle stays under the Cloudflare size limit", async () => {
  const { script, gzipKiB } = await bundle();
  expect(gzipKiB * 1024).toBeLessThan(CF_FREE_GZIP_LIMIT);
  expect(script.length).toBeGreaterThan(10_000);
  expect(config.compatibility_flags).toContain("nodejs_compat");
}, 60_000);

test("snaplink source and script typecheck under strict tsc against wrangler types", async () => {
  linkOkmodel(exampleDir);
  await run(["bunx", "wrangler", "types", "--env-interface", "CloudflareBindings"]);
  await run([join(repoRoot(), "node_modules/.bin/tsc"), "-p", "tsconfig.json"]);
}, 120_000);

test("snaplink rejects an unknown NEON_MODE before opening a client", async () => {
  const { script } = await bundle();
  const bindings = { DATABASE_URL: "postgres://unused.invalid/db" };
  const bad = worker(script, { ...bindings, NEON_MODE: "ws" });
  const good = worker(script, { ...bindings, NEON_MODE: "http" });
  try {
    // Hono's default error handler hides the message; the Worker logs it.
    expect((await call(bad, "/health")).status).toBe(500);
    // Same bindings, valid mode: /health answers without a database.
    const response = await call(good, "/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, mode: "http" });
  } finally {
    await bad.dispose();
    await good.dispose();
  }
}, 60_000);

postgresTest(
  gate,
  "snaplink applies its migration and serves links through a local Neon endpoint in websocket and http modes",
  async () => {
    const isolated = await createIsolatedDatabase(primaryUrl());
    const local = startNeonLocal(isolated.url);
    try {
      linkOkmodel(exampleDir);
      await run([join(repoRoot(), "dist/okm.js"), "migrate", "apply"], {
        DATABASE_URL: isolated.url,
      });
      const { script } = await bundle("test/neon-local-entry.ts");
      for (const mode of ["websocket", "http"] as const) {
        const mf = worker(script, {
          DATABASE_URL: local.url,
          NEON_MODE: mode,
          NEON_LOCAL: local.host,
        });
        try {
          await exercise(mf, mode);
        } finally {
          await mf.dispose();
        }
      }
      const sql = openPostgres(isolated.url);
      try {
        const rows = await sql.unsafe<{ n: string }[]>(
          "select (select count(*) from links)::text as n",
        );
        // Only the generated-slug links remain; both named links were deleted.
        expect(rows[0]?.n).toBe("2");
        const clicks = await sql.unsafe<{ n: string }[]>(
          "select count(*)::text as n from clicks",
        );
        expect(clicks[0]?.n).toBe("0");
      } finally {
        await sql.end({ timeout: 5 });
      }
    } finally {
      await local.close();
      await isolated.close();
    }
  },
  180_000,
);
