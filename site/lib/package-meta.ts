/**
 * Values the site shows that must come from the repository, not from a
 * hand-typed number or a rewritten claim.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./repo";
import {
  SITE_APPLICATION_CATEGORY,
  SITE_LICENSE_URL,
  SITE_NAME,
  SITE_ORIGIN,
} from "./site-identity";
import { githubRepoUrl, npmPackageUrl } from "./shared";

/** Fields this site reads from the root package manifest. */
export interface RootPackage {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
}

/**
 * Read the root `package.json`. Version, description, and license come from here.
 */
export function readRootPackage(): RootPackage {
  const raw = readFileSync(join(repoRoot(), "package.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isPackage(parsed)) {
    throw new Error("root package.json is missing name, version, description, or license");
  }
  return parsed;
}

/**
 * One-line positioning. The package description and the README's first
 * sentence are the same claim; the build stops when they drift.
 */
export function readTagline(): string {
  const description = readRootPackage().description;
  const sentence = readmePositioningSentence();
  if (sentence !== description) {
    throw new Error(
      `README positioning line (${sentence}) does not match package.json description (${description})`,
    );
  }
  return description;
}

/**
 * The `sh` fence under the README Install heading, unchanged.
 */
export function readmeInstallSnippet(): string {
  const section = extractReadmeH2(readReadme(), "Install");
  const fence = /```sh\n([\s\S]*?)```/.exec(section);
  const body = fence?.[1];
  if (body === undefined || body.trim().length === 0) {
    throw new Error("README Install section has no sh fence");
  }
  return body.trimEnd();
}

/**
 * Profiles that exist: the GitHub repository and the npm page for this package name.
 */
export function siteSameAs(): readonly string[] {
  return [githubRepoUrl, npmPackageUrl(readRootPackage().name)];
}

/**
 * SoftwareApplication JSON-LD. Description, license, and links come from the
 * repository identity, not from a second copy of the claim.
 */
export function softwareApplicationJsonLd(): {
  readonly "@context": "https://schema.org";
  readonly "@type": "SoftwareApplication";
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly applicationCategory: typeof SITE_APPLICATION_CATEGORY;
  readonly offers: { readonly "@type": "Offer"; readonly price: "0"; readonly priceCurrency: "USD" };
  readonly license: typeof SITE_LICENSE_URL;
  readonly sameAs: readonly string[];
} {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    description: readTagline(),
    url: SITE_ORIGIN,
    applicationCategory: SITE_APPLICATION_CATEGORY,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    license: SITE_LICENSE_URL,
    sameAs: siteSameAs(),
  };
}

function readReadme(): string {
  return readFileSync(join(repoRoot(), "README.md"), "utf8");
}

/**
 * First sentence of the README, after the title.
 */
export function readmePositioningSentence(): string {
  const raw = readReadme().replace(/\r\n/g, "\n");
  const start = raw.indexOf("\n");
  if (start < 0) throw new Error("README has no body");
  const rest = raw.slice(start + 1).trimStart();
  const paragraph = rest.split("\n\n")[0] ?? "";
  const sentence = paragraph.split(/(?<=\.)\s/)[0]?.trim() ?? "";
  if (sentence.length === 0) throw new Error("README has no positioning sentence");
  return sentence;
}

/**
 * Body of one README `##` section, without the heading line.
 *
 * @param raw - Full README
 * @param heading - Heading text, without the hashes
 */
export function extractReadmeH2(raw: string, heading: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line === `## ${heading}`);
  if (start < 0) throw new Error(`README is missing ## ${heading}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && line.startsWith("## ")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function isPackage(value: unknown): value is RootPackage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.version === "string" &&
    typeof record.description === "string" &&
    typeof record.license === "string"
  );
}
