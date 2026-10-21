/**
 * `okm init` for a workspace: layouts, refusals, and a byte-identical rerun.
 *
 * No network and no database. Fixtures live under `tests/fixtures/init/`.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { repoRoot } from "../scripts/root.js";
import { schemaFor, schemaProblems } from "../src/tooling/cli/schema.js";
import { hasGitMarker } from "../src/tooling/workspaces.js";

const root = repoRoot();
const cli = join(root, "src/tooling/cli.ts");
const fixtures = join(root, "tests/fixtures/init");

test("a pnpm workspace proposes per-service and fails until a flag is passed", () => {
  const cwd = copyFixture("pnpm-workspace");
  try {
    const before = tree(cwd);
    const refused = run(["init", "--json", "--yes"], cwd);
    expect(refused.code).toBe(3);
    const body = envelope(refused.stdout);
    expect(body.errors[0]?.code).toBe("OKM1892");
    expect(body.errors[0]?.summary).toContain("@acme/api");
    expect(body.errors[0]?.summary).toContain("@acme/web");
    expect(tree(cwd)).toEqual(before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("layout B writes each package, a base file, catalog:, and root scripts", () => {
  const cwd = copyFixture("pnpm-workspace");
  try {
    const dry = run(["init", "--json", "--dry-run", "--yes", "--all-workspaces"], cwd);
    expect(dry.code).toBe(0);
    const planned = envelope(dry.stdout);
    expect(schemaProblems(schemaFor("init"), planned.data)).toEqual([]);
    expect(planned.data.layout).toBe("per-service");
    expect(planned.data.base).toBe("okmodel.base.ts");
    expect(planned.data.install).toBe(false);
    const apply = run(
      ["init", "--json", "--yes", "--all-workspaces", "--plan-hash", planned.data.planHash],
      cwd,
    );
    expect(apply.code).toBe(0);
    const applied = envelope(apply.stdout);
    expect(applied.data.status).toBe("applied");
    expect(applied.data.planHash).toBe(planned.data.planHash);
    const base = readFileSync(join(cwd, "okmodel.base.ts"), "utf8");
    expect(base).not.toContain("DATABASE_URL");
    expect(base).not.toMatch(/protected\s*:/);
    for (const name of ["api", "web"]) {
      const pkg = readPackage(join(cwd, "packages", name, "package.json"));
      expect(pkg.dependencies?.okmodel).toBe("catalog:");
      expect(pkg.scripts?.["db:check"]).toBe("pnpm dlx okm check");
      expect(pkg.scripts?.preinstall).toBeUndefined();
      expect(existsSync(join(cwd, "packages", name, "okmodel.config.ts"))).toBe(true);
      expect(readFileSync(join(cwd, "packages", name, "okmodel.config.ts"), "utf8")).toContain(
        "...settings",
      );
    }
    const rootPkg = readPackage(join(cwd, "package.json"));
    expect(rootPkg.dependencies).toBeUndefined();
    expect(rootPkg.workspaces).toBeUndefined();
    expect(rootPkg.scripts?.["db:check"]).toBe("pnpm -r db:check");
    expect(rootPkg.scripts?.build).toBe("pnpm -r build");
    const before = tree(cwd);
    const again = run(["init", "--yes", "--all-workspaces"], cwd);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("nothing to do");
    expect(tree(cwd)).toEqual(before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("init from inside one package leaves the root and its sibling alone", () => {
  const cwd = copyFixture("pnpm-workspace");
  const api = join(cwd, "packages/api");
  const rootText = readFileSync(join(cwd, "package.json"), "utf8");
  const webText = readFileSync(join(cwd, "packages/web/package.json"), "utf8");
  try {
    const result = run(["init", "--json", "--yes"], api);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body.data.layout).toBeUndefined();
    expect(body.data.detection.pm).toBe("pnpm");
    expect(readPackage(join(api, "package.json")).dependencies?.okmodel).toBe("catalog:");
    expect(existsSync(join(api, "okmodel.config.ts"))).toBe(true);
    expect(existsSync(join(cwd, "packages/web/okmodel.config.ts"))).toBe(false);
    expect(existsSync(join(cwd, "okmodel.base.ts"))).toBe(false);
    expect(readFileSync(join(cwd, "package.json"), "utf8")).toBe(rootText);
    expect(readFileSync(join(cwd, "packages/web/package.json"), "utf8")).toBe(webText);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("layout C writes the shared database package and a note for the apps", () => {
  const cwd = copyFixture("bun-workspace");
  const rootText = readFileSync(join(cwd, "package.json"), "utf8");
  const webText = readFileSync(join(cwd, "packages/web/package.json"), "utf8");
  const apiText = readFileSync(join(cwd, "packages/api/package.json"), "utf8");
  try {
    const result = run(["init", "--json", "--yes"], cwd);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(schemaProblems(schemaFor("init"), body.data)).toEqual([]);
    expect(body.data.layout).toBe("shared");
    expect(body.data.base).toBeUndefined();
    expect(body.data.detection.driver).toBe("postgresjs");
    expect(body.data.detection.runtime).toBe("bun");
    expect(body.data.note).toContain("packages/api");
    expect(body.data.note).toContain("packages/web");
    expect(body.data.note).toContain("packages/db");
    expect(existsSync(join(cwd, "packages/db/okmodel.config.ts"))).toBe(true);
    expect(existsSync(join(cwd, "packages/web/okmodel.config.ts"))).toBe(false);
    expect(existsSync(join(cwd, "packages/api/okmodel.config.ts"))).toBe(false);
    expect(existsSync(join(cwd, "okmodel.base.ts"))).toBe(false);
    expect(existsSync(join(cwd, "db"))).toBe(false);
    expect(readPackage(join(cwd, "packages/db/package.json")).dependencies?.okmodel).toBeDefined();
    expect(readPackage(join(cwd, "packages/db/package.json")).dependencies?.okmodel).not.toBe(
      "catalog:",
    );
    expect(readFileSync(join(cwd, "package.json"), "utf8")).toBe(rootText);
    expect(readFileSync(join(cwd, "packages/web/package.json"), "utf8")).toBe(webText);
    expect(readFileSync(join(cwd, "packages/api/package.json"), "utf8")).toBe(apiText);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("several candidates with no flag write nothing", () => {
  const cwd = copyFixture("candidates");
  try {
    const before = tree(cwd);
    const result = run(["init", "--json", "--yes"], cwd);
    expect(result.code).toBe(3);
    expect(envelope(result.stdout).errors[0]?.code).toBe("OKM1892");
    expect(tree(cwd)).toEqual(before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an ancestor config is inherited through okmodel.base.ts", () => {
  const cwd = copyFixture("ancestor");
  const rootConfig = readFileSync(join(cwd, "okmodel.config.ts"), "utf8");
  try {
    const result = run(["init", "--json", "--yes"], cwd);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body.data.base).toBe("okmodel.base.ts");
    expect(body.data.workspaces?.map((pkg) => pkg.path)).toEqual(["packages/web"]);
    const base = readFileSync(join(cwd, "okmodel.base.ts"), "utf8");
    expect(base).not.toContain("DATABASE_URL");
    expect(base).not.toMatch(/protected\s*:/);
    const config = readFileSync(join(cwd, "packages/web/okmodel.config.ts"), "utf8");
    expect(config).toContain("...settings");
    expect(config).toContain("../../okmodel.base.ts");
    expect(readFileSync(join(cwd, "okmodel.config.ts"), "utf8")).toBe(rootConfig);
    expect(existsSync(join(cwd, "db"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("two packages on one migrations directory write nothing", () => {
  const cwd = copyFixture("shared-migrations");
  const original = readFileSync(join(cwd, "packages/api/okmodel.config.ts"), "utf8");
  try {
    const before = tree(cwd);
    const result = run(["init", "--json", "--yes", "--all-workspaces"], cwd);
    expect(result.code).toBe(4);
    const body = envelope(result.stdout);
    expect(body.errors[0]?.code).toBe("OKM1893");
    expect(body.errors[0]?.summary).toContain("packages/api");
    expect(body.errors[0]?.summary).toContain("packages/web");
    expect(readFileSync(join(cwd, "packages/api/okmodel.config.ts"), "utf8")).toBe(original);
    expect(tree(cwd)).toEqual(before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a symlinked schema directory is not followed out of the package", () => {
  const cwd = copyFixture("pnpm-workspace");
  const outside = mkdtempSync(join(tmpdir(), "okm-init-mono-out-"));
  try {
    symlinkSync(outside, join(cwd, "packages/api/db"));
    const result = run(["init", "--yes", "--workspace", "api"], cwd);
    expect(result.code).toBe(5);
    expect(result.stderr).toContain("OKM1865");
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a .git file counts as a repository marker", () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-init-gitfile-"));
  try {
    expect(hasGitMarker(cwd)).toBe(false);
    writeFileSync(join(cwd, ".git"), "gitdir: /somewhere\n");
    expect(hasGitMarker(cwd)).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function copyFixture(name: string): string {
  const dest = mkdtempSync(join(tmpdir(), `okm-init-${name}-`));
  cpSync(join(fixtures, name), dest, { recursive: true });
  return dest;
}

function run(
  args: readonly string[],
  cwd: string,
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const proc = spawnSync("bun", [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    timeout: 20_000,
  });
  return { code: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr };
}

type InitEnvelope = {
  readonly data: {
    readonly status?: string;
    readonly layout?: string;
    readonly base?: string;
    readonly planHash: string;
    readonly install?: boolean;
    readonly note?: string;
    readonly workspaces?: readonly { readonly path: string }[];
    readonly detection: { readonly pm: string; readonly driver: string; readonly runtime: string };
  };
  readonly errors: readonly { readonly code?: string; readonly summary?: string }[];
};

function envelope(stdout: string): InitEnvelope {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an envelope");
  return parsed as InitEnvelope;
}

function readPackage(path: string): {
  readonly dependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly workspaces?: unknown;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    workspaces?: unknown;
  };
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path.slice(dir.length + 1)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return out;
}
