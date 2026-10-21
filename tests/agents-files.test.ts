/**
 * `okm agents status | update | remove` and the agent files `okm init` writes.
 *
 * No network and no database. Each test works in its own temporary directory.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { hiddenCharsIn } from "../scripts/docs-hygiene.js";
import { packedTextPaths } from "../scripts/docs-pack.js";
import { repoRoot } from "../scripts/root.js";
import { applyAgents } from "../src/tooling/agents/apply.js";
import { renderAgentsBlock, renderImportBlock } from "../src/tooling/agents/block.js";
import {
  SKILL_DIRS,
  agentPath,
  agentsAllowlist,
  hiddenCodePoint,
  shippedSkill,
} from "../src/tooling/agents/files.js";
import { findBlock } from "../src/tooling/agents/markers.js";
import { planAgents, planDecline, statusAgents } from "../src/tooling/agents/plan.js";
import { schemaFor, schemaProblems } from "../src/tooling/cli/schema.js";
import { readPackageVersion } from "../src/tooling/cli/version.js";
import { contentHash } from "../src/tooling/init/engine.js";

const root = repoRoot();
const cli = join(root, "src/tooling/cli.ts");
const VERSION = "0.10.0-next.1";
const NEXT = "0.10.0-next.2";
const BEGIN = `<!-- BEGIN OKMODEL v${VERSION} -->`;
const made: string[] = [];

afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

function project(files: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "okm-agents-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof OkmError ? error.code : String(error);
  }
  return undefined;
}

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

function install(dir: string, targets: readonly ("claude" | "agents")[] = [], version = VERSION) {
  const plan = planAgents({ root: dir, mode: "install", version, targets });
  const done = applyAgents(plan);
  return { plan, done };
}

function okm(
  args: readonly string[],
  cwd: string,
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const proc = spawnSync("bun", [cli, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
  return { code: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr };
}

function stateOf(dir: string, version = VERSION): Record<string, string> {
  const report = statusAgents(dir, version);
  return Object.fromEntries(report.data.files.map((file) => [file.path, file.state]));
}

test("install, update, and remove round trip leaves the outside text as it was", () => {
  const original = "# Mine\n\nRules I wrote.\n\n- one\n- two\n";
  const dir = project({ "AGENTS.md": original, "CLAUDE.md": "# Claude notes\n" });
  install(dir, ["claude"]);
  const installed = read(dir, "AGENTS.md");
  expect(installed.startsWith(original)).toBe(true);
  expect(installed).toContain(BEGIN);
  expect(read(dir, "CLAUDE.md")).toContain("@AGENTS.md");
  expect(read(dir, "CLAUDE.md").startsWith("# Claude notes\n")).toBe(true);
  expect(existsSync(join(dir, ".claude/skills/okmodel/SKILL.md"))).toBe(true);
  expect(existsSync(join(dir, ".agents"))).toBe(false);
  expect(stateOf(dir)).toEqual({
    "AGENTS.md": "current",
    "CLAUDE.md": "current",
    ".claude/skills/okmodel/SKILL.md": "current",
  });

  const updated = planAgents({ root: dir, mode: "update", version: NEXT });
  expect(updated.data.status).toBe("planned");
  applyAgents(updated);
  const after = read(dir, "AGENTS.md");
  expect(after.startsWith(original)).toBe(true);
  expect(after).toContain(`<!-- BEGIN OKMODEL v${NEXT} -->`);
  expect(after).not.toContain(BEGIN);

  const removed = planAgents({ root: dir, mode: "remove", version: NEXT });
  applyAgents(removed);
  expect(read(dir, "AGENTS.md")).toBe(original);
  expect(read(dir, "CLAUDE.md")).toBe("# Claude notes\n");
  expect(existsSync(join(dir, ".claude/skills/okmodel"))).toBe(false);
});

test("text outside the markers keeps its bytes, CRLF included", () => {
  const before = "# Top\r\n\r\nline one\r\nline two";
  const tail = "\r\n\r\n## After\r\nlast";
  const dir = project({ "AGENTS.md": before });
  install(dir);
  const text = read(dir, "AGENTS.md");
  expect(text.startsWith(before)).toBe(true);
  expect(text).toContain("\r\n<!-- END OKMODEL -->");
  writeFileSync(join(dir, "AGENTS.md"), text + tail.replace(/^\r\n\r\n/, "\r\n\r\n"));
  applyAgents(planAgents({ root: dir, mode: "update", version: NEXT }));
  const updated = read(dir, "AGENTS.md");
  expect(updated.startsWith(before)).toBe(true);
  expect(updated.endsWith(tail)).toBe(true);
  applyAgents(planAgents({ root: dir, mode: "remove", version: NEXT }));
  expect(read(dir, "AGENTS.md").startsWith(before)).toBe(true);
  expect(read(dir, "AGENTS.md")).not.toContain("OKMODEL");
});

test("a file okm created is deleted again, and a file it only added to is kept", () => {
  const dir = project();
  install(dir);
  expect(read(dir, "CLAUDE.md")).toBe("@AGENTS.md\n");
  applyAgents(planAgents({ root: dir, mode: "remove", version: VERSION }));
  expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  const record = JSON.parse(read(dir, ".okm/init.json")) as { agents: { choice: string } };
  expect(record.agents.choice).toBe("no");
});

test("each status state is reported for the block, the import, and a skill", () => {
  const dir = project();
  expect(stateOf(dir)).toEqual({ "AGENTS.md": "missing", "CLAUDE.md": "missing" });
  install(dir, ["agents"]);
  const skill = ".agents/skills/okmodel/SKILL.md";
  expect(stateOf(dir)).toEqual({
    "AGENTS.md": "current",
    "CLAUDE.md": "current",
    [skill]: "current",
  });
  expect(stateOf(dir, NEXT)["AGENTS.md"]).toBe("stale");

  writeFileSync(join(dir, "AGENTS.md"), read(dir, "AGENTS.md").replace("Never:", "Never, ever:"));
  expect(stateOf(dir)["AGENTS.md"]).toBe("modified");

  writeFileSync(join(dir, skill), `${read(dir, skill)}\nmine\n`);
  expect(stateOf(dir)[skill]).toBe("modified");
  rmSync(join(dir, skill));
  expect(stateOf(dir)[skill]).toBe("missing");
  rmSync(join(dir, "CLAUDE.md"));
  expect(stateOf(dir)["CLAUDE.md"]).toBe("missing");
});

test("an existing CLAUDE.md gets the import inside the block, with a diff and consent", () => {
  const dir = project({ "CLAUDE.md": "# Claude\n\nKeep this.\n" });
  const plan = planAgents({ root: dir, mode: "install", version: VERSION });
  const entry = plan.data.files.find((file) => file.path === "CLAUDE.md");
  expect(entry?.action).toBe("insert");
  expect(entry?.diff).toContain("+@AGENTS.md");
  expect(plan.consent).toContain("CLAUDE.md");
  applyAgents(plan);
  const text = read(dir, "CLAUDE.md");
  expect(text.startsWith("# Claude\n\nKeep this.\n")).toBe(true);
  expect(text).toContain(renderImportBlock(VERSION));
  expect(findBlock(text, "CLAUDE.md")?.text).toContain("@AGENTS.md");
});

test("a CLAUDE.md that already imports AGENTS.md is current and is not touched", () => {
  const dir = project({ "CLAUDE.md": "See below.\n@AGENTS.md\n" });
  install(dir);
  expect(read(dir, "CLAUDE.md")).toBe("See below.\n@AGENTS.md\n");
  expect(stateOf(dir)["CLAUDE.md"]).toBe("current");
  applyAgents(planAgents({ root: dir, mode: "remove", version: VERSION }));
  expect(read(dir, "CLAUDE.md")).toBe("See below.\n@AGENTS.md\n");
});

test("damaged or duplicated markers are refused and nothing is written", () => {
  const block = renderAgentsBlock({
    version: VERSION,
    tenancy: "none",
    protectedConfigured: false,
  });
  const cases: readonly (readonly [string, string])[] = [
    ["OKM1882", `${BEGIN}\nno end\n`],
    ["OKM1882", "text\n<!-- END OKMODEL -->\n"],
    ["OKM1882", "<!-- BEGIN OKMODEL -->\nbody\n<!-- END OKMODEL -->\n"],
    ["OKM1882", `${block}${BEGIN}\nnested\n`],
    ["OKM1883", `${block}\n${block}`],
  ];
  for (const [code, text] of cases) {
    for (const mode of ["update", "remove"] as const) {
      const dir = project({ "AGENTS.md": text });
      let thrown: unknown;
      try {
        planAgents({ root: dir, mode, version: VERSION });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OkmError);
      expect((thrown as OkmError).code).toBe(code);
      expect(read(dir, "AGENTS.md")).toBe(text);
    }
  }
  const dir = project({ "AGENTS.md": `${BEGIN}\nno end\n` });
  const status = okm(["agents", "status", "--json"], dir);
  expect(status.code).toBe(4);
  expect(JSON.parse(status.stdout).errors[0].code).toBe("OKM1882");
  expect(read(dir, "AGENTS.md")).toBe(`${BEGIN}\nno end\n`);
});

test("a modified skill is never overwritten or deleted", () => {
  const dir = project();
  install(dir, ["claude", "agents"]);
  const mine = ".claude/skills/okmodel/SKILL.md";
  const edited = `${read(dir, mine)}\nMy own rule.\n`;
  writeFileSync(join(dir, mine), edited);

  const updated = planAgents({ root: dir, mode: "update", version: NEXT });
  expect(updated.data.files.find((file) => file.path === mine)?.action).toBe("skip");
  expect(updated.warnings.some((warning) => warning.summary.includes(mine))).toBe(true);
  applyAgents(updated);
  expect(read(dir, mine)).toBe(edited);
  expect(existsSync(join(dir, ".agents/skills/okmodel/SKILL.md"))).toBe(true);

  const removed = planAgents({ root: dir, mode: "remove", version: NEXT });
  applyAgents(removed);
  expect(read(dir, mine)).toBe(edited);
  expect(existsSync(join(dir, ".agents/skills/okmodel/SKILL.md"))).toBe(false);
});

test("an unmodified skill is rewritten when the package ships a new one", () => {
  const dir = project();
  install(dir, ["claude"]);
  const skillPath = join(dir, ".claude/skills/okmodel/SKILL.md");
  const shipped = readFileSync(skillPath, "utf8");
  const record = JSON.parse(read(dir, ".okm/init.json")) as {
    agents: { files: Record<string, string> };
  };
  const old = "---\nname: okmodel\ndescription: old\n---\nold\n";
  writeFileSync(skillPath, old);
  record.agents.files[".claude/skills/okmodel/SKILL.md"] = contentHash(old);
  writeFileSync(join(dir, ".okm/init.json"), JSON.stringify(record));
  expect(stateOf(dir)[".claude/skills/okmodel/SKILL.md"]).toBe("stale");
  applyAgents(planAgents({ root: dir, mode: "update", version: VERSION }));
  expect(readFileSync(skillPath, "utf8")).toBe(shipped);
});

test("skills are written only for a directory that exists or a target that is named", () => {
  const none = project();
  install(none);
  expect(existsSync(join(none, ".claude"))).toBe(false);
  expect(existsSync(join(none, ".agents"))).toBe(false);

  const detected = project({ ".agents/keep": "" });
  install(detected);
  expect(existsSync(join(detected, ".agents/skills/okmodel/SKILL.md"))).toBe(true);
  expect(existsSync(join(detected, ".claude"))).toBe(false);

  const named = project();
  install(named, ["claude"]);
  expect(existsSync(join(named, ".claude/skills/okmodel/SKILL.md"))).toBe(true);

  const record = JSON.parse(read(named, ".okm/init.json")) as {
    agents: { files: Record<string, string>; targets: string[] };
  };
  expect(record.agents.targets).toEqual(["claude"]);
  const shipped = shippedSkill();
  expect(Object.keys(record.agents.files).sort()).toEqual(
    ["CLAUDE.md", ...shipped.map((file) => `${SKILL_DIRS.claude}/${file.rel}`)].sort(),
  );
  for (const file of shipped) {
    expect(record.agents.files[`${SKILL_DIRS.claude}/${file.rel}`]).toBe(contentHash(file.text));
  }
});

test("the writable paths are a closed list, and everything else is refused", () => {
  const skill = shippedSkill();
  const allowed = agentsAllowlist(skill, ["claude", "agents"]);
  expect([...allowed].sort()).toEqual(
    [
      ".agents/skills/okmodel/SKILL.md",
      ".claude/skills/okmodel/SKILL.md",
      ".okm/init.json",
      "AGENTS.md",
      "CLAUDE.md",
    ].sort(),
  );
  expect([...agentsAllowlist(skill, [])].sort()).toEqual(
    [".okm/init.json", "AGENTS.md", "CLAUDE.md"].sort(),
  );
  const dir = project();
  const forbidden = [
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/hooks/pre.sh",
    ".claude/skills/okmodel/run.sh",
    ".claude/skills/other/SKILL.md",
    ".vscode/tasks.json",
    ".cursor/rules/okmodel.mdc",
    ".cursor/mcp.json",
    ".mcp.json",
    "CLAUDE.local.md",
    "../outside.md",
    "/etc/passwd",
    "package.json",
  ];
  for (const path of forbidden) {
    let code: string | undefined;
    try {
      agentPath(dir, path, allowed);
    } catch (error) {
      code = (error as OkmError).code;
    }
    expect(code).toBe("OKM1886");
  }
  const text = readFileSync(join(root, "src/tooling/agents/files.ts"), "utf8");
  for (const name of ["settings", "hooks", "tasks.json", ".cursor", "mcp"]) {
    expect(text.includes(`"${name}`)).toBe(false);
  }
});

test("a plan that names a path outside the list is refused at apply time", () => {
  const dir = project();
  const plan = planAgents({ root: dir, mode: "install", version: VERSION });
  const tampered = {
    ...plan,
    writes: [
      ...plan.writes,
      {
        path: ".claude/settings.json",
        kind: "skill" as const,
        action: "create" as const,
        before: undefined,
        after: "{}",
      },
    ],
  };
  expect(codeOf(() => applyAgents(tampered))).toBe("OKM1886");
  expect(existsSync(join(dir, ".claude"))).toBe(false);
});

test("a symlinked agent file is refused", () => {
  const dir = project({ "real.md": "# real\n" });
  symlinkSync(join(dir, "real.md"), join(dir, "AGENTS.md"));
  expect(codeOf(() => planAgents({ root: dir, mode: "install", version: VERSION }))).toBe(
    "OKM1886",
  );
  expect(read(dir, "real.md")).toBe("# real\n");
});

test("--dry-run prints the plan that the run then executes", () => {
  const dir = project({ "AGENTS.md": "# Mine\n", ".claude/keep": "" });
  const plan = planAgents({ root: dir, mode: "install", version: VERSION });
  const planned = plan.writes.map((write) => ({ path: write.path, action: write.action }));
  expect(planned.length).toBeGreaterThan(0);
  expect(read(dir, "AGENTS.md")).toBe("# Mine\n");
  expect(applyAgents(plan)).toEqual(planned);

  const cliDir = project({ "AGENTS.md": "# Mine\n" });
  install(cliDir, [], "0.0.1");
  const before = read(cliDir, "AGENTS.md");
  const dry = okm(["agents", "update", "--dry-run", "--json"], cliDir);
  expect(dry.code).toBe(0);
  expect(JSON.parse(dry.stdout).data.status).toBe("planned");
  expect(read(cliDir, "AGENTS.md")).toBe(before);
});

test("the CLI plan, its hash, and the executed actions agree", () => {
  const dir = project({ "AGENTS.md": "# Mine\n" });
  install(dir);
  const version = JSON.parse(okm(["--version", "--json"], dir).stdout || "{}");
  expect(typeof version).toBe("object");
  const dry = okm(["agents", "remove", "--dry-run", "--json"], dir);
  expect(dry.code).toBe(0);
  const plan = JSON.parse(dry.stdout).data as {
    status: string;
    planHash: string;
    files: { path: string; action: string }[];
  };
  expect(plan.status).toBe("planned");
  expect(schemaProblems(schemaFor("agents remove"), plan)).toEqual([]);
  const wrong = okm(["agents", "remove", "--yes", "--plan-hash", "0".repeat(64), "--json"], dir);
  expect(wrong.code).not.toBe(0);
  expect(read(dir, "AGENTS.md")).toContain("OKMODEL");
  const run = okm(["agents", "remove", "--yes", "--plan-hash", plan.planHash, "--json"], dir);
  expect(run.code).toBe(0);
  const applied = JSON.parse(run.stdout).data as typeof plan;
  expect(applied.status).toBe("applied");
  expect(applied.planHash).toBe(plan.planHash);
  expect(applied.files.map((file) => [file.path, file.action])).toEqual(
    plan.files.map((file) => [file.path, file.action]),
  );
  expect(read(dir, "AGENTS.md")).toBe("# Mine\n");
});

test("status exits non-zero on drift, prints each state, and warns about CLAUDE.local.md", () => {
  const dir = project({ "CLAUDE.local.md": "mine\n" });
  const missing = okm(["agents", "status", "--json"], dir);
  expect(missing.code).toBe(1);
  const body = JSON.parse(missing.stdout);
  expect(body.errors[0].code).toBe("OKM1881");
  expect(body.data.status).toBe("drifted");
  expect(schemaProblems(schemaFor("agents status"), body.data)).toEqual([]);
  expect(
    body.warnings.some((w: { summary: string }) => w.summary.includes("CLAUDE.local.md")),
  ).toBe(true);

  install(dir, [], readPackageVersion());
  const current = okm(["agents", "status"], dir);
  expect(current.code).toBe(0);
  expect(current.stdout).toContain("AGENTS.md: current");
  expect(current.stdout).toContain("CLAUDE.local.md");
  const none = project();
  expect(okm(["agents", "status"], none).stdout).toContain("AGENTS.md: missing");
});

test("update and remove refuse to change an existing file without a yes", () => {
  const dir = project({ "AGENTS.md": "# Mine\n" });
  install(dir);
  const refused = okm(["agents", "remove", "--json"], dir);
  expect(refused.code).toBe(3);
  expect(JSON.parse(refused.stdout).errors[0].code).toBe("OKM1884");
  expect(read(dir, "AGENTS.md")).toContain("OKMODEL");
  const plain = okm(["agents", "remove"], dir);
  expect(plain.code).toBe(3);
  expect(read(dir, "AGENTS.md")).toContain("OKMODEL");
});

test("update on a project that never installed anything writes nothing", () => {
  const dir = project({ "AGENTS.md": "# Mine\n" });
  const run = okm(["agents", "update", "--yes"], dir);
  expect(run.code).toBe(0);
  expect(read(dir, "AGENTS.md")).toBe("# Mine\n");
  expect(existsSync(join(dir, ".okm"))).toBe(false);
  expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
});

test("a file that changes between the plan and the write stops the run", () => {
  const dir = project({ "AGENTS.md": "# Mine\n" });
  install(dir);
  const plan = planAgents({ root: dir, mode: "remove", version: VERSION });
  writeFileSync(join(dir, "AGENTS.md"), `${read(dir, "AGENTS.md")}\nlate edit\n`);
  expect(codeOf(() => applyAgents(plan))).toBe("OKM1887");
  expect(read(dir, "AGENTS.md")).toContain("late edit");
});

test("a damaged init record is refused, not repaired", () => {
  const dir = project({ ".okm/init.json": "[]" });
  expect(
    codeOf(() => applyAgents(planAgents({ root: dir, mode: "install", version: VERSION }))),
  ).toBe("OKM1888");
  expect(read(dir, ".okm/init.json")).toBe("[]");
  expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
});

test("a hand-edited record cannot widen what a run deletes", () => {
  const dir = project({ "keep.md": "mine\n", "AGENTS.md": "# Mine\n" });
  install(dir, ["claude"]);
  const record = JSON.parse(read(dir, ".okm/init.json")) as {
    agents: { files: Record<string, string> };
  };
  record.agents.files["keep.md"] = contentHash("mine\n");
  record.agents.files["../escape.md"] = contentHash("x");
  record.agents.files[".claude/settings.json"] = contentHash("{}");
  writeFileSync(join(dir, ".okm/init.json"), JSON.stringify(record));
  applyAgents(planAgents({ root: dir, mode: "remove", version: VERSION }));
  expect(read(dir, "keep.md")).toBe("mine\n");
});

test("--no-agents is recorded, and a later run does not install or ask", () => {
  const dir = project();
  const plan = planDecline(dir);
  expect(plan.writes.map((write) => write.path)).toEqual([".okm/init.json"]);
  applyAgents(plan);
  const record = JSON.parse(read(dir, ".okm/init.json")) as { agents: { choice: string } };
  expect(record.agents.choice).toBe("no");
  expect(planDecline(dir).writes).toEqual([]);
  expect(planDecline(dir).data.status).toBe("unchanged");
  expect(statusAgents(dir, VERSION).data.status).toBe("declined");
  expect(okm(["agents", "status"], dir).code).toBe(0);
  const update = planAgents({ root: dir, mode: "update", version: VERSION });
  expect(update.writes).toEqual([]);
});

test("okm init --agents writes the files, --no-agents records the choice", () => {
  const withAgents = project({ "package.json": '{"name":"x"}\n', "AGENTS.md": "# Mine\n" });
  const dry = okm(
    ["init", "--driver", "postgresjs", "--no-install", "--agents", "claude", "--dry-run", "--json"],
    withAgents,
  );
  expect(dry.code).toBe(0);
  const plan = JSON.parse(dry.stdout).data as {
    planHash: string;
    agents: { files: { path: string; action: string }[] };
  };
  expect(plan.agents.files.map((file) => file.path)).toContain("AGENTS.md");
  expect(read(withAgents, "AGENTS.md")).toBe("# Mine\n");
  const run = okm(
    ["init", "--driver", "postgresjs", "--no-install", "--agents", "claude", "--yes", "--json"],
    withAgents,
  );
  expect(run.code).toBe(0);
  expect(read(withAgents, "AGENTS.md")).toContain(BEGIN.slice(0, 22));
  expect(existsSync(join(withAgents, ".claude/skills/okmodel/SKILL.md"))).toBe(true);
  expect(okm(["agents", "status"], withAgents).code).toBe(0);

  const declined = project({ "package.json": '{"name":"y"}\n' });
  const none = okm(
    ["init", "--driver", "postgresjs", "--no-install", "--no-agents", "--yes"],
    declined,
  );
  expect(none.code).toBe(0);
  expect(existsSync(join(declined, "AGENTS.md"))).toBe(false);
  const record = JSON.parse(read(declined, ".okm/init.json")) as { agents: { choice: string } };
  expect(record.agents.choice).toBe("no");
});

test("init without a terminal never asks and never writes agent files unasked", () => {
  const dir = project({ "package.json": '{"name":"z"}\n' });
  const run = okm(["init", "--driver", "postgresjs", "--no-install", "--yes"], dir);
  expect(run.code).toBe(0);
  expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
});

test("shipped agent files and rendered blocks hold no hidden character", () => {
  const skill = shippedSkill();
  expect(skill.length).toBeGreaterThan(0);
  for (const file of skill) {
    expect(hiddenCodePoint(file.text)).toBeUndefined();
    expect(hiddenCharsIn(file.text, `skills/okmodel/${file.rel}`, false)).toEqual([]);
  }
  const packed = packedTextPaths(root);
  for (const file of skill) expect(packed).toContain(`skills/okmodel/${file.rel}`);
  for (const rel of packed.filter((path) => path.startsWith("skills/"))) {
    expect(hiddenCharsIn(readFileSync(join(root, rel), "utf8"), rel, false)).toEqual([]);
  }
  for (const text of [
    renderAgentsBlock({ version: VERSION, tenancy: "none", protectedConfigured: true }),
    renderImportBlock(VERSION),
  ]) {
    expect(hiddenCodePoint(text)).toBeUndefined();
  }
  expect(hiddenCodePoint("a\u202Eb")).toBe(0x202e);
  expect(hiddenCodePoint("a\u200Bb")).toBe(0x200b);
  expect(hiddenCodePoint("a\u{E0001}b")).toBe(0xe0001);
  expect(hiddenCodePoint("tab\tnew\ncr\r")).toBeUndefined();
});

test("a skill with a hidden character or a symlink in the package is refused", () => {
  const pkg = project({ "skills/okmodel/SKILL.md": "---\nname: okmodel\n---\nok\u200B\n" });
  expect(codeOf(() => shippedSkill(pkg))).toBe("OKM1885");
  const script = project({ "skills/okmodel/run.sh": "echo hi\n" });
  expect(codeOf(() => shippedSkill(script))).toBe("OKM1885");
  const linked = project({ "outside.md": "x\n", "skills/okmodel/.keep": "" });
  rmSync(join(linked, "skills/okmodel/.keep"));
  symlinkSync(join(linked, "outside.md"), join(linked, "skills/okmodel/SKILL.md"));
  expect(codeOf(() => shippedSkill(linked))).toBe("OKM1885");
  expect(codeOf(() => shippedSkill(project()))).toBe("OKM1885");
});

test("a link between two listed files works, and a link to anything else is refused", () => {
  const dir = project({ "AGENTS.md": "# Mine\n" });
  symlinkSync(join(dir, "AGENTS.md"), join(dir, "CLAUDE.md"));
  install(dir);
  expect(stateOf(dir)["CLAUDE.md"]).toBe("current");
  expect(read(dir, "AGENTS.md")).toContain("OKMODEL");
  applyAgents(planAgents({ root: dir, mode: "remove", version: VERSION }));
  expect(read(dir, "AGENTS.md")).toBe("# Mine\n");

  const settings = project({ ".claude/settings.json": "{}\n" });
  symlinkSync(join(settings, ".claude/settings.json"), join(settings, "AGENTS.md"));
  expect(codeOf(() => planAgents({ root: settings, mode: "install", version: VERSION }))).toBe(
    "OKM1886",
  );
  expect(read(settings, ".claude/settings.json")).toBe("{}\n");

  const tasks = project({ ".vscode/keep": "" });
  symlinkSync(join(tasks, ".vscode"), join(tasks, ".claude"));
  expect(
    codeOf(() =>
      planAgents({ root: tasks, mode: "install", version: VERSION, targets: ["claude"] }),
    ),
  ).toBe("OKM1886");
  expect(existsSync(join(tasks, ".vscode/skills"))).toBe(false);
});
