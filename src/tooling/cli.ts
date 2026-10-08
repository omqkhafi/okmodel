import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatFailure, run } from "./migrate/commands.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(here, "..", "..", "package.json");

if (process.argv.includes("--version")) {
  process.stdout.write(`${readPackageVersion(packageJsonPath)}\n`);
} else {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    const verbose = process.argv.includes("--verbose") || process.env.OKM_DEBUG === "1";
    process.stderr.write(formatFailure(error, verbose));
    process.exitCode = 1;
  }
}

function readPackageVersion(path: string): string {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    throw new Error(`No string version in ${path}`);
  }
  return parsed.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
