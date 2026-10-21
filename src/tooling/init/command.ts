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
import { applyAgents } from "../agents/apply.js";
import { consented } from "../agents/command.js";
import type { AgentsPlan } from "../agents/plan.js";
import { attachPartial } from "../cli/outcome.js";
import type { ParsedCli } from "../cli/parse.js";
import { packageRoot, readPackageVersion } from "../cli/version.js";
import { ask } from "../prompt.js";
import { catalogHasOkmodel, findWorkspaceRoot, type WorkspacePackage } from "../workspaces.js";
import { mergeAgents, planInitAgents } from "./agents.js";
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
  refuseSharedMigrations,
  refuseUserModified,
  refuseWorkspaceChoice,
  type InitDriver,
  type InitPackageManager,
} from "./guards.js";
import {
  buildRepoPlan,
  chooseInit,
  parseWorkspaceAnswer,
  workspacePrompt,
  type InitSelection,
} from "./monorepo.js";
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
  const project = parsed.operands[0];
  const start = project === undefined ? cwd : resolve(cwd, project);
  const tty = process.stdin.isTTY === true;
  let choice = chooseInit({
    start,
    workspace: parsed.workspace,
    allWorkspaces: parsed.allWorkspaces,
    shared: parsed.shared,
    interactive: tty && !parsed.yes && !parsed.json,
  });
  if (choice.kind === "prompt") {
    const answer = await ask(workspacePrompt(choice.candidates));
    const parsedAnswer = parseWorkspaceAnswer(answer, choice.candidates);
    if (!parsedAnswer.ok) {
      if (parsedAnswer.reason === "empty") {
        refuseWorkspaceChoice(choice.candidates.map(workspaceLabel));
      }
      initUsage(parsedAnswer.reason, "Pass a name, a path, or a number from the list.");
    }
    choice = chooseInit({
      start,
      workspace: parsedAnswer.rels,
      allWorkspaces: false,
      shared: false,
      interactive: false,
    });
  }
  if (choice.kind === "prompt") {
    initUsage("okm init needs a workspace.", "Pass --workspace <name>.");
  }
  if (choice.kind === "single")
    return singlePackage(parsed, choice.root, dir, pm, force, tty, human);
  return repoPackage(parsed, choice, dir, pm, force, tty, human);
}

/**
 * Writes one package. A workspace catalog that already names `okmodel`
 * uses `catalog:`. The package manager is the workspace root's when this
 * package has no lockfile of its own.
 */
async function singlePackage(
  parsed: ParsedCli,
  start: string,
  dir: string,
  pm: InitPackageManager | undefined,
  force: ReadonlySet<string>,
  tty: boolean,
  human: (text: string) => void,
): Promise<InitProduced> {
  const allow = new Set(initAllowlist(dir));
  for (const file of force) {
    if (!allow.has(file))
      initUsage(`force-file does not name an init file: ${file}.`, "Name a file init writes.");
  }
  const root = prepareRoot(start);
  const repo = findWorkspaceRoot(root);
  const usedPm = pm ?? scanProject(repo ?? root, pm).pm;
  const scan = scanProject(root, usedPm);
  const okmodelSpec = repo !== undefined && catalogHasOkmodel(repo) ? "catalog:" : undefined;
  const requested = await askDriver(parsed, scan.installedDrivers, tty);
  const { tenancy, install } = await askTenancyAndInstall(parsed, tty);
  const agents = await planInitAgents({
    parsed,
    root,
    tenancy,
    version: readPackageVersion(),
    tty,
  });
  const plan = mergeAgents(
    buildPlan({
      root,
      driver: resolveDriver(scan, requested),
      tenancy,
      dir,
      pm: usedPm,
      yes: parsed.yes,
      force,
      install,
      versions: packageVersions(),
      dryRun: parsed.dryRun,
      ...(okmodelSpec === undefined ? {} : { okmodelSpec }),
    }),
    agents,
  );
  present(parsed, plan, human);
  const writeAgents = await agentsApproved(parsed, plan, agents, human);
  if (!parsed.dryRun) {
    try {
      applyWrites(root, dir, plan.writes);
      if (writeAgents && agents !== undefined) applyAgents(agents);
      if (install) runInstall(root, usedPm);
    } catch (error) {
      rethrow(error, plan);
    }
  }
  return produced(parsed, plan, plan.writes.length > 0 || install || writeAgents, writeAgents);
}

/**
 * Writes the selected workspace packages, then shared files at the repo root.
 */
async function repoPackage(
  parsed: ParsedCli,
  choice: Extract<InitSelection, { readonly kind: "repo" }>,
  dir: string,
  pm: InitPackageManager | undefined,
  force: ReadonlySet<string>,
  tty: boolean,
  human: (text: string) => void,
): Promise<InitProduced> {
  const selected = choice.choice.selected;
  const allow = repoAllowlist(dir, selected);
  for (const file of force) {
    if (!allow.has(file))
      initUsage(`force-file does not name an init file: ${file}.`, "Name a file init writes.");
  }
  const root = prepareRoot(choice.repo);
  const usedPm = pm ?? scanProject(root, pm).pm;
  let requested = driverFlag(parsed.driver);
  if (requested === undefined && tty && !parsed.yes && !parsed.json) {
    for (const pkg of selected) {
      const installed = scanProject(pkg.dir, usedPm).installedDrivers;
      if (installed.length <= 1) continue;
      const answer = await ask(`Driver (${installed.join(", ")}): `);
      if (answer.length === 0) refuseMissingDecision(["--driver"]);
      requested = driverFlag(answer);
      break;
    }
  }
  const { tenancy, install } = await askTenancyAndInstall(parsed, tty);
  const agents = await planInitAgents({
    parsed,
    root,
    tenancy,
    version: readPackageVersion(),
    tty,
  });
  const plan = mergeAgents(
    buildRepoPlan({
      repo: root,
      choice: choice.choice,
      driver: requested,
      tenancy,
      dir,
      pm: usedPm,
      yes: parsed.yes,
      force,
      install,
      versions: packageVersions(),
      dryRun: parsed.dryRun,
    }),
    agents,
  );
  present(parsed, plan, human);
  const writeAgents = await agentsApproved(parsed, plan, agents, human);
  if (!parsed.dryRun) {
    try {
      for (const item of plan.packageWrites) applyWrites(item.dir, item.dirName, item.writes);
      if (plan.repoWrites.length > 0) {
        applyWrites(root, dir, plan.repoWrites, new Set(plan.repoWrites.map((file) => file.path)));
      }
      if (writeAgents && agents !== undefined) applyAgents(agents);
      if (install) runInstall(root, usedPm);
    } catch (error) {
      rethrow(error, plan);
    }
  }
  const wrote =
    plan.packageWrites.some((item) => item.writes.length > 0) || plan.repoWrites.length > 0;
  return produced(parsed, plan, wrote || install || writeAgents, writeAgents);
}

/**
 * Whether the agent files in this plan are written.
 *
 * A plan that changes an existing file needs `--yes` or a typed yes. A
 * refusal throws before any file is written. A typed no skips only the
 * agent files.
 */
async function agentsApproved(
  parsed: ParsedCli,
  plan: InitPlan,
  agents: AgentsPlan | undefined,
  human: (text: string) => void,
): Promise<boolean> {
  if (agents === undefined || agents.writes.length === 0 || parsed.dryRun) return false;
  try {
    if (await consented(parsed, agents)) return true;
  } catch (error) {
    rethrow(error, plan);
  }
  human("agent files not written\n");
  return false;
}

async function askDriver(
  parsed: ParsedCli,
  installed: readonly InitDriver[],
  tty: boolean,
): Promise<InitDriver | undefined> {
  let requested = driverFlag(parsed.driver);
  if (requested === undefined && installed.length > 1 && tty && !parsed.yes && !parsed.json) {
    const answer = await ask(`Driver (${installed.join(", ")}): `);
    if (answer.length === 0) refuseMissingDecision(["--driver"]);
    requested = driverFlag(answer);
  }
  return requested;
}

async function askTenancyAndInstall(
  parsed: ParsedCli,
  tty: boolean,
): Promise<{ readonly tenancy: ReturnType<typeof tenancyFlag>; readonly install: boolean }> {
  let tenancyInput = parsed.tenancy;
  if (tenancyInput === undefined && tty && !parsed.yes && !parsed.json) {
    const answer = await ask("Tenancy (none or column) [none]: ");
    tenancyInput = answer.length === 0 ? "none" : answer;
  }
  let install = shouldInstall({
    json: parsed.json,
    yes: parsed.yes,
    install: parsed.install,
    noInstall: parsed.noInstall,
    tty,
  });
  if (tty && !parsed.json && !parsed.yes && !parsed.install && !parsed.noInstall) {
    const answer = await ask("Install dependencies now? [Y/n] ");
    if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") install = false;
  }
  return { tenancy: tenancyFlag(tenancyInput), install };
}

function present(parsed: ParsedCli, plan: InitPlan, human: (text: string) => void): void {
  human(plan.human);
  if (plan.collision !== undefined) {
    try {
      refuseSharedMigrations(plan.collision.packages, plan.collision.directory);
    } catch (error) {
      rethrow(error, plan);
    }
  }
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
}

function produced(
  parsed: ParsedCli,
  plan: InitPlan,
  wrote: boolean,
  agentsWrote: boolean,
): InitProduced {
  const acted = !parsed.dryRun && wrote;
  const agents = plan.data.agents;
  const data = acted
    ? {
        ...plan.data,
        status: "applied" as const,
        ...(agents !== undefined && agentsWrote
          ? { agents: { ...agents, status: "applied" as const } }
          : {}),
      }
    : plan.data;
  return { text: plan.human, data, warnings: plan.warnings, outFile: null };
}

function repoAllowlist(dir: string, selected: readonly WorkspacePackage[]): Set<string> {
  const allow = new Set<string>(["okmodel.base.ts", "package.json"]);
  for (const pkg of selected) {
    for (const file of initAllowlist(dir)) {
      allow.add(pkg.rel.length === 0 ? file : `${pkg.rel}/${file}`);
    }
  }
  return allow;
}

function workspaceLabel(pkg: WorkspacePackage): string {
  return pkg.name === undefined ? pkg.rel : `${pkg.name} (${pkg.rel})`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
