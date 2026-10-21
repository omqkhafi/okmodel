/**
 * Plans for the agent files: what each file is, and what a run would do.
 *
 * Nothing here writes. {@link planAgents} reads the project and returns the
 * states, the actions, a diff for each change, and the exact writes
 * {@link applyAgents} will perform. `--dry-run` prints the same plan an
 * apply executes.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { canonicalHash, type Canonical } from "../canonical-json.js";
import { contentHash, lf, textDiff } from "../init/engine.js";
import { renderAgentsBlock, renderImportBlock } from "./block.js";
import {
  AGENTS_FILE,
  AGENT_TARGETS,
  CLAUDE_FILE,
  RECORD_FILE,
  SKILL_DIRS,
  TOOL_DIRS,
  agentsAllowlist,
  readAgentFile,
  shippedSkill,
  skillPathOf,
  type AgentTarget,
  type SkillFile,
} from "./files.js";
import type { AgentState } from "./guards.js";
import { findBlock, hasImportLine, insertBlock, removeBlock, replaceBlock } from "./markers.js";
import { readAgentsRecord, withAgentsRecord, type AgentsRecord } from "./record.js";

/** What a run is for. `status` never plans a write. */
export type AgentsMode = "status" | "install" | "update" | "remove";

/** Which part of the setup a file is. */
export type AgentKind = "block" | "import" | "skill" | "record";

/** What a run does to one file. */
export type AgentAction = "none" | "create" | "insert" | "update" | "remove" | "delete" | "skip";

/** One file in a plan or a status report. */
export type AgentFileData = {
  readonly path: string;
  readonly kind: AgentKind;
  readonly state: AgentState;
  readonly action: AgentAction;
  readonly diff?: string;
};

/** JSON `data` for a plan: `okm agents update`, `okm agents remove`, and the init section. */
export type AgentsData = {
  readonly status: "planned" | "applied" | "unchanged";
  readonly files: readonly AgentFileData[];
  readonly planHash: string;
};

/** One file a run writes. `after` is `null` for a delete. */
export type AgentsWrite = {
  readonly path: string;
  readonly kind: AgentKind;
  readonly action: AgentAction;
  readonly before: string | undefined;
  readonly after: string | null;
};

/** A computed plan. `writes` is empty when nothing changes. */
export type AgentsPlan = {
  readonly root: string;
  readonly mode: AgentsMode;
  readonly data: AgentsData;
  readonly writes: readonly AgentsWrite[];
  /** The section stored in `.okm/init.json`. `undefined` when none is written. */
  readonly record: AgentsRecord | undefined;
  /** Existing files the plan changes. Those need a yes. */
  readonly consent: readonly string[];
  readonly allowed: ReadonlySet<string>;
  readonly lines: readonly string[];
  readonly warnings: readonly { readonly summary: string }[];
};

/** JSON `data` for `okm agents status`. */
export type AgentsStatusData = {
  readonly status: "current" | "drifted" | "declined";
  readonly files: readonly {
    readonly path: string;
    readonly kind: AgentKind;
    readonly state: AgentState;
  }[];
};

/** Facts the block prints. A missing one keeps the recorded value. */
export type AgentsFacts = {
  readonly tenancy?: string;
  readonly protectedConfigured?: boolean;
};

/** Inputs to {@link planAgents}. */
export type AgentsInput = {
  readonly root: string;
  readonly mode: Exclude<AgentsMode, "status">;
  readonly version: string;
  /** Skill targets the caller named. Only `install` reads them. */
  readonly targets?: readonly AgentTarget[];
  readonly facts?: AgentsFacts;
};

const PLAIN_IMPORT = "@AGENTS.md\n";

type Entry = {
  readonly path: string;
  readonly kind: "block" | "import" | "skill";
  readonly state: AgentState;
  readonly before: string | undefined;
  readonly region?: ReturnType<typeof findBlock>;
  readonly desired: string | undefined;
  readonly orphan: boolean;
  readonly linked: boolean;
};

type Survey = {
  readonly record: AgentsRecord | undefined;
  readonly recordText: string | undefined;
  readonly targets: readonly AgentTarget[];
  readonly allowed: ReadonlySet<string>;
  readonly facts: { readonly tenancy: string; readonly protectedConfigured: boolean };
  readonly entries: readonly Entry[];
};

/**
 * Reads the project and reports each agent file's state.
 *
 * @param root - Project directory
 * @param version - Package version the block and the markers carry
 * @returns The report, and a warning when `CLAUDE.local.md` exists
 */
export function statusAgents(
  root: string,
  version: string,
): {
  readonly data: AgentsStatusData;
  readonly warnings: readonly { readonly summary: string }[];
  readonly lines: readonly string[];
} {
  const found = survey({ root, mode: "update", version });
  const declined = found.record?.choice === "no";
  const entries = declined
    ? found.entries.filter((item) => item.state !== "missing")
    : found.entries;
  const files = entries.map((item) => ({ path: item.path, kind: item.kind, state: item.state }));
  const drifted = files.some((file) => file.state !== "current");
  const warnings: { readonly summary: string }[] = [];
  if (existsSync(join(root, "CLAUDE.local.md"))) {
    warnings.push({
      summary:
        "CLAUDE.local.md exists. From Claude Code 2.1.277 it stops Claude Code from reading AGENTS.md natively, so the @AGENTS.md import in CLAUDE.md is what loads the block.",
    });
  }
  const status = drifted ? "drifted" : declined && files.length === 0 ? "declined" : "current";
  const lines = [
    ...files.map((file) => `${file.path}: ${file.state}`),
    ...(files.length === 0 ? ["agent files: declined"] : []),
    ...warnings.map((warning) => warning.summary),
  ];
  return { data: { status, files }, warnings, lines };
}

/**
 * Plans an install, an update, or a removal.
 *
 * @param input - Project, mode, version, and the choices that apply
 * @returns The plan. `writes` is empty when nothing changes
 * @throws OkmError OKM1882 or OKM1883 for a damaged or repeated marker, and
 * OKM1885 or OKM1886 when content or a path is refused
 */
export function planAgents(input: AgentsInput): AgentsPlan {
  const found = survey(input);
  const installed =
    input.mode !== "update" ||
    found.record?.choice === "yes" ||
    found.entries.some((item) => item.region !== undefined);
  const created = new Set(found.record?.created ?? []);
  const files: AgentFileData[] = [];
  const writes: AgentsWrite[] = [];
  const hashes: Record<string, string> = {};
  const warnings: { readonly summary: string }[] = [];
  const items: Canonical[] = [];
  for (const item of found.entries) {
    const step = installed
      ? decide(input.mode, item, created, found.record)
      : { action: "none" as const, after: undefined, shown: undefined };
    const shown = step.shown;
    const diff = shown === undefined ? "" : textDiff(item.path, shown.before, shown.after);
    files.push({
      path: item.path,
      kind: item.kind,
      state: item.state,
      action: step.action,
      ...(diff.length === 0 ? {} : { diff }),
    });
    if (step.action === "skip") {
      warnings.push({
        summary: `${item.path} was edited, so okm left it as it is. Restore it, or delete it and run okm agents update.`,
      });
    }
    if (step.after !== undefined) {
      writes.push({
        path: item.path,
        kind: item.kind,
        action: step.action,
        before: item.before,
        after: step.after,
      });
      if (step.action === "create" && item.kind !== "skill") created.add(item.path);
    }
    if (input.mode !== "remove") collectHash(hashes, item, step.action, found.record);
    items.push({
      path: item.path,
      state: item.state,
      action: step.action,
      before: item.before === undefined ? "" : contentHash(item.before),
      after: step.after === undefined ? "" : step.after === null ? "-" : contentHash(step.after),
    });
  }
  const skills = writes.filter((write) => write.kind === "skill");
  const docs = writes.filter((write) => write.kind !== "skill");
  const order = input.mode === "remove" ? [...docs.reverse(), ...skills] : [...skills, ...docs];
  const record = installed
    ? nextRecord(input, found, hashes, [...created].sort(), writes.length > 0)
    : undefined;
  const recordWrite = recordStep(found, record);
  if (recordWrite !== undefined) {
    files.push({
      path: RECORD_FILE,
      kind: "record",
      state: recordWrite.before === undefined ? "missing" : "stale",
      action: recordWrite.action,
    });
    items.push({
      path: RECORD_FILE,
      state: recordWrite.before === undefined ? "missing" : "stale",
      action: recordWrite.action,
      before: recordWrite.before === undefined ? "" : contentHash(recordWrite.before),
      after: contentHash(recordWrite.after ?? ""),
    });
  }
  const all = recordWrite === undefined ? order : [...order, recordWrite];
  const planHash = canonicalHash({ mode: input.mode, items });
  const consent = writes.filter((write) => write.before !== undefined).map((write) => write.path);
  const data: AgentsData = {
    status: all.length === 0 ? "unchanged" : "planned",
    files,
    planHash,
  };
  return {
    root: input.root,
    mode: input.mode,
    data,
    writes: all,
    record: all.length === 0 ? undefined : record,
    consent,
    allowed: found.allowed,
    lines: renderLines(data, installed),
    warnings,
  };
}

/**
 * Plans the record that says this project does not want agent files.
 *
 * @param root - Project directory
 * @returns A plan whose only write is the record, or an empty plan when it already says so
 */
export function planDecline(root: string): AgentsPlan {
  const allowed = new Set([RECORD_FILE]);
  const recordText = readAgentFile(root, RECORD_FILE, allowed);
  const existing = readAgentsRecord(recordText);
  const record: AgentsRecord = { choice: "no" };
  const next = withAgentsRecord(recordText, record);
  const unchanged =
    existing?.choice === "no" &&
    existing.files !== undefined &&
    Object.keys(existing.files).length === 0;
  const write: AgentsWrite = {
    path: RECORD_FILE,
    kind: "record",
    action: recordText === undefined ? "create" : "update",
    before: recordText,
    after: next,
  };
  const file: AgentFileData = {
    path: RECORD_FILE,
    kind: "record",
    state: recordText === undefined ? "missing" : "stale",
    action: write.action,
  };
  const data: AgentsData = {
    status: unchanged ? "unchanged" : "planned",
    files: unchanged ? [] : [file],
    planHash: canonicalHash({
      mode: "decline",
      before: recordText === undefined ? "" : contentHash(recordText),
      after: contentHash(next),
    }),
  };
  return {
    root,
    mode: "install",
    data,
    writes: unchanged ? [] : [write],
    record: unchanged ? undefined : record,
    consent: [],
    allowed,
    lines: unchanged ? [] : ["agent files: declined, recorded in .okm/init.json"],
    warnings: [],
  };
}

/**
 * Whether the project has a directory that selects a skill target.
 *
 * @param root - Project directory
 * @returns Targets whose tool directory exists
 */
export function detectedTargets(root: string): readonly AgentTarget[] {
  return AGENT_TARGETS.filter((target) => isDirectory(join(root, TOOL_DIRS[target])));
}

function survey(input: {
  readonly root: string;
  readonly mode: AgentsMode;
  readonly version: string;
  readonly targets?: readonly AgentTarget[];
  readonly facts?: AgentsFacts;
}): Survey {
  const { root } = input;
  const recordText = readAgentFile(root, RECORD_FILE, new Set([RECORD_FILE]));
  const record = readAgentsRecord(recordText);
  const targets = chooseTargets(root, input.mode, record, input.targets);
  const skill = shippedSkill();
  const recorded = Object.keys(record?.files ?? {}).filter(
    (path) => skillPathOf(path) !== undefined,
  );
  const allowed = agentsAllowlist(skill, targets, recorded);
  const facts = {
    tenancy: input.facts?.tenancy ?? record?.tenancy ?? "none",
    protectedConfigured: input.facts?.protectedConfigured ?? record?.protected ?? false,
  };
  const desiredBlock = renderAgentsBlock({
    version: input.version,
    tenancy: facts.tenancy,
    protectedConfigured: facts.protectedConfigured,
  });
  const entries: Entry[] = [
    blockEntry(root, allowed, input.version, desiredBlock),
    importEntry(root, allowed, input.version),
  ];
  for (const target of targets) {
    const shipped = new Set(skill.map((file) => `${SKILL_DIRS[target]}/${file.rel}`));
    for (const file of skill) {
      entries.push(skillEntry(root, allowed, `${SKILL_DIRS[target]}/${file.rel}`, file, record));
    }
    for (const path of recorded.sort()) {
      if (skillPathOf(path)?.target !== target || shipped.has(path)) continue;
      const orphan = skillEntry(root, allowed, path, undefined, record);
      if (orphan.before !== undefined) entries.push(orphan);
    }
  }
  return { record, recordText, targets, allowed, facts, entries };
}

function chooseTargets(
  root: string,
  mode: AgentsMode,
  record: AgentsRecord | undefined,
  requested: readonly AgentTarget[] | undefined,
): readonly AgentTarget[] {
  if (mode === "install") {
    const named = new Set<AgentTarget>([...(requested ?? []), ...detectedTargets(root)]);
    return AGENT_TARGETS.filter((target) => named.has(target));
  }
  if (record?.targets !== undefined) return record.targets;
  return AGENT_TARGETS.filter((target) => isDirectory(join(root, SKILL_DIRS[target])));
}

function blockEntry(
  root: string,
  allowed: ReadonlySet<string>,
  version: string,
  desired: string,
): Entry {
  const before = readAgentFile(root, AGENTS_FILE, allowed);
  const base = {
    path: AGENTS_FILE,
    kind: "block" as const,
    before,
    desired,
    orphan: false,
    linked: false,
  };
  if (before === undefined) return { ...base, state: "missing" };
  const region = findBlock(before, AGENTS_FILE);
  if (region === undefined) return { ...base, state: "missing" };
  return { ...base, region, state: blockState(region, version, desired) };
}

function importEntry(root: string, allowed: ReadonlySet<string>, version: string): Entry {
  const before = readAgentFile(root, CLAUDE_FILE, allowed);
  const linked = sameFile(root);
  const desired = renderImportBlock(version);
  const base = {
    path: CLAUDE_FILE,
    kind: "import" as const,
    before,
    desired,
    orphan: false,
    linked,
  };
  if (before === undefined) return { ...base, state: "missing" };
  if (linked) return { ...base, state: "current" };
  const region = findBlock(before, CLAUDE_FILE);
  if (region !== undefined) return { ...base, region, state: blockState(region, version, desired) };
  return { ...base, state: hasImportLine(before) ? "current" : "missing" };
}

function blockState(
  region: NonNullable<ReturnType<typeof findBlock>>,
  version: string,
  exact: string,
): AgentState {
  if (lf(region.text) === exact) return "current";
  return region.version !== version ? "stale" : "modified";
}

function skillEntry(
  root: string,
  allowed: ReadonlySet<string>,
  path: string,
  file: SkillFile | undefined,
  record: AgentsRecord | undefined,
): Entry {
  const before = readAgentFile(root, path, allowed);
  const base = { path, kind: "skill" as const, before, orphan: file === undefined, linked: false };
  if (before === undefined) return { ...base, state: "missing", desired: file?.text };
  const recorded = record?.files?.[path];
  const matches = recorded !== undefined && recorded === contentHash(before);
  if (file !== undefined && lf(before) === lf(file.text)) {
    return { ...base, state: "current", desired: file.text };
  }
  return { ...base, state: matches ? "stale" : "modified", desired: file?.text };
}

type Step = {
  readonly action: AgentAction;
  readonly after: string | null | undefined;
  readonly shown: { readonly before: string; readonly after: string } | undefined;
};

const NOTHING: Step = { action: "none", after: undefined, shown: undefined };

function decide(
  mode: Exclude<AgentsMode, "status">,
  item: Entry,
  created: ReadonlySet<string>,
  record: AgentsRecord | undefined,
): Step {
  if (item.kind === "skill")
    return mode === "remove" ? removeSkill(item, record) : writeSkill(item);
  if (mode === "remove") return removeBlockStep(item, created, record);
  const desired = item.desired;
  if (item.state === "current" || desired === undefined) return NOTHING;
  const before = item.before;
  if (item.state === "missing") {
    if (before === undefined) {
      const text = item.kind === "import" ? PLAIN_IMPORT : desired;
      return { action: "create", after: text, shown: { before: "", after: text } };
    }
    return {
      action: "insert",
      after: insertBlock(before, desired),
      shown: { before: "", after: desired },
    };
  }
  if (before === undefined || item.region === undefined) return NOTHING;
  return {
    action: "update",
    after: replaceBlock(before, item.region, desired),
    shown: { before: lf(item.region.text), after: desired },
  };
}

function writeSkill(item: Entry): Step {
  const before = item.before;
  if (item.orphan) {
    if (before === undefined) return NOTHING;
    return item.state === "stale"
      ? { action: "delete", after: null, shown: { before, after: "" } }
      : { action: "skip", after: undefined, shown: undefined };
  }
  const want = item.desired;
  if (want === undefined) return NOTHING;
  if (item.state === "current") return NOTHING;
  if (item.state === "modified") return { action: "skip", after: undefined, shown: undefined };
  return {
    action: before === undefined ? "create" : "update",
    after: want,
    shown: { before: before ?? "", after: want },
  };
}

function removeSkill(item: Entry, record: AgentsRecord | undefined): Step {
  const before = item.before;
  if (before === undefined) return NOTHING;
  const recorded = record?.files?.[item.path];
  if (recorded !== undefined && recorded === contentHash(before)) {
    return { action: "delete", after: null, shown: { before, after: "" } };
  }
  return { action: "skip", after: undefined, shown: undefined };
}

function removeBlockStep(
  item: Entry,
  created: ReadonlySet<string>,
  record: AgentsRecord | undefined,
): Step {
  const before = item.before;
  if (before === undefined) return NOTHING;
  if (item.region === undefined) {
    const recorded = record?.files?.[item.path];
    if (item.kind === "import" && recorded !== undefined && recorded === contentHash(before)) {
      return { action: "delete", after: null, shown: { before, after: "" } };
    }
    return NOTHING;
  }
  const after = removeBlock(before, item.region);
  const shown = { before: lf(item.region.text), after: "" };
  if (after.trim().length === 0 && created.has(item.path)) {
    return { action: "delete", after: null, shown };
  }
  return { action: "remove", after, shown };
}

function collectHash(
  hashes: Record<string, string>,
  item: Entry,
  action: AgentAction,
  record: AgentsRecord | undefined,
): void {
  const kept = record?.files?.[item.path];
  if (item.kind === "block") return;
  if (item.kind === "import") {
    if (action === "create") hashes[item.path] = contentHash(PLAIN_IMPORT);
    else if (kept !== undefined && item.region === undefined) hashes[item.path] = kept;
    return;
  }
  if (action === "delete") return;
  if (action === "create" || action === "update") {
    if (item.desired !== undefined) hashes[item.path] = contentHash(item.desired);
    return;
  }
  if (item.state === "current" && item.before !== undefined)
    hashes[item.path] = contentHash(item.before);
  else if (kept !== undefined) hashes[item.path] = kept;
}

function nextRecord(
  input: AgentsInput,
  found: Survey,
  hashes: Readonly<Record<string, string>>,
  created: readonly string[],
  changed: boolean,
): AgentsRecord | undefined {
  if (input.mode === "remove") {
    if (found.recordText === undefined) return undefined;
    return changed || found.record?.choice !== "no" ? { choice: "no" } : undefined;
  }
  return {
    choice: "yes",
    tenancy: found.facts.tenancy,
    protected: found.facts.protectedConfigured,
    targets: found.targets,
    files: hashes,
    created,
  };
}

function recordStep(found: Survey, record: AgentsRecord | undefined): AgentsWrite | undefined {
  if (record === undefined) return undefined;
  const after = withAgentsRecord(found.recordText, record);
  if (after === found.recordText) return undefined;
  return {
    path: RECORD_FILE,
    kind: "record",
    action: found.recordText === undefined ? "create" : "update",
    before: found.recordText,
    after,
  };
}

function renderLines(data: AgentsData, installed: boolean): readonly string[] {
  if (!installed) {
    return ["No agent files are installed. Run okm init --agents to write them."];
  }
  const lines: string[] = [];
  for (const file of data.files) {
    if (file.action === "none") continue;
    lines.push(
      file.action === "skip"
        ? `skip ${file.path} (${file.state}, left as it is)`
        : `${file.action} ${file.path} (${file.state})`,
    );
    if (file.diff !== undefined) lines.push(file.diff);
  }
  if (data.status === "unchanged") lines.push("agent files: nothing to do");
  return lines;
}

function sameFile(root: string): boolean {
  const left = join(root, AGENTS_FILE);
  const right = join(root, CLAUDE_FILE);
  if (!existsSync(left) || !existsSync(right)) return false;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
