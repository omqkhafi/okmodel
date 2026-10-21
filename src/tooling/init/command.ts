/**
 * `okm init` command.
 *
 * It writes files and can install dependencies. It does not open a database
 * connection and it does not read `.env`. Prompts run only on a terminal,
 * and never with `--yes` or `--json`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { OkmError } from "../../contracts/error.js";
import { attachPartial } from "../cli/outcome.js";
import type { ParsedCli } from "../cli/parse.js";
import { packageRoot, readPackageVersion } from "../cli/version.js";
import { scanProject } from "./detect.js";
import {
  applyWrites,
  buildPlan,
  driverFlag,
  initAllowlist,
  prepareRoot,
  resolveDriver,
  shouldInstall,
  tenancyFlag,
  type InitData,
  type InitPlan,
} from "./engine.js";
import {
  initError,
  initUsage,
  isInitPackageManager,
  refuseMissingDecision,
  refusePlanHash,
  refuseUserModified,
  type InitPackageManager,
} from "./guards.js";
import type { PackageVersions } from "./package-json.js";
import { normalizeInitPath } from "./paths.js";

/** What `okm` dispatch returns for one command. */
export type InitProduced = {
  readonly text: string;
  readonly data: InitData;
  readonly warnings: readonly { readonly summary: string }[];
  readonly outFile: null;
};

/**
 * Runs `okm init`.
 *
 * @param parsed - Parsed flags. The operand is the project directory
 * @param cwd - Working directory
 * @param human - Receives the text when `--json` is off
 * @returns The plan document
 */
export async function initCommand(
  parsed: ParsedCli,
  cwd: string,
  human: (text: string) => void,
): Promise<InitProduced> {
  if (parsed.dialect !== undefined && parsed.dialect !== "postgres") {
    initUsage(`Unknown dialect ${parsed.dialect}.`, "Pass --dialect postgres.");
  }
  if (parsed.install && parsed.noInstall) {
    initUsage("Pass either --install or --no-install.", "Drop one of them.");
  }
  const pm = packageManagerFlag(parsed.pm);
  const dir = normalizeInitPath(parsed.dbDir ?? "db");
  const force = new Set(parsed.forceFile.map((file) => normalizeInitPath(file)));
  const allow = new Set(initAllowlist(dir));
  for (const file of force) {
    if (!allow.has(file))
      initUsage(`force-file does not name an init file: ${file}.`, "Name a file init writes.");
  }
  const project = parsed.operands[0];
  const root = prepareRoot(project === undefined ? cwd : resolve(cwd, project));
  const tty = process.stdin.isTTY === true;
  const scan = scanProject(root, pm);
  let requested = driverFlag(parsed.driver);
  if (
    requested === undefined &&
    scan.installedDrivers.length > 1 &&
    tty &&
    !parsed.yes &&
    !parsed.json
  ) {
    const answer = await prompt(`Driver (${scan.installedDrivers.join(", ")}): `);
    if (answer.length === 0) refuseMissingDecision(["--driver"]);
    requested = driverFlag(answer);
  }
  const driver = resolveDriver(scan, requested);
  let tenancyInput = parsed.tenancy;
  if (tenancyInput === undefined && tty && !parsed.yes && !parsed.json) {
    const answer = await prompt("Tenancy (none or column) [none]: ");
    tenancyInput = answer.length === 0 ? "none" : answer;
  }
  const tenancy = tenancyFlag(tenancyInput);
  let install = shouldInstall({
    json: parsed.json,
    yes: parsed.yes,
    install: parsed.install,
    noInstall: parsed.noInstall,
    tty,
  });
  if (tty && !parsed.json && !parsed.yes && !parsed.install && !parsed.noInstall) {
    const answer = await prompt("Install dependencies now? [Y/n] ");
    if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") install = false;
  }
  const plan = buildPlan({
    root,
    driver,
    tenancy,
    dir,
    pm: pm ?? scan.pm,
    yes: parsed.yes,
    force,
    install,
    versions: packageVersions(),
    dryRun: parsed.dryRun,
  });
  human(plan.human);
  if (plan.blocked.length > 0) {
    try {
      refuseUserModified(plan.blocked);
    } catch (error) {
      rethrow(error, plan);
    }
  }
  if (!parsed.dryRun && parsed.planHash !== undefined && parsed.planHash !== plan.data.planHash) {
    try {
      refusePlanHash(parsed.planHash, plan.data.planHash);
    } catch (error) {
      rethrow(error, plan);
    }
  }
  if (!parsed.dryRun) applyWrites(root, dir, plan.writes);
  if (!parsed.dryRun && install) {
    try {
      runInstall(root, pm ?? scan.pm);
    } catch (error) {
      rethrow(error, plan);
    }
  }
  const acted = !parsed.dryRun && (plan.writes.length > 0 || install);
  const data = acted ? { ...plan.data, status: "applied" as const } : plan.data;
  return { text: plan.human, data, warnings: plan.warnings, outFile: null };
}

function packageManagerFlag(value: string | undefined): InitPackageManager | undefined {
  if (value === undefined) return undefined;
  if (!isInitPackageManager(value)) {
    initUsage(`Unknown package manager ${value}.`, "Pass --pm bun, npm, pnpm, or yarn.");
  }
  return value;
}

function packageVersions(): PackageVersions {
  const text = readFileSync(join(packageRoot(), "package.json"), "utf8");
  const parsed: unknown = JSON.parse(text);
  const peers: Record<string, string> = {};
  if (isRecord(parsed) && isRecord(parsed.peerDependencies)) {
    for (const [key, value] of Object.entries(parsed.peerDependencies)) {
      if (typeof value === "string") peers[key] = value;
    }
  }
  return { okmodel: readPackageVersion(), peers };
}

function runInstall(root: string, pm: InitPackageManager): void {
  const result = spawnSync(pm, ["install"], { cwd: root, stdio: "inherit" });
  if (result.error !== undefined || result.status !== 0) {
    initError(
      "invalid",
      "Dependency install failed.",
      "Install dependencies, then pass --no-install.",
      "failed",
    );
  }
}

function rethrow(error: unknown, plan: InitPlan): never {
  if (error instanceof OkmError) {
    throw attachPartial(error, { data: plan.data, warnings: plan.warnings, outFile: null });
  }
  throw error;
}

async function prompt(label: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const prompts = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await prompts.question(label)).trim();
  } finally {
    prompts.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
