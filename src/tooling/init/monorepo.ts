/**
 * Monorepo choices for `okm init`.
 *
 * Layout C is one shared database package. Layout B is one config per
 * selected package. `okmodel.base.ts` is written once when two or more
 * packages are initialised, or when a package inherits an ancestor config.
 * The root `package.json` gains scripts only, and only when a task runner
 * is already in use.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { canonicalHash } from "../canonical-json.js";
import { CONFIG_FILE } from "../migrate/paths.js";
import {
  catalogHasOkmodel,
  detectTaskRunner,
  findWorkspaceRoot,
  forwardScript,
  isWithin,
  listWorkspaces,
  packageContaining,
  posixRelative,
  type TaskRunner,
  type WorkspacePackage,
} from "../workspaces.js";
import { DRIVER_PACKAGE_NAMES, scanProject } from "./detect.js";
import {
  buildPlan,
  contentHash,
  lf,
  resolveDriver,
  type InitPlan,
  type InitWrite,
} from "./engine.js";
import {
  initUsage,
  refuseUnsupported,
  refuseWorkspaceChoice,
  type InitDriver,
  type InitPackageManager,
  type InitSupportedTenancy,
} from "./guards.js";
import { patchRootScripts, type PackageVersions } from "./package-json.js";
import { INIT_SCRIPTS, baseText, configText, nextSteps } from "./text.js";

/** What `okm init` will initialise. */
export type InitSelection =
  | { readonly kind: "single"; readonly root: string }
  | {
      readonly kind: "prompt";
      readonly repo: string;
      readonly candidates: readonly WorkspacePackage[];
    }
  | { readonly kind: "repo"; readonly repo: string; readonly choice: RepoChoice };

/** Packages and layout for one monorepo init. */
export type RepoChoice = {
  readonly layout: "per-service" | "shared";
  readonly selected: readonly WorkspacePackage[];
  readonly writeBase: boolean;
  readonly note?: string;
  readonly runner: TaskRunner | undefined;
  readonly catalog: boolean;
};

/** A parsed multi-select answer. */
export type WorkspaceAnswer =
  | { readonly ok: true; readonly rels: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** One package apply should write, with paths relative to that package. */
export type PackageWrites = {
  readonly dir: string;
  readonly dirName: string;
  readonly writes: readonly InitWrite[];
};

/** A monorepo plan plus the writes apply performs. */
export type RepoPlan = InitPlan & {
  readonly packageWrites: readonly PackageWrites[];
  readonly repoWrites: readonly InitWrite[];
};

/**
 * Chooses the package or packages `okm init` will write.
 *
 * From inside a workspace, with no workspace flag, only that workspace is
 * selected. From the root, the detected layout is the proposal. Several
 * candidates and no flag ask on a terminal and fail otherwise.
 *
 * @param input - Working directory and flags
 * @returns The selection. `prompt` means the terminal still has to answer
 */
export function chooseInit(input: {
  readonly start: string;
  readonly workspace: readonly string[];
  readonly allWorkspaces: boolean;
  readonly shared: boolean;
  readonly interactive: boolean;
}): InitSelection {
  refuseFlagMix(input);
  if (!existsSync(input.start)) return { kind: "single", root: input.start };
  const repo = findWorkspaceRoot(input.start);
  const packages = repo === undefined ? [] : listWorkspaces(repo);
  const flagged = input.shared || input.allWorkspaces || input.workspace.length > 0;
  if (repo === undefined || packages.length === 0) {
    if (flagged) {
      initUsage(
        "This directory has no workspace packages.",
        "Drop the workspace flags, or run okm init in a workspace.",
      );
    }
    return { kind: "single", root: input.start };
  }
  const inside = packageContaining(packages, input.start);
  const atRoot = resolve(input.start) === resolve(repo);
  if (!flagged && inside !== undefined && !atRoot) {
    if (!ancestorInside(inside.dir, repo)) return { kind: "single", root: inside.dir };
    return {
      kind: "repo",
      repo,
      choice: choiceFor(repo, packages, [inside], "per-service", true),
    };
  }
  const proposal = proposeLayout(packages);
  if (input.allWorkspaces) {
    return {
      kind: "repo",
      repo,
      choice: choiceFor(repo, packages, packages, "per-service", false),
    };
  }
  if (input.shared) {
    const pool = proposal.layout === "shared" ? proposal.candidates : [];
    if (input.workspace.length === 1) {
      const named = matchWorkspace(packages, input.workspace[0] ?? "");
      return { kind: "repo", repo, choice: choiceFor(repo, packages, [named], "shared", false) };
    }
    if (pool.length === 1) {
      const only = pool[0];
      if (only === undefined)
        initUsage("No shared database package was found.", "Pass --workspace <name>.");
      return { kind: "repo", repo, choice: choiceFor(repo, packages, [only], "shared", false) };
    }
    if (pool.length === 0) {
      initUsage(
        "No shared database package was found.",
        "Pass --workspace <name> for the database package.",
      );
    }
    return needChoice(input.interactive, repo, pool);
  }
  if (input.workspace.length > 0) {
    const selected = input.workspace.map((token) => matchWorkspace(packages, token));
    const used =
      selected.length > 1 ? "per-service" : proposal.layout === "shared" ? "shared" : "per-service";
    return {
      kind: "repo",
      repo,
      choice: choiceFor(repo, packages, selected, used, false),
    };
  }
  if (proposal.candidates.length >= 2)
    return needChoice(input.interactive, repo, proposal.candidates);
  const only = proposal.candidates[0];
  if (only === undefined) return { kind: "single", root: input.start };
  const layout = proposal.layout === "shared" ? "shared" : "per-service";
  return { kind: "repo", repo, choice: choiceFor(repo, packages, [only], layout, false) };
}

/**
 * Parses a multi-select answer.
 *
 * `*` and `all` select every candidate. Numbers use the list order. A name
 * or path uses {@link matchWorkspace}.
 *
 * @param answer - The line the terminal returned
 * @param packages - Candidates, in prompt order
 * @returns The relative paths, or why the line was not usable
 */
export function parseWorkspaceAnswer(
  answer: string,
  packages: readonly WorkspacePackage[],
): WorkspaceAnswer {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed === "*" || trimmed.toLowerCase() === "all") {
    return { ok: true, rels: packages.map((pkg) => pkg.rel) };
  }
  const rels: string[] = [];
  for (const token of trimmed.split(/[,\s]+/)) {
    if (token.length === 0) continue;
    if (/^\d+$/.test(token)) {
      const pkg = packages[Number(token) - 1];
      if (pkg === undefined) return { ok: false, reason: `Unknown workspace ${token}.` };
      rels.push(pkg.rel);
      continue;
    }
    const matched = findWorkspace(packages, token);
    if (matched === undefined) return { ok: false, reason: `Unknown workspace ${token}.` };
    rels.push(matched.rel);
  }
  if (rels.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, rels };
}

/**
 * Prompt label for {@link parseWorkspaceAnswer}.
 *
 * @param packages - Candidates
 * @returns The question, without reading stdin
 */
export function workspacePrompt(packages: readonly WorkspacePackage[]): string {
  const lines = packages.map((pkg, index) => {
    const name = pkg.name ?? pkg.rel;
    return `${String(index + 1)}. ${name} (${pkg.rel})`;
  });
  return `Workspaces:\n${lines.join("\n")}\nNames or numbers, comma-separated, or *: `;
}

/**
 * Builds a monorepo plan. Nothing is written.
 *
 * @param input - Selection and the same flags a single package uses
 * @returns The plan, including per-package writes
 */
export function buildRepoPlan(input: {
  readonly repo: string;
  readonly choice: RepoChoice;
  readonly driver: InitDriver | undefined;
  readonly tenancy: InitSupportedTenancy;
  readonly dir: string;
  readonly pm: InitPackageManager;
  readonly yes: boolean;
  readonly force: ReadonlySet<string>;
  readonly install: boolean;
  readonly versions: PackageVersions;
  readonly dryRun: boolean;
}): RepoPlan {
  const selected = [...input.choice.selected].sort((left, right) =>
    left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0,
  );
  const okmodelSpec = input.choice.catalog ? "catalog:" : undefined;
  const baseFile = join(input.repo, "okmodel.base.ts");
  const packagePlans: {
    readonly pkg: WorkspacePackage;
    readonly plan: InitPlan;
    readonly driver: InitDriver;
  }[] = [];
  for (const pkg of selected) {
    const specifier = input.choice.writeBase ? posixRelative(pkg.dir, baseFile) : undefined;
    const scan = scanProject(pkg.dir, input.pm);
    const plan = buildPlan({
      root: pkg.dir,
      driver: resolveDriver(scan, input.driver ?? driverOf(pkg)),
      tenancy: input.tenancy,
      dir: input.dir,
      pm: input.pm,
      yes: input.yes,
      force: forceFor(pkg.rel, input.force),
      install: false,
      versions: input.versions,
      dryRun: input.dryRun,
      ...(specifier === undefined ? {} : { configSource: configText(input.dir, specifier) }),
      ...(okmodelSpec === undefined ? {} : { okmodelSpec }),
    });
    packagePlans.push({ pkg, plan, driver: plan.data.detection.driver });
  }
  const collision = migrationsCollision(
    input.repo,
    selected,
    packagePlans.map((item) => item.plan),
  );
  const files: InitPlan["data"]["files"][number][] = [];
  const edits: InitPlan["data"]["packageEdits"][number][] = [];
  const blocked: string[] = [];
  const packageWrites: PackageWrites[] = [];
  for (const item of packagePlans) {
    for (const file of item.plan.data.files) {
      files.push({ ...file, path: prefix(item.pkg.rel, file.path) });
    }
    for (const edit of item.plan.data.packageEdits) {
      const key = item.pkg.rel.length === 0 ? edit.key : `${item.pkg.rel} ${edit.key}`;
      edits.push({ ...edit, key });
    }
    for (const path of item.plan.blocked) blocked.push(prefix(item.pkg.rel, path));
    packageWrites.push({
      dir: item.pkg.dir,
      dirName: input.dir,
      writes: item.plan.blocked.length > 0 ? [] : item.plan.writes,
    });
  }
  const repoWrites: InitWrite[] = [];
  if (input.choice.writeBase) {
    const base = classifyLoose(
      "okmodel.base.ts",
      readRegular(input.repo, baseFile),
      baseText(),
      input.force.has("okmodel.base.ts"),
    );
    files.push(base.file);
    if (base.blocks) blocked.push("okmodel.base.ts");
    if (base.write !== undefined) repoWrites.push(base.write);
  }
  const rootScripts = rootScriptFile(input.repo, input.choice.runner, selected);
  if (rootScripts !== undefined) {
    files.push(rootScripts.file);
    edits.push(...rootScripts.edits);
    if (rootScripts.write !== undefined) repoWrites.push(rootScripts.write);
  }
  const first = packagePlans[0];
  const driver = first?.driver ?? input.driver ?? "postgresjs";
  const runtime = first?.plan.data.detection.runtime ?? "node";
  const quiet =
    blocked.length === 0 &&
    collision === undefined &&
    files.every((file) => file.action === "skip") &&
    edits.every((edit) => edit.action === "skip") &&
    !input.install;
  const workspaces = packagePlans.map((item) => ({
    path: item.pkg.rel,
    driver: item.driver,
    config: prefix(item.pkg.rel, CONFIG_FILE),
  }));
  const note = input.choice.note;
  const data = {
    status: quiet ? ("unchanged" as const) : ("planned" as const),
    detection: {
      pm: input.pm,
      driver,
      runtime,
      ...(first?.plan.data.detection.packageName === undefined
        ? {}
        : { packageName: first.plan.data.detection.packageName }),
      databaseEnv: "DATABASE_URL" as const,
      git: first?.plan.data.detection.git ?? false,
      okmodel: packagePlans.every((item) => item.plan.data.detection.okmodel),
      typescript: first?.plan.data.detection.typescript ?? "absent",
      orm: first?.plan.data.detection.orm ?? [],
      ancestorConfig: ancestorInside(selected[0]?.dir ?? input.repo, input.repo),
    },
    files,
    packageEdits: edits,
    nextSteps: nextSteps(input.pm),
    planHash: "",
    install: input.install,
    ...(note === undefined ? {} : { note }),
    layout: input.choice.layout,
    workspaces,
    ...(input.choice.writeBase ? { base: "okmodel.base.ts" } : {}),
  };
  const planHash = canonicalHash({
    layout: input.choice.layout,
    dir: input.dir,
    tenancy: input.tenancy,
    pm: input.pm,
    install: input.install,
    base: input.choice.writeBase ? contentHash(baseText()) : "",
    packages: packagePlans.map((item) => ({
      path: item.pkg.rel,
      hash: item.plan.data.planHash,
    })),
    edits: edits.map((edit) => ({ key: edit.key, action: edit.action, value: edit.value ?? "" })),
  });
  const withHash = { ...data, planHash };
  const warnings = packagePlans.flatMap((item) => item.plan.warnings);
  return {
    data: withHash,
    human: renderRepo(withHash, quiet),
    blocked,
    writes: [],
    warnings,
    install: input.install,
    ...(collision === undefined ? {} : { collision }),
    packageWrites: blocked.length > 0 || collision !== undefined ? [] : packageWrites,
    repoWrites: blocked.length > 0 || collision !== undefined ? [] : repoWrites,
  };
}

function proposeLayout(packages: readonly WorkspacePackage[]): {
  readonly layout: "single" | "per-service" | "shared";
  readonly candidates: readonly WorkspacePackage[];
} {
  const byName = new Map<string, WorkspacePackage>();
  for (const pkg of packages) {
    if (pkg.name !== undefined) byName.set(pkg.name, pkg);
  }
  const dependents = new Map<string, number>();
  for (const pkg of packages) {
    for (const dep of pkg.dependencies) {
      const target = byName.get(dep);
      if (target === undefined || target.dir === pkg.dir || !dependsOnDriver(target)) continue;
      dependents.set(target.dir, (dependents.get(target.dir) ?? 0) + 1);
    }
  }
  const shared = packages.filter((pkg) => (dependents.get(pkg.dir) ?? 0) >= 2);
  if (shared.length > 0) {
    const best = Math.max(...shared.map((pkg) => dependents.get(pkg.dir) ?? 0));
    return {
      layout: "shared",
      candidates: shared.filter((pkg) => (dependents.get(pkg.dir) ?? 0) === best),
    };
  }
  const drivers = packages.filter((pkg) => dependsOnDriver(pkg));
  if (drivers.length >= 2) return { layout: "per-service", candidates: drivers };
  if (drivers.length === 1) return { layout: "single", candidates: drivers };
  return { layout: "single", candidates: packages };
}

function choiceFor(
  repo: string,
  packages: readonly WorkspacePackage[],
  selected: readonly WorkspacePackage[],
  layout: "per-service" | "shared",
  inheriting: boolean,
): RepoChoice {
  const unique = dedupe(selected);
  const writeBase =
    inheriting || unique.length >= 2 || unique.some((pkg) => ancestorInside(pkg.dir, repo));
  const rootText = readRegular(repo, join(repo, "package.json")) ?? "";
  const runner = detectTaskRunner(repo, rootText);
  const note = layout === "shared" ? sharedNote(packages, unique) : undefined;
  return {
    layout,
    selected: unique,
    writeBase,
    ...(note === undefined ? {} : { note }),
    runner,
    catalog: catalogHasOkmodel(repo),
  };
}

function sharedNote(
  packages: readonly WorkspacePackage[],
  selected: readonly WorkspacePackage[],
): string | undefined {
  const db = selected[0];
  if (db?.name === undefined) return undefined;
  const apps = packages.filter((pkg) => pkg.dir !== db.dir && pkg.dependencies.has(db.name ?? ""));
  if (apps.length === 0) return undefined;
  return `${apps.map((pkg) => pkg.rel).join(", ")} depend on ${db.rel}. Config is written only there.`;
}

function needChoice(
  interactive: boolean,
  repo: string,
  candidates: readonly WorkspacePackage[],
): InitSelection {
  if (interactive) return { kind: "prompt", repo, candidates };
  refuseWorkspaceChoice(
    candidates.map((pkg) => (pkg.name === undefined ? pkg.rel : `${pkg.name} (${pkg.rel})`)),
  );
  return { kind: "single", root: repo };
}

function refuseFlagMix(input: {
  readonly workspace: readonly string[];
  readonly allWorkspaces: boolean;
  readonly shared: boolean;
}): void {
  if (input.shared && input.allWorkspaces) {
    initUsage("Pass either --shared or --all-workspaces.", "Drop one of them.");
  }
  if (input.shared && input.workspace.length > 1) {
    initUsage("Pass one --workspace with --shared.", "Name the database package once.");
  }
  if (input.allWorkspaces && input.workspace.length > 0) {
    initUsage("Pass either --workspace or --all-workspaces.", "Drop one of them.");
  }
}

function dependsOnDriver(pkg: WorkspacePackage): boolean {
  return DRIVER_PACKAGE_NAMES.some((name) => pkg.dependencies.has(name));
}

function driverOf(pkg: WorkspacePackage): InitDriver | undefined {
  if (pkg.dependencies.has("postgres")) return "postgresjs";
  if (pkg.dependencies.has("pg")) return "pg";
  if (pkg.dependencies.has("@neondatabase/serverless")) return "neon";
  if (pkg.dependencies.has("@electric-sql/pglite")) return "pglite";
  return undefined;
}

function matchWorkspace(packages: readonly WorkspacePackage[], token: string): WorkspacePackage {
  const found = findWorkspace(packages, token);
  if (found !== undefined) return found;
  initUsage(`Unknown workspace ${token}.`, "Pass a package name or path from the workspace.");
}

function findWorkspace(
  packages: readonly WorkspacePackage[],
  token: string,
): WorkspacePackage | undefined {
  const norm = token.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const exact = packages.filter((pkg) => pkg.name === token || pkg.rel === norm);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    initUsage(`Workspace ${token} matches more than one package.`, "Pass the package path.");
  }
  const base = norm.split("/").at(-1) ?? norm;
  const byBase = packages.filter((pkg) => pkg.rel.split("/").at(-1) === base || pkg.name === base);
  if (byBase.length === 1) return byBase[0];
  if (byBase.length > 1) {
    initUsage(`Workspace ${token} matches more than one package.`, "Pass the package path.");
  }
  return undefined;
}

function ancestorInside(packageDir: string, repo: string): boolean {
  let dir = dirname(resolve(packageDir));
  const root = resolve(repo);
  for (let depth = 0; depth < 8; depth += 1) {
    if (!isWithin(root, dir)) return false;
    if (existsSync(join(dir, CONFIG_FILE)) && lstatSync(join(dir, CONFIG_FILE)).isFile()) {
      return true;
    }
    if (dir === root) return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

function dedupe(packages: readonly WorkspacePackage[]): readonly WorkspacePackage[] {
  const seen = new Set<string>();
  const result: WorkspacePackage[] = [];
  for (const pkg of packages) {
    if (seen.has(pkg.dir)) continue;
    seen.add(pkg.dir);
    result.push(pkg);
  }
  return result;
}

function prefix(rel: string, file: string): string {
  if (rel.length === 0) return file;
  return `${rel}/${file}`;
}

function forceFor(rel: string, force: ReadonlySet<string>): Set<string> {
  const next = new Set<string>();
  const head = rel.length === 0 ? "" : `${rel}/`;
  for (const file of force) {
    if (head.length === 0) next.add(file);
    else if (file.startsWith(head)) next.add(file.slice(head.length));
  }
  return next;
}

function migrationsCollision(
  repo: string,
  selected: readonly WorkspacePackage[],
  plans: readonly InitPlan[],
): { readonly packages: readonly string[]; readonly directory: string } | undefined {
  const selectedDirs = new Set(selected.map((pkg) => resolve(pkg.dir)));
  const groups = new Map<string, string[]>();
  const all = listWorkspaces(repo);
  for (const pkg of all) {
    const index = selected.findIndex((item) => resolve(item.dir) === resolve(pkg.dir));
    const plan = index === -1 ? undefined : plans[index];
    const spec = effectiveMigrations(repo, pkg, plan, selectedDirs.has(resolve(pkg.dir)));
    if (spec === undefined) continue;
    const absolute = resolve(pkg.dir, ...spec.split("/"));
    const rel = relative(repo, absolute);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      refuseUnsupported("A migrations path escapes the project directory.");
    }
    const canonical = canonicalDir(absolute);
    const list = groups.get(canonical) ?? [];
    list.push(pkg.rel);
    groups.set(canonical, list);
  }
  for (const [directory, packages] of groups) {
    if (packages.length < 2) continue;
    const shown = relative(repo, directory).split("\\").join("/");
    return { packages, directory: shown.length === 0 ? "." : shown };
  }
  return undefined;
}

function effectiveMigrations(
  repo: string,
  pkg: WorkspacePackage,
  plan: InitPlan | undefined,
  selected: boolean,
): string | undefined {
  const existing = readMigrations(repo, pkg.dir);
  if (!selected) return existing;
  const config = plan?.data.files.find((file) => file.path === CONFIG_FILE);
  if (config !== undefined && config.action !== "skip") return "migrations";
  return existing ?? "migrations";
}

function readMigrations(repo: string, dir: string): string | undefined {
  const file = join(dir, CONFIG_FILE);
  if (!existsSync(file)) return undefined;
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink()) {
    const real = realpathSync(file);
    if (!isWithin(repo, real)) refuseUnsupported("A path escapes the project directory.");
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) return undefined;
  const text = readFileSync(stat.isSymbolicLink() ? realpathSync(file) : file, "utf8");
  const match = /migrations\s*:\s*(['"])([^'"]+)\1/.exec(text);
  return match?.[2]?.replaceAll("\\", "/").replace(/^\.\//, "") ?? "migrations";
}

function canonicalDir(target: string): string {
  let current = resolve(target);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    suffix.push(basename(current));
    const parent = dirname(current);
    if (parent === current) return target;
    current = parent;
  }
  let real = realpathSync(current);
  for (const part of suffix.reverse()) real = join(real, part);
  return real;
}

function readRegular(root: string, file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) {
    const real = realpathSync(file);
    if (!isWithin(root, real)) refuseUnsupported("A path escapes the project directory.");
    return readFileSync(real, "utf8");
  }
  if (!stat.isFile()) refuseUnsupported(`${relative(root, file)} is not a file.`);
  return readFileSync(file, "utf8");
}

function classifyLoose(
  path: string,
  current: string | undefined,
  desired: string,
  force: boolean,
): {
  readonly file: InitPlan["data"]["files"][number];
  readonly blocks: boolean;
  readonly write?: InitWrite;
} {
  if (current === undefined) {
    return {
      file: { path, state: "absent", action: "create", diff: `+${path}` },
      blocks: false,
      write: { path, text: desired },
    };
  }
  if (lf(current) === desired) {
    return { file: { path, state: "identical", action: "skip" }, blocks: false };
  }
  if (force) {
    return {
      file: { path, state: "user-modified", action: "overwrite", diff: `+${path}` },
      blocks: false,
      write: { path, text: desired },
    };
  }
  return {
    file: { path, state: "user-modified", action: "skip", diff: `+${path}` },
    blocks: true,
  };
}

function rootScriptFile(
  repo: string,
  runner: TaskRunner | undefined,
  selected: readonly WorkspacePackage[],
):
  | {
      readonly file: InitPlan["data"]["files"][number];
      readonly edits: InitPlan["data"]["packageEdits"];
      readonly write?: InitWrite;
    }
  | undefined {
  if (runner === undefined) return undefined;
  if (selected.some((pkg) => resolve(pkg.dir) === resolve(repo))) return undefined;
  const current = readRegular(repo, join(repo, "package.json"));
  if (current === undefined) return undefined;
  const commands: Record<string, string> = {};
  for (const name of INIT_SCRIPTS) commands[name] = forwardScript(runner, name);
  const patched = patchRootScripts(current, commands);
  if (lf(patched.text) === lf(current)) {
    return {
      file: { path: "package.json", state: "identical", action: "skip" },
      edits: patched.edits,
    };
  }
  return {
    file: { path: "package.json", state: "managed-diff", action: "update" },
    edits: patched.edits,
    write: { path: "package.json", text: patched.text },
  };
}

function renderRepo(data: RepoPlan["data"], quiet: boolean): string {
  const lines = [
    `layout: ${data.layout ?? "per-service"}`,
    `pm: ${data.detection.pm}`,
    `driver: ${data.detection.driver}`,
    `runtime: ${data.detection.runtime}`,
  ];
  for (const pkg of data.workspaces ?? []) {
    lines.push(`config: ${pkg.config}`);
    lines.push(`driver ${pkg.path}: ${pkg.driver}`);
  }
  if (data.base !== undefined) lines.push(`base: ${data.base}`);
  if (data.note !== undefined) lines.push(data.note);
  for (const file of data.files) {
    lines.push(`${file.action} ${file.path} (${file.state})`);
  }
  for (const edit of data.packageEdits) {
    const value = edit.value === undefined ? "" : ` ${edit.value}`;
    lines.push(`${edit.action} ${edit.key}${value}`);
  }
  if (data.install) lines.push("install: yes");
  if (quiet) lines.push("nothing to do");
  lines.push(...data.nextSteps);
  return `${lines.join("\n")}\n`;
}
