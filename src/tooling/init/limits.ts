/**
 * `okm init --limits` and `okm init --time`.
 *
 * `--limits` writes `limits` into the client init generated. `--time` writes
 * `defaults.time` into the schema init generated. Each edits its file only
 * when it still matches the hash in `.okm/init.json`. Anything else is printed
 * and left on disk.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalHash } from "../canonical-json.js";
import type { ParsedCli } from "../cli/parse.js";
import { CONFIG_FILE } from "../migrate/paths.js";
import {
  applyWrites,
  contentHash,
  prepareRoot,
  readInitRecord,
  resolveDriver,
  textDiff,
  type InitData,
} from "./engine.js";
import { scanProject } from "./detect.js";
import {
  initUsage,
  isInitDriver,
  isInitPackageManager,
  timeFlag,
  type InitDriver,
  type InitPackageManager,
} from "./guards.js";
import { normalizeInitPath, resolveInside } from "./paths.js";
import { clientHasLimits, clientText, limitsHint, nextSteps, schemaText } from "./text.js";

/** What `okm init --limits` and `--time` return. Same shape as a normal init plan. */
export type LimitsProduced = {
  readonly text: string;
  readonly data: InitData;
  readonly warnings: readonly { readonly summary: string }[];
  readonly outFile: null;
};

/**
 * Adds the scaffolded `limits` to an unmodified generated client.
 *
 * @param parsed - Parsed flags. The operand is the project directory
 * @param cwd - Working directory
 * @returns The plan document. Nothing else init writes is touched
 */
export function limitsCommand(parsed: ParsedCli, cwd: string): LimitsProduced {
  return editGenerated(parsed, cwd, "init --limits", (_record, driver, dir) => {
    const path = `${dir}/client.ts`;
    return {
      path,
      next: driver === undefined ? undefined : clientText(driver),
      already: (current) => clientHasLimits(current),
      alreadyNote: `${path} already sets limits.`,
      hint: limitsHint(path),
    };
  });
}

/**
 * Sets `defaults.time` in an unmodified generated schema.
 *
 * @param parsed - Parsed flags. `--time` is the mode
 * @param cwd - Working directory
 * @returns The plan document. Nothing else init writes is touched
 */
export function timeCommand(parsed: ParsedCli, cwd: string): LimitsProduced {
  const time = timeFlag(parsed.time) ?? "iso";
  return editGenerated(parsed, cwd, "init --time", (record, _driver, dir) => {
    const path = `${dir}/schema.ts`;
    const next = schemaText(record?.choices?.tenancy ?? "none", time);
    return {
      path,
      next,
      already: (current) => current === next,
      alreadyNote: `${path} already sets defaults: { time: "${time}" }.`,
      hint: `${path} was changed after okm init, so it is left as it is. Set defaults: { time: "${time}" } in schema() yourself.`,
    };
  });
}

type GeneratedEdit = {
  readonly path: string;
  readonly next: string | undefined;
  readonly already: (current: string) => boolean;
  readonly alreadyNote: string;
  readonly hint: string;
};

function editGenerated(
  parsed: ParsedCli,
  cwd: string,
  command: string,
  target: (
    record: ReturnType<typeof readInitRecord>,
    driver: InitDriver | undefined,
    dir: string,
  ) => GeneratedEdit,
): LimitsProduced {
  const project = parsed.operands[0];
  const start = project === undefined ? cwd : resolve(cwd, project);
  const root = prepareRoot(start);
  const pm = packageManager(parsed.pm);
  const scan = scanProject(root, pm);
  const recordText = readOptional(root, ".okm/init.json");
  const record = readInitRecord(recordText);
  const dir = normalizeInitPath(parsed.dbDir ?? record?.choices?.dir ?? "db");
  const driver = flaggedDriver(parsed.driver) ?? record?.choices?.driver;
  const { path, next, already: isAlready, alreadyNote, hint } = target(record, driver, dir);
  const current = readOptional(root, path);
  const recorded = record?.files[path];
  const already = current !== undefined && isAlready(current);
  const untouched =
    driver !== undefined &&
    current !== undefined &&
    recorded !== undefined &&
    recorded === contentHash(current) &&
    !already;
  const write = untouched && next !== undefined && !parsed.dryRun;
  const showDiff = untouched && next !== undefined && current !== undefined;

  if (write && next !== undefined && recordText !== undefined) {
    const hashed = contentHash(next);
    applyWrites(root, dir, [
      { path, text: next },
      { path: ".okm/init.json", text: withClientHash(recordText, path, hashed) },
    ]);
  }

  const note = already ? alreadyNote : hint;
  const action = write || (showDiff && parsed.dryRun) ? "update" : "skip";
  const state = already
    ? "identical"
    : showDiff
      ? "managed-diff"
      : current === undefined
        ? "absent"
        : "user-modified";
  const diff =
    showDiff && current !== undefined && next !== undefined ? textDiff(path, current, next) : "";
  const status = write ? "applied" : showDiff && parsed.dryRun ? "planned" : "unchanged";
  const steps = nextSteps(scan.pm);
  const data: InitData = {
    status,
    detection: {
      pm: scan.pm,
      driver: driver ?? resolveDriver(scan, undefined),
      runtime: scan.runtime,
      ...(scan.packageName === undefined ? {} : { packageName: scan.packageName }),
      databaseEnv: "DATABASE_URL",
      git: scan.git,
      okmodel: scan.okmodel,
      typescript: scan.typescript,
      orm: scan.orm,
      ancestorConfig: scan.ancestorConfig,
    },
    files: [
      {
        path,
        state,
        action,
        ...(diff.length === 0 ? {} : { diff }),
      },
    ],
    packageEdits: [],
    nextSteps: steps,
    planHash: "",
    install: false,
    note,
  };
  const planHash = canonicalHash({
    command,
    path,
    action,
    state,
    status,
  });
  const withHash: InitData = { ...data, planHash };
  const quiet = status === "unchanged";
  return { text: render(withHash, quiet), data: withHash, warnings: [], outFile: null };
}

function render(data: InitData, quiet: boolean): string {
  const lines = [
    `pm: ${data.detection.pm}`,
    `driver: ${data.detection.driver}`,
    `runtime: ${data.detection.runtime}`,
  ];
  lines.push(`database env: ${data.detection.databaseEnv}`);
  lines.push(`config: ${CONFIG_FILE}`);
  if (data.note !== undefined) lines.push(data.note);
  for (const file of data.files) {
    lines.push(`${file.action} ${file.path} (${file.state})`);
    if (file.diff !== undefined) lines.push(file.diff);
  }
  if (quiet) lines.push("nothing to do");
  lines.push(...data.nextSteps);
  return `${lines.join("\n")}\n`;
}

function withClientHash(recordText: string, path: string, hash: string): string {
  const parsed: unknown = JSON.parse(recordText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return recordText;
  const record = parsed as { files?: unknown };
  if (typeof record.files !== "object" || record.files === null || Array.isArray(record.files)) {
    return recordText;
  }
  (record.files as Record<string, string>)[path] = hash;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function readOptional(root: string, rel: string): string | undefined {
  const path = resolveInside(root, rel);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

function packageManager(value: string | undefined): InitPackageManager | undefined {
  if (value === undefined) return undefined;
  if (!isInitPackageManager(value)) {
    initUsage(`Unknown package manager ${value}.`, "Pass --pm bun, npm, pnpm, or yarn.");
  }
  return value;
}

function flaggedDriver(value: string | undefined): InitDriver | undefined {
  if (value === undefined) return undefined;
  if (!isInitDriver(value)) {
    initUsage(
      `Unknown driver ${value}.`,
      "Pass --driver postgresjs, pg, bun-sql, pglite, or neon.",
    );
  }
  return value;
}
