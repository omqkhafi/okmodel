import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OkmError } from "../contracts/error.js";
import { formatFailure, run } from "./migrate/commands.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(here, "..", "..", "package.json");

if (process.argv.includes("--version")) {
  process.stdout.write(`${readPackageVersion(packageJsonPath)}\n`);
} else if (process.argv.length > 2) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof OkmError) {
      process.stderr.write(formatFailure(error));
      process.exitCode = 1;
    } else {
      throw error;
    }
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
