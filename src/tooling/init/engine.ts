/**
 * File plan for `okm init`.
 *
 * Detection is read-only. Writes are staged in memory and applied with
 * `okmodel.config.ts` last. A user-modified file is not replaced unless that
 * path was named. Hashes are SHA-256 of LF-normalised text.
 */

import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { OkmError } from "../../contracts/error.js";
import { sha256 } from "../../contracts/sha256.js";
import { canonicalHash, type Canonical } from "../canonical-json.js";
import { CONFIG_FILE } from "../migrate/paths.js";
import { renderUntrusted, type UntrustedText } from "../untrusted.js";
import { scanProject, type InitRuntime, type ProjectScan } from "./detect.js";
import {
  initError,
  isInitDriver,
  refuseDifferentDriver,
  refuseMissingDecision,
  refuseTenancy,
  refuseUnsupported,
  type InitDriver,
  type InitPackageManager,
  type InitSupportedTenancy,
} from "./guards.js";
import { patchPackageJson, type PackageEdit, type PackageVersions } from "./package-json.js";
import { resolveInside } from "./paths.js";
import {
  clientText,
  configText,
  gitignoreEntries,
  initGitAttributes,
  nextSteps,
  schemaText,
} from "./text.js";

/** How a file compares with the last init record. */
export type InitFileState = "absent" | "identical" | "managed-diff" | "user-modified";

/** What apply will do with a file. */
export type InitFileAction = "create" | "update" | "skip" | "overwrite" | "append";

/** One file in the plan document. */
export type InitFileData = {
  readonly path: string;
  readonly state: InitFileState;
  readonly action: InitFileAction;
  readonly diff?: string;
};

/** JSON `data` for `okm init`. */
export type InitData = {
  readonly status: "planned" | "applied" | "unchanged";
  readonly detection: {
    readonly pm: InitPackageManager;
    readonly driver: InitDriver;
    readonly runtime: InitRuntime;
    readonly packageName?: UntrustedText;
    readonly databaseEnv: "DATABASE_URL";
    readonly git: boolean;
    readonly okmodel: boolean;
    readonly typescript: "absent" | "ok" | "warn";
    readonly orm: readonly string[];
    readonly ancestorConfig: boolean;
  };
  readonly files: readonly InitFileData[];
  readonly packageEdits: readonly PackageEdit[];
  readonly nextSteps: readonly [string, string, string];
  readonly planHash: string;
  readonly install: boolean;
  readonly note?: string;
  /** `single` is one package. `per-service` and `shared` are monorepo layouts. */
  readonly layout?: "single" | "per-service" | "shared";
  /** Packages this init writes. Absent for one package. */
  readonly workspaces?: readonly {
    readonly path: string;
    readonly driver: InitDriver;
    readonly config: string;
  }[];
  /** `okmodel.base.ts`, when this init writes it. */
  readonly base?: string;
};

/** One file apply may write. */
export type InitWrite = {
  readonly path: string;
  readonly text: string;
};

/** A computed plan. `writes` is empty when nothing will be written. */
export type InitPlan = {
  readonly data: InitData;
  readonly human: string;
  readonly blocked: readonly string[];
  readonly writes: readonly InitWrite[];
  readonly warnings: readonly { readonly summary: string }[];
  readonly install: boolean;
  /** Set when two packages would share one migrations directory. */
  readonly collision?: { readonly packages: readonly string[]; readonly directory: string };
};

/** Choices that select file bodies. */
export type InitChoices = {
  readonly root: string;
  readonly driver: InitDriver;
  readonly tenancy: InitSupportedTenancy;
  readonly dir: string;
  readonly pm: InitPackageManager;
  readonly yes: boolean;
  readonly force: ReadonlySet<string>;
  readonly install: boolean;
  readonly versions: PackageVersions;
  readonly dryRun: boolean;
  /** Config body. The default is {@link configText} for `dir`. */
  readonly configSource?: string;
  /** Dependency spec for `okmodel`. The default is a plain range. */
  readonly okmodelSpec?: string;
};

/**
 * Paths init is allowed to write, in apply order except the config is last.
 *
 * @param dir - Base directory for the schema and the client
 * @returns Project-relative paths
 */
export function initAllowlist(dir: string): readonly string[] {
  return [
    `${dir}/schema.ts`,
    `${dir}/client.ts`,
    "migrations/.gitkeep",
    ".env.example",
    ".gitattributes",
    ".gitignore",
    "package.json",
    ".okm/init.json",
    CONFIG_FILE,
  ];
}

/**
 * LF-normalises text before it is hashed or compared.
 *
 * @param text - File text
 * @returns The text with CR LF and CR turned into LF
 */
export function lf(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/**
 * SHA-256 of {@link lf}.
 *
 * @param text - File text
 * @returns Lowercase hex
 */
export function contentHash(text: string): string {
  return sha256(lf(text));
}

/**
 * Whether this invocation installs dependencies.
 *
 * `--json` never installs. `--yes` installs only with `--install`.
 * Otherwise a terminal installs unless `--no-install` was passed.
 *
 * @param input - Flags and whether stdin is a terminal
 * @returns `true` when apply should install
 */
export function shouldInstall(input: {
  readonly json: boolean;
  readonly yes: boolean;
  readonly install: boolean;
  readonly noInstall: boolean;
  readonly tty: boolean;
}): boolean {
  if (input.noInstall) return false;
  if (input.json) return false;
  if (input.install) return true;
  if (input.yes) return false;
  return input.tty;
}

/**
 * Resolves the project directory.
 *
 * @param dir - Positional directory or the working directory
 * @returns The real directory
 */
export function prepareRoot(dir: string): string {
  const absolute = resolve(dir);
  if (!existsSync(absolute)) {
    if (!existsSync(dirname(absolute))) {
      refuseUnsupported("okm init needs a directory it can write.");
    }
    mkdirSync(absolute);
  }
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    refuseUnsupported("okm init needs a directory it can write.");
  }
  if (!lstatSync(real).isDirectory()) {
    refuseUnsupported("okm init needs a directory it can write.");
  }
  try {
    accessSync(real, constants.W_OK);
  } catch {
    refuseUnsupported("okm init needs a directory it can write.");
  }
  if (!existsSync(resolve(real, "package.json"))) {
    refuseUnsupported("okm init needs a package.json in the project directory.");
  }
  return real;
}

/**
 * Picks the driver. A package that is already installed wins.
 *
 * Bun.sql is the default only when the runtime is Bun and no driver package
 * is installed. Passing another driver then adds that package. It does not
 * add a second driver next to one that is already declared.
 *
 * @param scan - Detection
 * @param requested - `--driver`, when it was passed or chosen at a prompt
 * @returns The driver to write
 */
export function resolveDriver(scan: ProjectScan, requested: InitDriver | undefined): InitDriver {
  const installed = scan.installedDrivers;
  if (requested !== undefined) {
    if (installed.length === 1 && installed[0] !== requested) {
      refuseDifferentDriver(installed[0] ?? requested, requested);
    }
    if (installed.length > 1 && !installed.includes(requested)) {
      refuseDifferentDriver(installed.join(", "), requested);
    }
    return requested;
  }
  if (installed.length > 1) refuseMissingDecision(["--driver"]);
  const only = installed[0];
  if (only !== undefined) return only;
  if (scan.runtime === "bun") return "bun-sql";
  return "postgresjs";
}

/**
 * Builds the plan. Nothing is written.
 *
 * @param choices - Resolved flags
 * @returns The plan, the human text, and the writes apply would perform
 */
export function buildPlan(choices: InitChoices): InitPlan {
  const scan = scanProject(choices.root, choices.pm);
  const driver = choices.driver;
  const allow = new Set(initAllowlist(choices.dir));
  const record = readRecord(readIfFile(choices.root, ".okm/init.json"));
  const recorded = record?.files ?? {};
  const desired = new Map<string, string>();
  desired.set(`${choices.dir}/schema.ts`, schemaText(choices.tenancy));
  desired.set(`${choices.dir}/client.ts`, clientText(driver));
  desired.set("migrations/.gitkeep", "\n");
  desired.set(CONFIG_FILE, choices.configSource ?? configText(choices.dir));

  desired.set(".gitattributes", initGitAttributes());

  const patched = patchPackageJson(
    scan.packageText,
    choices.pm,
    driver,
    choices.versions,
    choices.okmodelSpec,
  );
  desired.set("package.json", patched.text);

  const files: Planned[] = [];
  for (const path of initAllowlist(choices.dir)) {
    if (path === ".okm/init.json" || path === "package.json") continue;
    if (path === ".env.example" || path === ".gitignore") {
      const current = readIfFile(choices.root, path);
      const missing = path === ".env.example" ? envMissing(current) : gitignoreMissing(current);
      files.push(classifyAppend(path, current, missing));
      continue;
    }
    const body = desired.get(path);
    if (body === undefined) continue;
    const current = readIfFile(choices.root, path);
    files.push(classify(path, current, body, recorded[path], choices, kindOf(path)));
  }
  files.push(classifyPackage(patched.text, scan.packageText, patched.edits));

  const hashes = postHashes(files);
  const recordText = recordTextOf(choices, driver, hashes);
  const recordCurrent = readIfFile(choices.root, ".okm/init.json");
  files.push(classifyRecord(recordCurrent, recordText, choices));
  files.sort(
    (left, right) => allowOrder(left.path, choices.dir) - allowOrder(right.path, choices.dir),
  );

  for (const file of files) {
    if (!allow.has(file.path)) refuseUnsupported("okm init refused a path outside its allowlist.");
  }

  const blocked = files.filter((file) => file.blocks).map((file) => file.path);
  const pending = files
    .filter((file) => file.action !== "skip")
    .map((file) => ({ path: file.path, text: file.next ?? "" }));
  const quiet =
    files.every(
      (file) =>
        file.state === "identical" ||
        (file.state === "user-modified" && file.action === "skip" && !file.blocks),
    ) &&
    patched.edits.every((edit) => edit.action === "skip") &&
    !choices.install;
  const status = quiet ? "unchanged" : "planned";
  const steps = nextSteps(choices.pm);
  const note = notesOf(scan);
  const data: InitData = {
    status,
    detection: {
      pm: scan.pm,
      driver,
      runtime: scan.runtime,
      ...(scan.packageName === undefined ? {} : { packageName: scan.packageName }),
      databaseEnv: "DATABASE_URL",
      git: scan.git,
      okmodel: scan.okmodel,
      typescript: scan.typescript,
      orm: scan.orm,
      ancestorConfig: scan.ancestorConfig,
    },
    files: files.map(fileData),
    packageEdits: patched.edits,
    nextSteps: steps,
    planHash: "",
    install: choices.install,
    ...(note === undefined ? {} : { note }),
  };
  const planHash = canonicalHash(hashBody(choices, data, files));
  const withHash: InitData = { ...data, planHash };
  const warnings = warningsOf(scan);
  return {
    data: withHash,
    human: renderHuman(withHash, quiet),
    blocked,
    writes: blocked.length > 0 ? [] : pending,
    warnings,
    install: choices.install,
  };
}

/**
 * Writes a plan. `okmodel.config.ts` is last. On failure the error names
 * the files that were not written.
 *
 * @param root - Project directory
 * @param dir - Base directory used for the allowlist
 * @param writes - Files in apply order
 * @param allowList - Paths this call may write. The default is {@link initAllowlist}
 */
export function applyWrites(
  root: string,
  dir: string,
  writes: readonly InitWrite[],
  allowList?: ReadonlySet<string>,
): void {
  const allow = allowList ?? new Set(initAllowlist(dir));
  for (let index = 0; index < writes.length; index += 1) {
    const file = writes[index];
    if (file === undefined) continue;
    try {
      if (!allow.has(file.path)) {
        refuseUnsupported("okm init refused a path outside its allowlist.");
      }
      const path = resolveInside(root, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.text);
    } catch (error) {
      const left = writes.slice(index).map((item) => item.path);
      const detail = error instanceof OkmError ? error.message : "the write failed";
      const code =
        error instanceof OkmError && error.code.startsWith("OKM") ? error.code : "invalid";
      initError(
        code,
        `${detail} Still to write: ${left.join(", ")}.`,
        "Fix the directory permissions. Files already written stay.",
        code === "OKM1865" ? "unreachable" : "failed",
      );
    }
  }
}

/**
 * Whether `value` is a driver flag.
 *
 * @param value - Raw flag
 * @returns The driver, or `undefined` when the flag was omitted
 */
export function driverFlag(value: string | undefined): InitDriver | undefined {
  if (value === undefined) return undefined;
  if (!isInitDriver(value)) {
    initError(
      "invalid",
      `Unknown driver ${value}.`,
      "Pass --driver postgresjs, pg, bun-sql, pglite, or neon.",
      "usage",
    );
  }
  return value;
}

/**
 * Checks a tenancy flag and refuses the modes init does not write.
 *
 * @param value - Raw flag, or `undefined` for the default
 * @returns `none` or `column`
 */
export function tenancyFlag(value: string | undefined): InitSupportedTenancy {
  const tenancy = value ?? "none";
  if (
    tenancy !== "none" &&
    tenancy !== "column" &&
    tenancy !== "schema" &&
    tenancy !== "database"
  ) {
    initError(
      "invalid",
      `Unknown tenancy ${tenancy}.`,
      "Pass --tenancy none, column, schema, or database.",
      "usage",
    );
  }
  if (tenancy !== "none" && tenancy !== "column") {
    refuseTenancy(tenancy);
    throw new Error("okm init tenancy");
  }
  return tenancy;
}

type Planned = {
  readonly path: string;
  readonly state: InitFileState;
  readonly action: InitFileAction;
  readonly diff: string;
  readonly blocks: boolean;
  readonly next?: string;
  readonly hash: string;
};

type InitRecord = {
  readonly files: Readonly<Record<string, string>>;
};

function kindOf(path: string): "own" | "append" | "attributes" {
  if (path === ".gitignore" || path === ".env.example") return "append";
  if (path === ".gitattributes") return "attributes";
  return "own";
}

function classify(
  path: string,
  current: string | undefined,
  desired: string,
  recorded: string | undefined,
  choices: InitChoices,
  kind: "own" | "append" | "attributes",
): Planned {
  if (current === undefined) {
    return planned(
      path,
      "absent",
      "create",
      diff(path, "", desired),
      false,
      desired,
      contentHash(desired),
    );
  }
  const now = lf(current);
  if (now === desired) {
    return planned(path, "identical", "skip", "", false, undefined, contentHash(current));
  }
  if (kind === "attributes") {
    return planned(
      path,
      "user-modified",
      "skip",
      diff(path, current, desired),
      false,
      undefined,
      contentHash(current),
    );
  }
  if (kind === "append") {
    return planned(
      path,
      "managed-diff",
      "append",
      diff(path, current, desired),
      false,
      desired,
      contentHash(desired),
    );
  }
  const nowHash = contentHash(current);
  if (recorded !== undefined && recorded === nowHash) {
    const action = choices.yes || choices.force.has(path) ? "update" : "skip";
    return planned(
      path,
      "managed-diff",
      action,
      diff(path, current, desired),
      false,
      action === "skip" ? undefined : desired,
      action === "skip" ? nowHash : contentHash(desired),
    );
  }
  if (choices.force.has(path)) {
    return planned(
      path,
      "user-modified",
      "overwrite",
      diff(path, current, desired),
      false,
      desired,
      contentHash(desired),
    );
  }
  return planned(
    path,
    "user-modified",
    "skip",
    diff(path, current, desired),
    true,
    undefined,
    nowHash,
  );
}

function classifyPackage(next: string, current: string, edits: readonly PackageEdit[]): Planned {
  if (lf(next) === lf(current)) {
    return planned("package.json", "identical", "skip", "", false, undefined, contentHash(current));
  }
  const added = edits.some((edit) => edit.action === "add");
  return planned(
    "package.json",
    added ? "managed-diff" : "identical",
    added ? "update" : "skip",
    added ? diff("package.json", current, next) : "",
    false,
    added ? next : undefined,
    contentHash(added ? next : current),
  );
}

function classifyRecord(
  current: string | undefined,
  desired: string,
  choices: InitChoices,
): Planned {
  if (current === undefined) {
    return planned(
      ".okm/init.json",
      "absent",
      "create",
      diff(".okm/init.json", "", desired),
      false,
      desired,
      contentHash(desired),
    );
  }
  if (lf(current) === desired) {
    return planned(
      ".okm/init.json",
      "identical",
      "skip",
      "",
      false,
      undefined,
      contentHash(current),
    );
  }
  if (readRecord(current) !== undefined) {
    const action = choices.yes || choices.force.has(".okm/init.json") ? "update" : "skip";
    return planned(
      ".okm/init.json",
      "managed-diff",
      action,
      diff(".okm/init.json", current, desired),
      false,
      action === "skip" ? undefined : desired,
      action === "skip" ? contentHash(current) : contentHash(desired),
    );
  }
  if (choices.force.has(".okm/init.json")) {
    return planned(
      ".okm/init.json",
      "user-modified",
      "overwrite",
      diff(".okm/init.json", current, desired),
      false,
      desired,
      contentHash(desired),
    );
  }
  return planned(
    ".okm/init.json",
    "user-modified",
    "skip",
    diff(".okm/init.json", current, desired),
    true,
    undefined,
    contentHash(current),
  );
}

function postHashes(files: readonly Planned[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file.path] = file.hash;
  return hashes;
}

function recordTextOf(
  choices: InitChoices,
  driver: InitDriver,
  hashes: Readonly<Record<string, string>>,
): string {
  const files: Record<string, string> = {};
  for (const path of Object.keys(hashes).sort()) {
    const hash = hashes[path];
    if (hash !== undefined) files[path] = hash;
  }
  return `${JSON.stringify(
    {
      version: 1,
      choices: {
        dialect: "postgres",
        driver,
        dir: choices.dir,
        tenancy: choices.tenancy,
      },
      files,
    },
    null,
    2,
  )}\n`;
}

function planned(
  path: string,
  state: InitFileState,
  action: InitFileAction,
  fileDiff: string,
  blocks: boolean,
  next: string | undefined,
  hash: string,
): Planned {
  return {
    path,
    state,
    action,
    diff: fileDiff,
    blocks,
    ...(next === undefined ? {} : { next }),
    hash,
  };
}

function fileData(file: Planned): InitFileData {
  return {
    path: file.path,
    state: file.state,
    action: file.action,
    ...(file.diff.length === 0 ? {} : { diff: file.diff }),
  };
}

function hashBody(choices: InitChoices, data: InitData, files: readonly Planned[]): Canonical {
  return {
    dialect: "postgres",
    driver: data.detection.driver,
    dir: choices.dir,
    tenancy: choices.tenancy,
    pm: data.detection.pm,
    runtime: data.detection.runtime,
    install: data.install,
    files: files.map((file) => ({
      path: file.path,
      state: file.state,
      action: file.action,
      hash: file.hash,
    })),
    packageEdits: data.packageEdits.map((edit) => ({
      key: edit.key,
      action: edit.action,
      value: edit.value ?? "",
    })),
  };
}

function renderHuman(data: InitData, quiet: boolean): string {
  const lines = [
    `pm: ${data.detection.pm}`,
    `driver: ${data.detection.driver}`,
    `runtime: ${data.detection.runtime}`,
  ];
  if (data.detection.packageName !== undefined)
    lines.push(renderUntrusted(data.detection.packageName));
  lines.push(`database env: ${data.detection.databaseEnv}`);
  lines.push(`config: ${CONFIG_FILE}`);
  if (data.detection.ancestorConfig) {
    lines.push(
      "An ancestor directory has okmodel.config.ts. Share settings through okmodel.base.ts instead of a second root.",
    );
  }
  if (data.detection.orm.length > 0) lines.push(`orm: ${data.detection.orm.join(", ")}`);
  if (data.note !== undefined) lines.push(data.note);
  for (const file of data.files) {
    lines.push(`${file.action} ${file.path} (${file.state})`);
    if (file.diff !== undefined) lines.push(file.diff);
  }
  if (data.packageEdits.length > 0) {
    lines.push("package.json");
    for (const edit of data.packageEdits) {
      const value = edit.value === undefined ? "" : ` ${edit.value}`;
      lines.push(`  ${edit.action} ${edit.key}${value}`);
    }
  }
  if (data.install) lines.push("install: yes");
  if (quiet) lines.push("nothing to do");
  lines.push(...data.nextSteps);
  return `${lines.join("\n")}\n`;
}

function notesOf(scan: ProjectScan): string | undefined {
  if (!scan.orm.includes("drizzle-orm")) return undefined;
  return "drizzle-orm is installed. okm import drizzle <path> reads that schema.";
}

function warningsOf(scan: ProjectScan): readonly { readonly summary: string }[] {
  if (scan.typescript !== "warn") return [];
  return [
    {
      summary:
        "tsconfig moduleResolution may not resolve subpath exports. Use node16, nodenext, or bundler.",
    },
  ];
}

function classifyAppend(
  path: string,
  current: string | undefined,
  missing: readonly string[],
): Planned {
  if (current === undefined) {
    const text = `${missing.join("\n")}\n`;
    return planned(
      path,
      "absent",
      "create",
      addedDiff(path, missing),
      false,
      text,
      contentHash(text),
    );
  }
  if (missing.length === 0) {
    return planned(path, "identical", "skip", "", false, undefined, contentHash(current));
  }
  const text = appendText(current, missing);
  return planned(
    path,
    "managed-diff",
    "append",
    addedDiff(path, missing),
    false,
    text,
    contentHash(text),
  );
}

function envMissing(current: string | undefined): readonly string[] {
  if (current !== undefined && /^DATABASE_URL=/m.test(lf(current))) return [];
  return ["DATABASE_URL="];
}

function gitignoreMissing(current: string | undefined): readonly string[] {
  const have = new Set(current === undefined ? [] : lf(current).split("\n"));
  return gitignoreEntries().filter((line) => !have.has(line));
}

function appendText(current: string, lines: readonly string[]): string {
  const nl = current.includes("\r\n") ? "\r\n" : "\n";
  const ended = current.endsWith("\n") || current.endsWith("\r\n");
  const base = ended ? current : `${current}${nl}`;
  return `${base}${lines.join(nl)}${nl}`;
}

function addedDiff(path: string, lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return [`--- ${path}`, `+++ ${path}`, ...lines.map((line) => `+${line}`)].join("\n");
}

function diffLines(text: string): string[] {
  const normal = lf(text);
  if (normal.length === 0) return [];
  const parts = normal.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

function diff(path: string, before: string, after: string): string {
  const left = diffLines(before);
  const right = diffLines(after);
  if (left.join("\n") === right.join("\n")) return "";
  const lines = [`--- ${path}`, `+++ ${path}`];
  if (left.length > 180 || right.length > 180) {
    lines.push(`@@ file differs (${String(left.length)} lines, ${String(right.length)} lines) @@`);
    return lines.join("\n");
  }
  const lcs = longest(left, right);
  let a = 0;
  let b = 0;
  for (const row of lcs) {
    while (a < row.left) {
      lines.push(`-${left[a] ?? ""}`);
      a += 1;
    }
    while (b < row.right) {
      lines.push(`+${right[b] ?? ""}`);
      b += 1;
    }
    lines.push(` ${left[a] ?? ""}`);
    a += 1;
    b += 1;
  }
  while (a < left.length) {
    lines.push(`-${left[a] ?? ""}`);
    a += 1;
  }
  while (b < right.length) {
    lines.push(`+${right[b] ?? ""}`);
    b += 1;
  }
  return lines.join("\n");
}

function longest(
  left: readonly string[],
  right: readonly string[],
): readonly { readonly left: number; readonly right: number }[] {
  const width = right.length + 1;
  const table = new Uint16Array((left.length + 1) * width);
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let col = right.length - 1; col >= 0; col -= 1) {
      const index = row * width + col;
      table[index] =
        left[row] === right[col]
          ? (table[(row + 1) * width + col + 1] ?? 0) + 1
          : Math.max(table[(row + 1) * width + col] ?? 0, table[row * width + col + 1] ?? 0);
    }
  }
  const matches: { left: number; right: number }[] = [];
  let row = 0;
  let col = 0;
  while (row < left.length && col < right.length) {
    if (left[row] === right[col]) {
      matches.push({ left: row, right: col });
      row += 1;
      col += 1;
      continue;
    }
    const down = table[(row + 1) * width + col] ?? 0;
    const across = table[row * width + col + 1] ?? 0;
    if (down >= across) row += 1;
    else col += 1;
  }
  return matches;
}

function readIfFile(root: string, rel: string): string | undefined {
  const path = resolveInside(root, rel);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile()) refuseUnsupported(`${rel} is not a file.`);
  return readFileSync(path, "utf8");
}

function readRecord(text: string | undefined): InitRecord | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as { readonly version?: unknown; readonly files?: unknown };
    if (record.version !== 1 || typeof record.files !== "object" || record.files === null) {
      return undefined;
    }
    const files: Record<string, string> = {};
    for (const [key, value] of Object.entries(record.files)) {
      if (typeof value === "string") files[key] = value;
    }
    return { files };
  } catch {
    return undefined;
  }
}

function allowOrder(path: string, dir: string): number {
  const index = initAllowlist(dir).indexOf(path);
  return index === -1 ? 99 : index;
}
