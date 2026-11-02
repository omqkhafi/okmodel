/**
 * Unknown /docs paths 404, and retired 0.10.0 handbook URLs permanently
 * redirect to pages that still exist.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DOCS_REDIRECTS } from "./docs-redirects";
import { markdownNegotiation, markdownTwinPath } from "./markdown-negotiate";
import { siteRoot } from "./repo";
import { docsPageExists, docsUrlResolves } from "./url-contract";

/** Retired URLs from the 0.10.2 QA evidence set (track 5). */
const BROKEN_BY_DAY = [
  "/docs/define/table/validation",
  "/docs/define/schema/tenancy",
  "/docs/define/table/queries",
  "/docs/define/table/presets",
  "/docs/define/table/traits",
  "/docs/start/basic-usage",
  "/docs/start/from-drizzle",
] as const;

test("every docs redirect is permanent (308) and its destination exists", () => {
  expect(DOCS_REDIRECTS.length).toBeGreaterThan(0);
  for (const entry of DOCS_REDIRECTS) {
    expect(entry.permanent).toBe(true);
    expect(docsPageExists(entry.destination), entry.destination).toBe(true);
    expect(docsUrlResolves(entry.destination), entry.destination).toBe(true);
  }
});

test("retired handbook URLs map to the tracked destinations before the define catch-all", () => {
  const bySource = new Map(DOCS_REDIRECTS.map((entry) => [entry.source, entry.destination]));
  expect(bySource.get("/docs/define/table/validation")).toBe("/docs/schema/validation");
  expect(bySource.get("/docs/define/schema/tenancy")).toBe("/docs/schema/tenancy");
  expect(bySource.get("/docs/define/table/queries")).toBe("/docs/queries/search-and-trees");
  expect(bySource.get("/docs/define/table/presets")).toBe("/docs/queries/presets");
  expect(bySource.get("/docs/define/table/traits")).toBe("/docs/schema/traits");
  expect(bySource.get("/docs/start/basic-usage")).toBe("/docs/start/first-schema");
  expect(bySource.get("/docs/start/from-drizzle")).toBe("/docs/migrations/from-drizzle");
  expect(bySource.get("/docs/define/:path*")).toBe("/docs");

  for (const path of BROKEN_BY_DAY) {
    expect(
      DOCS_REDIRECTS.some(
        (entry) =>
          entry.source === path ||
          (entry.source === "/docs/define/:path*" && path.startsWith("/docs/define/")),
      ),
      path,
    ).toBe(true);
  }

  const defineCatchAll = DOCS_REDIRECTS.findIndex((entry) => entry.source === "/docs/define/:path*");
  expect(defineCatchAll).toBe(DOCS_REDIRECTS.length - 1);
  const queriesIndex = DOCS_REDIRECTS.findIndex(
    (entry) => entry.source === "/docs/define/table/queries",
  );
  expect(queriesIndex).toBeGreaterThanOrEqual(0);
  expect(queriesIndex).toBeLessThan(defineCatchAll);
});

test("claim documentation lives on write-rows (fragment kept by the browser on search-and-trees)", () => {
  expect(docsUrlResolves("/docs/queries/write-rows#claim")).toBe(true);
  expect(docsUrlResolves("/docs/queries/search-and-trees#text-search")).toBe(true);
});

test("next.config mounts the docs redirect list", () => {
  const config = readFileSync(join(siteRoot(), "next.config.ts"), "utf8");
  expect(config).toContain("DOCS_REDIRECTS");
  expect(config).toContain("redirects");
});

test("docs and markdown twin routes reject unknown static params", () => {
  const docsPage = readFileSync(join(siteRoot(), "app/docs/[[...slug]]/page.tsx"), "utf8");
  expect(docsPage).toContain("dynamicParams = false");
  const docsMd = readFileSync(join(siteRoot(), "app/llms.mdx/docs/[[...slug]]/route.ts"), "utf8");
  expect(docsMd).toContain("dynamicParams = false");
});

test("an unknown docs path is a markdown 404, not a twin rewrite", () => {
  expect(markdownTwinPath("/docs/nope")).toBeUndefined();
  expect(docsPageExists("/docs/nope")).toBe(false);

  const request = new Request("https://okm.omqkhafi.dev/docs/nope", {
    headers: { accept: "text/markdown" },
  });
  expect(markdownNegotiation(request)).toEqual({ kind: "not-found" });
});

test("a known docs path still negotiates to its markdown twin", () => {
  expect(markdownTwinPath("/docs/start/first-schema")).toBe(
    "/llms.mdx/docs/start/first-schema.md",
  );
  const request = new Request("https://okm.omqkhafi.dev/docs/schema/validation", {
    headers: { accept: "text/markdown" },
  });
  expect(markdownNegotiation(request)).toEqual({
    kind: "rewrite",
    pathname: "/llms.mdx/docs/schema/validation.md",
  });
});

const httpBase = process.env.SITE_HTTP_BASE?.replace(/\/$/, "");

test("HTTP: unknown /docs is 404 and every retired URL is 308 then 200", async () => {
  if (httpBase === undefined) return;

  const missing = await fetch(`${httpBase}/docs/nope`, { redirect: "manual" });
  expect(missing.status).toBe(404);
  const markdown = await fetch(`${httpBase}/docs/nope`, {
    redirect: "manual",
    headers: { accept: "text/markdown" },
  });
  expect(markdown.status).toBe(404);
  expect(markdown.headers.get("content-type") ?? "").toContain("text/markdown");

  for (const entry of DOCS_REDIRECTS) {
    if (entry.source.includes(":")) {
      const sample = "/docs/define/other/retired-path";
      const redirect = await fetch(`${httpBase}${sample}`, { redirect: "manual" });
      expect(redirect.status, sample).toBe(308);
      expect(redirect.headers.get("location"), sample).toBe(entry.destination);
      continue;
    }
    const redirect = await fetch(`${httpBase}${entry.source}`, { redirect: "manual" });
    expect(redirect.status, entry.source).toBe(308);
    expect(redirect.headers.get("location"), entry.source).toBe(entry.destination);
    const target = await fetch(`${httpBase}${entry.destination}`, { redirect: "manual" });
    expect(target.status, entry.destination).toBe(200);
  }
});
