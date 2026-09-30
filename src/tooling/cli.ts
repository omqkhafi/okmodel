import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(here, "..", "..", "package.json");

if (process.argv.includes("--version")) {
  process.stdout.write(`${readPackageVersion(packageJsonPath)}\n`);
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
