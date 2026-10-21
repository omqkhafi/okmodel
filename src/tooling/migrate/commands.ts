/**
 * `okm` command dispatch.
 *
 * The bin wrapper imports {@link run}. Importing this module does not parse
 * `process.argv`. `--json` writes one `okm.cli/1` envelope and nothing else.
 */

import { statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { nearestName } from "../../contracts/nearest.js";
import { OkmError } from "../../contracts/error.js";
import { warningBody } from "../errors/body.js";
import { renderUntrusted, untrustedText } from "../untrusted.js";
import { errorDoc } from "../errors/registry.js";
import {
  envelope,
  errorBody,
  serializeEnvelope,
  targetFingerprint,
  terseStderr,
  type CliTarget,
  type CliWarning,
} from "../cli/envelope.js";
import { collectNotices } from "../cli/notices.js";
import {
  attachPartial,
  CommandFinished,
  exitCodeFor,
  readConfigPath,
  readPartial,
  tagConfigPath,
  tagOutcome,
  type CliOutFile,
} from "../cli/outcome.js";
import { argvHasJson, parseCli, type ParsedCli } from "../cli/parse.js";
import { commandsTable, helpText } from "../cli/spec.js";
import { schemaCommands, schemaFor, schemaText } from "../cli/schema.js";
import { readPackageVersion } from "../cli/version.js";
import {
  allowFindings,
  allowRecords,
  formatAllows,
  listAllows,
  type AllowRecord,
} from "./allows.js";
import { formatFindings, hasError, lintRefusal, type Finding } from "./lint.js";
import { formatAdvice, type IgnoreReport } from "./schema-rules.js";
import { sessionFailure } from "./lost.js";
import { guardStoredDriverUrl } from "./policy.js";
import { protectedStorePath } from "./protected-store.js";
import { asProject, projectContext, projectPath, type ProjectContext } from "./paths.js";
import { listTargets, selectTarget, type InvokeFlags } from "./policy.js";
import {
  buildProject,
  checkProject,
  exportProject,
  generateProject,
  loadConfig,
} from "./project.js";

/** Where a command reads the project and writes its text. */
export type CommandIo = {
  readonly cwd?: string;
  readonly stdout?: (text: string) => void;
};

/** What one command produced. Human text is already written when `json` is false. */
type Produced = {
  readonly text: string;
  readonly data: unknown;
  readonly warnings: readonly CliWarning[];
  readonly outFile: CliOutFile | null;
};

/**
 * Text `okm` writes for a failure.
 *
 * The message includes a source location when the schema recorded one.
 *
 * @param error - Failure from a command
 * @param verbose - When true, append the stack
 * @returns The stderr text, including the trailing newline
 */
export function formatFailure(error: unknown, verbose = false): string {
  const mapped = sessionFailure(error) ?? OkmError.from(error);
  let text = `error ${mapped.code}: ${mapped.message}\n${mapped.fix.summary}\n`;
  if (typeof error === "object" && error !== null) {
    const configPath = readConfigPath(error);
    if (configPath !== undefined) text += `config: ${configPath}\n`;
  }
  if (verbose && error instanceof Error && error.stack !== undefined) {
    text += `${error.stack}\n`;
  }
  return text;
}

/**
 * Runs one `okm` invocation.
 *
 * `--version` and `--help` are handled here. A failure throws. In `--json`
 * mode the throw is {@link CommandFinished} after the envelope is written.
 *
 * @param argv - Arguments after the program name
 * @param io - Working directory and stdout. Defaults to the process
 */
export async function run(argv: readonly string[], io?: CommandIo): Promise<void> {
  const stdout = io?.stdout ?? ((text: string) => process.stdout.write(text));
  const cwd = io?.cwd ?? process.cwd();
  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    finish(error, argvHasJson(argv), null, stdout);
    return;
  }
  const version = packageVersion();
  if (parsed.version) {
    writeVersion(parsed, version, stdout);
    return;
  }
  if (parsed.help || parsed.spec === undefined) {
    const text = parsed.spec === undefined ? commandsTable() : helpText(parsed.spec);
    writeDocument(parsed, version, stdout, text, { help: text });
    return;
  }
  try {
    const reportConfig = io?.stdout === undefined && !parsed.json;
    const body = (): Promise<Produced> => dispatch(parsed, cwd, stdout, reportConfig);
    const collected = parsed.json
      ? await collectNotices(body)
      : { result: await body(), notices: [] };
    const produced = collected.result;
    const warnings = [
      ...produced.warnings,
      ...collected.notices.map((notice) => ({ summary: notice.summary })),
    ];
    if (!parsed.json) return;
    const placed = place(produced, parsed, cwd);
    const target = await selectedTarget(parsed, cwd);
    stdout(
      serializeEnvelope(
        envelope({
          command: parsed.command,
          okmVersion: version,
          exit: 0,
          ...(target === undefined ? {} : { target }),
          data: placed.data,
          warnings,
          outFile: placed.outFile,
        }),
      ),
    );
  } catch (error) {
    if (error instanceof CommandFinished) throw error;
    const partial = readPartial(error);
    const target = partial?.target ?? (await selectedTarget(parsed, cwd));
    finish(error, parsed.json, parsed.command, stdout, {
      ...(partial ?? { data: {}, warnings: [], outFile: null }),
      ...(target === undefined ? {} : { target }),
    });
  }
}

function writeVersion(parsed: ParsedCli, version: string, stdout: (text: string) => void): void {
  if (!parsed.json) {
    stdout(`${version}\n`);
    return;
  }
  stdout(
    serializeEnvelope(
      envelope({
        command: null,
        okmVersion: version,
        exit: 0,
        data: { version },
      }),
    ),
  );
}

function writeDocument(
  parsed: ParsedCli,
  version: string,
  stdout: (text: string) => void,
  text: string,
  data: unknown,
): void {
  if (!parsed.json) {
    stdout(text);
    return;
  }
  stdout(
    serializeEnvelope(
      envelope({
        command: parsed.command,
        okmVersion: version,
        exit: 0,
        data,
      }),
    ),
  );
}

function finish(
  error: unknown,
  json: boolean,
  command: string | null,
  stdout: (text: string) => void,
  partial?: {
    readonly data: unknown;
    readonly warnings: readonly CliWarning[];
    readonly outFile: CliOutFile | null;
    readonly target?: CliTarget;
  },
): never {
  if (!json) throw error;
  const body = partial ?? { data: {}, warnings: [], outFile: null };
  stdout(
    serializeEnvelope(
      envelope({
        command,
        okmVersion: packageVersion(),
        exit: exitCodeFor(error),
        ...(body.target === undefined ? {} : { target: body.target }),
        data: body.data,
        errors: [errorBody(error)],
        warnings: body.warnings,
        outFile: body.outFile,
      }),
    ),
  );
  throw new CommandFinished(exitCodeFor(error), terseStderr(error, process.stderr.isTTY === true));
}

function packageVersion(): string {
  return readPackageVersion();
}

async function dispatch(
  parsed: ParsedCli,
  cwd: string,
  stdout: (text: string) => void,
  reportConfig: boolean,
): Promise<Produced> {
  const spec = parsed.spec;
  if (spec === undefined) return empty("");
  const project = projectContext(cwd, parsed.config);
  const announce = announcesConfig(spec.id, parsed.operands[0]) && !parsed.bundle;
  const human = (text: string): void => {
    if (parsed.json) return;
    stdout(text);
  };
  try {
    const produced = await route(spec.id, project, parsed, cwd, human);
    if (reportConfig && announce && project.ambiguous === undefined) {
      process.stderr.write(`config: ${project.configPath}\n`);
    }
    return produced;
  } catch (error) {
    if (
      announce &&
      project.ambiguous === undefined &&
      typeof error === "object" &&
      error !== null
    ) {
      throw tagConfigPath(error, project.configPath);
    }
    throw error;
  }
}

async function route(
  id: string,
  project: ProjectContext,
  parsed: ParsedCli,
  cwd: string,
  human: (text: string) => void,
): Promise<Produced> {
  if (id === "build") return build(project, human);
  if (id === "catalog export") return catalog(project, parsed, cwd, human);
  if (id === "check") return check(project, parsed, human);
  if (id === "dev") return dev(project, human);
  if (id === "doctor") {
    if (parsed.bundle) return doctorBundle(project, parsed, cwd, human);
    return parsed.production
      ? doctorProduction(project, parsed, human)
      : doctor(project, parsed, human);
  }
  if (id === "driver test") return driver(parsed, human);
  if (id === "ext list" || id === "ext check") return extRead(project, id, parsed, human);
  if (id === "ext scaffold") return extScaffoldCommand(project, parsed, cwd, human);
  if (id === "ext test") return extTestCommand(project, parsed, human);
  if (id === "generate") return generate(project, parsed, human);
  if (id === "init") {
    const { initCommand } = await import("../init/command.js");
    return initCommand(parsed, cwd, human);
  }
  if (id === "agents status" || id === "agents update" || id === "agents remove") {
    const { agentsCommand } = await import("../agents/command.js");
    return agentsCommand(parsed, cwd, human);
  }
  if (id === "import drizzle") return drizzle(project, parsed, human);
  if (id === "migrate plan") return planCommand(project, parsed, human);
  if (id === "migrate apply") return applyCommand(project, parsed, human);
  if (id === "migrate status") return statusCommand(project, parsed, human);
  if (id === "migrate resolve") return resolveCommand(project, parsed, human);
  if (id === "migrate check") return migrateCheck(project, parsed, human);
  if (id === "migrate baseline") return baselineCommand(project, parsed, human);
  if (id === "push") return push(project, parsed, human);
  if (id === "raw sync") return rawSync(project, parsed, human);
  if (id === "pull") return pull(project, parsed, human);
  if (id === "seed") return seed(project, parsed, human);
  if (id === "protect add") return protectAdd(project, parsed, human);
  if (id === "protect remove") return protectRemove(project, parsed, human);
  if (id === "protect list") return protectList(human);
  if (id === "schema") return schemaCommand(parsed, human);
  throw tagOutcome(new OkmError("invalid", `Unknown command ${id}.`), "usage");
}

/**
 * Whether human output should name the config file this command loads.
 *
 * `okm init` names the files it writes. A doctor code, schema, and driver
 * test do not load a project config.
 *
 * @param id - Command id
 * @param operand - First operand, when the command has one
 * @returns `true` when the resolved path is printed
 */
function announcesConfig(id: string, operand: string | undefined): boolean {
  if (
    id === "init" ||
    id === "schema" ||
    id === "driver test" ||
    id === "protect list" ||
    id.startsWith("agents ")
  ) {
    return false;
  }
  if (id === "doctor" && operand !== undefined) return false;
  return true;
}

async function build(project: ProjectContext, human: (text: string) => void): Promise<Produced> {
  const built = await buildProject(project);
  let text = "";
  if (built.emulation.length > 0) text += built.emulation;
  text += `${built.directory}\n`;
  human(text);
  const data: { directory: string; emulation?: string } = { directory: built.directory };
  if (built.emulation.length > 0) data.emulation = built.emulation;
  return { text, data, warnings: [], outFile: null };
}

async function catalog(
  project: ProjectContext,
  parsed: ParsedCli,
  cwd: string,
  human: (text: string) => void,
): Promise<Produced> {
  if (parsed.out !== undefined && parsed.out !== "-") {
    const written = await exportProject(project, ["--out", parsed.out]);
    const path = isAbsolute(parsed.out) ? parsed.out : join(cwd, parsed.out);
    const bytes = statSync(path).size;
    human(written);
    if (!parsed.json) return { text: written, data: {}, warnings: [], outFile: null };
    return { text: written, data: {}, warnings: [], outFile: { path: parsed.out, bytes } };
  }
  const snapshot = await exportProject(project, []);
  human(snapshot);
  if (!parsed.json) return { text: snapshot, data: {}, warnings: [], outFile: null };
  const bytes = Buffer.byteLength(snapshot);
  const data: unknown = JSON.parse(snapshot);
  if (parsed.out === "-") {
    return { text: snapshot, data, warnings: [], outFile: { path: "-", bytes } };
  }
  return { text: snapshot, data, warnings: [], outFile: null };
}

async function rawSync(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { runRawSync } = await import("../describe/command.js");
  const result = await runRawSync(project, parsed.check, invokeOf(parsed));
  const text = result.unchanged
    ? "ok\n"
    : `${result.lock}\n${String(result.statements)} statements\n`;
  human(text);
  return { text, data: result, warnings: [], outFile: null };
}

async function check(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const checked = await checkProject(project, invokeOf(parsed));
  let text = "";
  if (checked.emulation !== undefined) text += checked.emulation;
  if (checked.notice !== undefined) text += checked.notice;
  text += formatFindings(checked.findings);
  text += formatAllows(checked.allows);
  text += formatAdvice(checked.advice ?? []);
  const listed = checked.ignores ?? [];
  for (const item of listed) text += `${ignoreLine(item)}\n`;
  text += "ok\n";
  human(text);
  const data: {
    status: "ok";
    notice?: string;
    emulation?: string;
    ignores?: readonly {
      readonly rule: string;
      readonly reason: ReturnType<typeof untrustedText>;
      readonly target?: string;
      readonly status?: "applied" | "stale";
    }[];
    allows: readonly AllowRecord[];
  } = { status: "ok", allows: allowRecords(checked.allows) };
  if (checked.notice !== undefined) data.notice = checked.notice;
  if (checked.emulation !== undefined) data.emulation = checked.emulation;
  if (listed.length > 0) {
    data.ignores = listed.map((item) => ({
      rule: item.rule,
      reason: untrustedText(item.reason, "user.query"),
      ...(item.target !== undefined ? { target: item.target } : {}),
      ...(item.status !== undefined ? { status: item.status } : {}),
    }));
  }
  return {
    text,
    data,
    warnings: [
      ...warningsOf(checked.findings),
      ...(checked.advice ?? []).map((item) =>
        warningBody({
          code: item.code,
          summary: item.reason,
          place: item.target,
          fix: item.fix,
          level: item.level === "hint" ? "hint" : "warn",
          severity: item.severity,
          ...(item.location !== undefined ? { location: item.location } : {}),
        }),
      ),
      ...listed.map((item) =>
        warningBody({
          summary:
            item.status === "stale"
              ? "A project ignore matched nothing."
              : "A project rule is ignored.",
          place: item.target === undefined ? item.rule : `${item.rule} ${item.target}`,
          level: item.status === "stale" ? "warn" : "hint",
          severity: "low",
        }),
      ),
    ],
    outFile: null,
  };
}

function ignoreLine(item: IgnoreReport): string {
  const head = item.target === undefined ? item.rule : `${item.rule} ${item.target}`;
  const stale = item.status === "stale" ? " (stale: matched nothing)" : "";
  return `ignore ${head}${stale}: ${renderUntrusted(untrustedText(item.reason, "user.query"))}`;
}

async function dev(project: ProjectContext, human: (text: string) => void): Promise<Produced> {
  const { devProject } = await import("./dev.js");
  const text = await devProject(project);
  human(text);
  return textData(text);
}

async function doctor(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const code = parsed.operands[0];
  const { doctorProject } = await import("./doctor.js");
  const text = await doctorProject(project, code, invokeOf(parsed));
  human(text);
  if (code === undefined) return textData(text);
  const doc = errorDoc(code);
  if (doc === undefined) return textData(text);
  return {
    text,
    data: {
      code: doc.code,
      title: doc.title,
      summary: doc.summary,
      fix: doc.fix,
      ...(doc.safeAlternatives !== undefined && doc.safeAlternatives.length > 0
        ? { safeAlternatives: doc.safeAlternatives }
        : {}),
      docs: `docs/errors/${doc.code}.md`,
      ...(doc.escapeHatches !== undefined && doc.escapeHatches.length > 0
        ? { escapeHatches: doc.escapeHatches }
        : {}),
    },
    warnings: [],
    outFile: null,
  };
}

async function doctorProduction(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const {
    doctorProduction: inspect,
    formatReport,
    PRODUCTION_FAILED_CODE,
  } = await import("./doctor-production.js");
  const report = await inspect(project, invokeOf(parsed));
  const text = formatReport(report);
  human(text);
  const data = { production: report };
  const warnings = report.findings
    .filter((item) => item.severity !== "ok")
    .map((item) =>
      warningBody({
        ...(item.code === undefined ? {} : { code: item.code }),
        summary: item.summary,
        place: item.id,
        fix: item.fix,
        level: "warn",
        severity: item.severity === "fail" ? "high" : "medium",
      }),
    );
  if (report.summary.fail > 0) {
    throw attachPartial(
      new OkmError(
        PRODUCTION_FAILED_CODE,
        `${String(report.summary.fail)} production finding(s) failed on target \`${report.target}\`.`,
        { fix: { summary: "Fix each fail finding, then run okm doctor --production again." } },
      ),
      { data, warnings, outFile: null },
    );
  }
  return { text, data, warnings, outFile: null };
}

async function doctorBundle(
  project: ProjectContext,
  parsed: ParsedCli,
  cwd: string,
  human: (text: string) => void,
): Promise<Produced> {
  const { bundleText, collectBundle, DEFAULT_BUNDLE_PATH, writeBundle } =
    await import("./doctor-bundle.js");
  const bundle = await collectBundle(project);
  const text = bundleText(bundle);
  const bytes = Buffer.byteLength(text);
  const data = { bundle };
  if (parsed.out === "-") {
    human(text);
    return { text, data, warnings: [], outFile: { path: "-", bytes } };
  }
  const shown = parsed.out ?? DEFAULT_BUNDLE_PATH;
  const base = parsed.out === undefined ? project.cwd : cwd;
  writeBundle(resolve(base, shown), shown, text, parsed.overwrite);
  const said = `wrote ${shown} (${String(bytes)} bytes)\nNo network was used. The file holds codes, versions, and hashes, and no values. Read it before you send it.\n`;
  human(said);
  return { text: said, data, warnings: [], outFile: { path: shown, bytes } };
}

async function driver(parsed: ParsedCli, human: (text: string) => void): Promise<Produced> {
  if (parsed.url !== undefined) guardStoredDriverUrl(parsed.url);
  const { driverTest } = await import("../driver-test.js");
  const args = [parsed.operands[0] ?? ""];
  if (parsed.url !== undefined) args.push("--url", parsed.url);
  let text = "";
  await driverTest(args, (chunk) => {
    text += chunk;
  });
  human(text);
  return textData(text);
}

async function extRead(
  project: ProjectContext,
  id: string,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { extProject } = await import("./ext.js");
  const sub = id === "ext list" ? "list" : "check";
  const text = await extProject(project, sub, invokeOf(parsed));
  human(text);
  return textData(text);
}

async function extScaffoldCommand(
  project: ProjectContext,
  parsed: ParsedCli,
  cwd: string,
  human: (text: string) => void,
): Promise<Produced> {
  const { extScaffold } = await import("./ext.js");
  const name = parsed.operands[0] ?? "";
  const out = parsed.out === "-" ? undefined : parsed.out;
  const text = await extScaffold(project, name, invokeOf(parsed), out);
  human(text);
  if (parsed.out === undefined) return textData(text);
  if (parsed.out === "-") {
    return {
      text,
      data: { text },
      warnings: [],
      outFile: { path: "-", bytes: Buffer.byteLength(text) },
    };
  }
  const path = isAbsolute(parsed.out) ? parsed.out : join(cwd, parsed.out);
  return {
    text,
    data: { text },
    warnings: [],
    outFile: { path: parsed.out, bytes: statSync(path).size },
  };
}

async function extTestCommand(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { extTest } = await import("./ext.js");
  const text = await extTest(project, parsed.operands[0] ?? "", invokeOf(parsed));
  human(text);
  return textData(text);
}

async function generate(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const written = await generateProject(project, parsed.operands[0] ?? "migration", parsed.replace);
  if (written === undefined) {
    human("no changes\n");
    return { text: "no changes\n", data: { path: null }, warnings: [], outFile: null };
  }
  const findings = formatFindings(written.findings);
  human(`${written.path}\n`);
  human(findings);
  const warnings = warningsOf(written.findings);
  if (hasError(written.findings)) {
    throw attachPartial(
      new OkmError("OKM1510", findings.trim(), {
        fix: { summary: "okm migrate apply will refuse until it is fixed." },
      }),
      { data: { path: written.path }, warnings, outFile: null },
    );
  }
  return {
    text: `${written.path}\n${findings}`,
    data: { path: written.path },
    warnings,
    outFile: null,
  };
}

async function drizzle(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { importDrizzle } = await import("./import-drizzle.js");
  const args = [parsed.operands[0] ?? ""];
  if (parsed.out !== undefined) args.push("--out", parsed.out);
  const text = (await importDrizzle(project.cwd, args)).text;
  human(text);
  return textData(text);
}

async function planCommand(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { plan } = await import("./api.js");
  const planned = await plan(parsed.operands[0] ?? "", {
    cwd: project.cwd,
    config: project.configPath,
    ...invokeOf(parsed),
    ...(parsed.replace.length > 0 ? { replace: parsed.replace } : {}),
  });
  const document: unknown = JSON.parse(planned.json);
  const findings = formatFindings(planned.lint);
  const text = `${planned.text}${findings}`;
  human(planned.text);
  human(findings);
  const warnings = warningsOf(planned.lint);
  if (hasError(planned.lint)) {
    throw attachPartial(lintRefusal(planned.lint), { data: document, warnings, outFile: null });
  }
  return { text, data: document, warnings, outFile: null };
}

async function applyCommand(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { apply } = await import("./api.js");
  let progress = "";
  const result = await apply({
    cwd: project.cwd,
    config: project.configPath,
    ...invokeOf(parsed),
    onProgress: (chunk) => {
      progress += chunk;
      human(chunk);
    },
  });
  human(result.text);
  return textData(`${progress}${result.text}`);
}

async function statusCommand(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { formatStatus, statusProjectRows } = await import("./status.js");
  const rows = await statusProjectRows(project, invokeOf(parsed));
  const text = formatStatus(rows);
  human(text);
  return {
    text,
    data: {
      text,
      steps: rows.flatMap((row) =>
        row.steps.map((step) => ({
          id: untrustedText(step.id, "db.object-name"),
          kind: untrustedText(step.kind, "db.object-name"),
          state: untrustedText(step.state, "db.object-name"),
          attempt: step.attempt,
          nextAction: step.nextAction,
        })),
      ),
    },
    warnings: [],
    outFile: null,
  };
}

async function resolveCommand(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { formatResolve, resolveProject } = await import("./resolve.js");
  const result = await resolveProject(project, {
    ...invokeOf(parsed),
    applied: parsed.applied,
    retry: parsed.retry,
    acceptUnverified: parsed.acceptUnverified,
    step: parsed.operands[0] ?? "",
  });
  const text = formatResolve(result);
  human(text);
  return { text, data: result, warnings: [], outFile: null };
}

async function migrateCheck(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { checkMigrations } = await import("./check.js");
  const checked = await checkMigrations(project, invokeOf(parsed), {
    provision: parsed.provision,
  });
  const { cwd } = asProject(project);
  const config = await loadConfig(project);
  const allows = listAllows(projectPath(cwd, config.migrations ?? "migrations"));
  const findings = allowFindings(allows);
  const text = `${checked}${formatFindings(findings)}${formatAllows(allows)}`;
  human(text);
  return {
    text,
    data: { text, allows: allowRecords(allows) },
    warnings: warningsOf(findings),
    outFile: null,
  };
}

async function baselineCommand(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { baselineProject } = await import("./baseline.js");
  const flags = {
    ...invokeOf(parsed),
    dryRun: parsed.dryRun,
    json: parsed.json,
  };
  const text = await baselineProject(project, flags);
  if (!parsed.json) {
    human(text);
    return { text, data: {}, warnings: [], outFile: null };
  }
  return { text, data: JSON.parse(text) as unknown, warnings: [], outFile: null };
}

async function push(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { pushProject } = await import("./apply.js");
  const text = await pushProject(project, invokeOf(parsed));
  human(text);
  return textData(text);
}

async function pull(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { pullProject } = await import("./pull.js");
  const args: string[] = [];
  if (parsed.target !== undefined) args.push("--target", parsed.target);
  if (parsed.allowProtected) args.push("--allow-protected");
  if (parsed.out !== undefined) args.push("--out", parsed.out);
  for (const name of parsed.schemas) args.push("--schema", name);
  const text = (await pullProject(project, args)).text;
  human(text);
  return textData(text);
}

async function protectAdd(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { addProtectedTarget } = await import("./protect.js");
  const data = await addProtectedTarget(project, parsed.target, protectedStorePath());
  const text = `protected ${data.hostDb}\n`;
  human(text);
  return { text, data, warnings: [], outFile: null };
}

async function protectRemove(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { removeProtectedTarget } = await import("./protect.js");
  const data = await removeProtectedTarget(
    project,
    parsed.target,
    protectedStorePath(),
    process.stdin.isTTY === true,
  );
  const text = `${data.removed ? "removed" : "absent"} ${data.hostDb}\n`;
  human(text);
  return { text, data, warnings: [], outFile: null };
}

async function protectList(human: (text: string) => void): Promise<Produced> {
  const { listProtectedTargets } = await import("./protect.js");
  const data = listProtectedTargets(protectedStorePath());
  const lines = data.fingerprints.map((item) => item.hostDb);
  const text = lines.length === 0 ? "none\n" : `${lines.join("\n")}\n`;
  human(text);
  return { text, data, warnings: [], outFile: null };
}

async function seed(
  project: ProjectContext,
  parsed: ParsedCli,
  human: (text: string) => void,
): Promise<Produced> {
  const { seedProject } = await import("./seed.js");
  const text = await seedProject(project, parsed.operands[0] ?? "", invokeOf(parsed));
  human(text);
  return textData(text);
}

function schemaCommand(parsed: ParsedCli, human: (text: string) => void): Produced {
  const name = parsed.operands.join(" ");
  if (!schemaCommands().includes(name)) {
    const hint = nearestName(name, schemaCommands());
    const fix = hint === undefined ? "Pass a command from okm --help." : `Did you mean ${hint}?`;
    throw tagOutcome(
      new OkmError("invalid", `Unknown command ${name}.`, {
        fix: hint === undefined ? { summary: fix } : { summary: fix, suggestion: hint },
      }),
      "usage",
    );
  }
  const text = schemaText(name);
  human(text);
  return { text, data: schemaFor(name), warnings: [], outFile: null };
}

function textData(text: string): Produced {
  return { text, data: { text }, warnings: [], outFile: null };
}

function empty(text: string): Produced {
  return { text, data: {}, warnings: [], outFile: null };
}

function warningsOf(findings: readonly Finding[]): readonly CliWarning[] {
  const warnings: CliWarning[] = [];
  for (const finding of findings) {
    if (finding.severity !== "warning") continue;
    const preference =
      finding.code === "OKM1539" ||
      finding.code === "OKM1540" ||
      finding.code === "OKM1543" ||
      finding.code === "OKM1544" ||
      finding.code === "OKM1545";
    warnings.push(
      warningBody({
        code: finding.code,
        summary: finding.reason,
        place: finding.place,
        fix: finding.fix,
        level: "warn",
        severity: preference ? "low" : "medium",
        ...(finding.place.startsWith("step ") ? { location: { step: finding.place } } : {}),
      }),
    );
  }
  return warnings;
}

function invokeOf(parsed: ParsedCli): InvokeFlags {
  return {
    ...(parsed.target !== undefined ? { target: parsed.target } : {}),
    allowProtected: parsed.allowProtected,
    allowPooler: parsed.allowPooler,
    ...(parsed.lockTimeoutMs !== undefined ? { lockTimeoutMs: parsed.lockTimeoutMs } : {}),
    ...(parsed.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: parsed.statementTimeoutMs }
      : {}),
  };
}

function place(
  produced: Produced,
  parsed: ParsedCli,
  cwd: string,
): { readonly data: unknown; readonly outFile: CliOutFile | null } {
  if (produced.outFile !== null) return { data: produced.data, outFile: produced.outFile };
  if (!parsed.json || parsed.out === undefined || parsed.spec?.ownOut) {
    return { data: produced.data, outFile: null };
  }
  const payload = `${JSON.stringify(produced.data)}\n`;
  const bytes = Buffer.byteLength(payload);
  if (parsed.out === "-") return { data: produced.data, outFile: { path: "-", bytes } };
  const path = isAbsolute(parsed.out) ? parsed.out : join(cwd, parsed.out);
  writeFileSync(path, payload);
  return { data: {}, outFile: { path: parsed.out, bytes } };
}

async function selectedTarget(parsed: ParsedCli, cwd: string): Promise<CliTarget | undefined> {
  if (parsed.spec?.usesDatabase !== true) return undefined;
  if (parsed.spec.id === "doctor" && (parsed.operands.length > 0 || parsed.bundle))
    return undefined;
  try {
    const project = projectContext(cwd, parsed.config);
    const config = await loadConfig(project);
    const targets = listTargets(config);
    if (targets.length === 0) return undefined;
    if (parsed.spec.id === "dev") {
      const devTarget = targets.find((item) => item.name === "dev");
      return devTarget === undefined ? undefined : targetFingerprint(devTarget);
    }
    if (
      parsed.spec.id === "migrate status" &&
      parsed.target === undefined &&
      targets.length !== 1
    ) {
      return undefined;
    }
    if (parsed.target === undefined && targets.length !== 1) return undefined;
    return targetFingerprint(selectTarget(config, parsed.target));
  } catch {
    return undefined;
  }
}
