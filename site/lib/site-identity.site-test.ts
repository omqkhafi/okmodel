/**
 * Identity values are read from one module or from the repository files.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  readRootPackage,
  readTagline,
  readmeInstallSnippet,
  readmePositioningSentence,
  siteSameAs,
  softwareApplicationJsonLd,
} from "./package-meta";
import { repoRoot } from "./repo";
import { SITE_LICENSE_URL, SITE_NAME, SITE_ORIGIN } from "./site-identity";
import { githubRepoUrl, npmPackageUrl } from "./shared";

test("the origin, name, and license live in site-identity", () => {
  const identity = readFileSync(join(repoRoot(), "site/lib/site-identity.ts"), "utf8");
  expect(identity).toContain("https://okmodel.omqkhafi.dev");
  expect(SITE_NAME).toBe("OKModel");
  expect(SITE_ORIGIN).toBe(process.env.SITE_ORIGIN?.replace(/\/$/, "") ?? "https://okmodel.omqkhafi.dev");
  expect(SITE_LICENSE_URL).toBe("https://www.apache.org/licenses/LICENSE-2.0");

  const sources = readFileSync(join(repoRoot(), "site/lib/site-identity.ts"), "utf8");
  const originHits = sources.split("https://okmodel.omqkhafi.dev").length - 1;
  expect(originHits).toBe(1);
});

test("the tagline is the README positioning line and the package description", () => {
  const pkg = readRootPackage();
  expect(readTagline()).toBe(pkg.description);
  expect(readmePositioningSentence()).toBe(pkg.description);
  expect(pkg.license).toBe("Apache-2.0");
  expect(pkg.description.startsWith("okmodel is a catalog-first TypeScript ORM")).toBe(true);
});

test("the install snippet is the README Install fence", () => {
  const snippet = readmeInstallSnippet();
  expect(snippet.split("\n")[0]).toBe("bun add okmodel postgres");
  expect(snippet).toContain("bun add okmodel postgres");
});

test("JSON-LD uses the same identity and only real profiles", () => {
  const data = softwareApplicationJsonLd();
  expect(data["@type"]).toBe("SoftwareApplication");
  expect(data.name).toBe(SITE_NAME);
  expect(data.url).toBe(SITE_ORIGIN);
  expect(data.description).toBe(readTagline());
  expect(data.license).toBe(SITE_LICENSE_URL);
  expect(data.offers).toEqual({ "@type": "Offer", price: "0", priceCurrency: "USD" });
  const pkg = readRootPackage();
  expect([...siteSameAs()]).toEqual([githubRepoUrl, npmPackageUrl(pkg.name)]);
  expect(data.sameAs.some((url) => url.includes("wikipedia.org"))).toBe(false);
  expect(data.sameAs.some((url) => url.includes("discord.gg"))).toBe(false);
});

test("the default origin is not repeated outside site-identity", () => {
  const files = [
    "site/app/layout.tsx",
    "site/app/(home)/page.tsx",
    "site/lib/package-meta.ts",
    "site/lib/shared.ts",
    "site/next.config.ts",
  ];
  for (const file of files) {
    const text = readFileSync(join(repoRoot(), file), "utf8");
    expect(text.includes("https://okmodel.omqkhafi.dev"), file).toBe(false);
    expect(text.includes('SITE_NAME = "'), file).toBe(false);
  }
});
