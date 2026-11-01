/**
 * `okm init` for one package: plan, apply, refusals, and offline check.
 *
 * No network and no database. Fixtures live under `tests/fixtures/init/`.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { schemaFor, schemaProblems } from "../src/tooling/cli/schema.js";
import { parseCli } from "../src/tooling/cli/parse.js";
import { readPackageVersion } from "../src/tooling/cli/version.js";
import { initCommand } from "../src/tooling/init/command.js";
import {
  applyWrites,
  contentHash,
  initAllowlist,
  lf,
  shouldInstall,
} from "../src/tooling/init/engine.js";
import { normalizeInitPath } from "../src/tooling/init/paths.js";
import { scriptPrefix } from "../src/tooling/init/text.js";
import { checkProject, loadConfig } from "../src/tooling/migrate/project.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();
const cli = join(root, "src/tooling/cli.ts");
const fixtures = join(root, "tests/fixtures/init");
const snaps = join(fixtures, "snapshots");

const ALLOW = [
  "db/schema.ts",
  "db/client.ts",
  "migrations/.gitkeep",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  "package.json",
  ".okm/init.json",
  "okmodel.config.ts",
] as const;

type Envelope = {
  readonly ok: boolean;
  readonly exit: number;
  readonly command: string;
  readonly data: {
    readonly status: string;
    readonly planHash: string;
    readonly install: boolean;
    readonly note?: string;
    readonly detection: {
      readonly pm: string;
      readonly driver: string;
      readonly runtime: string;
      readonly databaseEnv: string;
      readonly git: boolean;
      readonly okmodel: boolean;
      readonly typescript: string;
      readonly orm: readonly string[];
      readonly ancestorConfig: boolean;
      readonly packageName?: {
        readonly origin: string;
        readonly text: string;
        readonly untrusted: true;
      };
    };
    readonly files: readonly {
      readonly path: string;
      readonly state: string;
      readonly action: string;
    }[];
    readonly packageEdits: readonly {
      readonly key: string;
      readonly action: string;
      readonly value?: string;
    }[];
    readonly nextSteps: readonly string[];
  };
  readonly errors: readonly {
    readonly code: string;
    readonly summary: string;
    readonly fix: string;
  }[];
  readonly warnings: readonly { readonly summary: string }[];
};

test("the allowlist is closed and init does not import a driver", () => {
  expect(initAllowlist("db")).toEqual([...ALLOW]);
  for (const file of readdirSync(join(root, "src/tooling/init"))) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(root, "src/tooling/init", file), "utf8");
    expect(text.includes('from "node:net"'), file).toBe(false);
    expect(text.includes('from "postgres"'), file).toBe(false);
    expect(text.includes('from "pg"'), file).toBe(false);
  }
});

test("paths reject escapes and accept a Windows separator", () => {
  expect(normalizeInitPath("db\\schema.ts")).toBe("db/schema.ts");
  expect(() => normalizeInitPath("..")).toThrow(OkmError);
  try {
    normalizeInitPath("/tmp/outside");
    throw new Error("absolute path was accepted");
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    expect((error as OkmError).code).toBe("OKM1865");
  }
});

test("install follows the terminal and the flags", () => {
  expect(
    shouldInstall({ json: true, yes: false, install: true, noInstall: false, tty: true }),
  ).toBe(false);
  expect(
    shouldInstall({ json: false, yes: true, install: false, noInstall: false, tty: true }),
  ).toBe(false);
  expect(
    shouldInstall({ json: false, yes: true, install: true, noInstall: false, tty: false }),
  ).toBe(true);
  expect(
    shouldInstall({ json: false, yes: false, install: false, noInstall: true, tty: true }),
  ).toBe(false);
  expect(
    shouldInstall({ json: false, yes: false, install: false, noInstall: false, tty: false }),
  ).toBe(false);
  expect(
    shouldInstall({ json: false, yes: false, install: false, noInstall: false, tty: true }),
  ).toBe(true);
});

test("an empty directory is an unsupported project and does not hang", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-init-empty-"));
  try {
    const proc = Bun.spawn(["bun", cli, "init", "--yes"], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, 4_000);
    const code = await proc.exited;
    clearTimeout(timer);
    const stderr = await new Response(proc.stderr).text();
    expect(timedOut).toBe(false);
    expect(code).toBe(5);
    expect(stderr).toContain("OKM1865");
    expect(readdirSync(cwd)).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("unknown flags are usage errors", () => {
  const cwd = copyFixture("bun");
  try {
    expect(run(["init", "--template", "x"], cwd).code).toBe(2);
    expect(run(["init", "--force"], cwd).code).toBe(2);
    expect(run(["init", "--driver", "sqlite"], cwd).code).toBe(2);
    const forced = run(["init", "--yes", "--force-file", "README.md"], cwd);
    expect(forced.code).toBe(2);
    expect(existsSync(join(cwd, "db"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bun, npm, pnpm, and drizzle fixtures plan and apply", () => {
  for (const name of ["bun", "npm", "pnpm", "drizzle"] as const) {
    const cwd = copyFixture(name);
    try {
      const dry = run(["init", "--json", "--dry-run", "--yes"], cwd);
      expect(dry.code, name).toBe(0);
      const planned = envelope(dry.stdout);
      expect(schemaProblems(schemaFor("init"), planned.data), name).toEqual([]);
      expect(planned.data.status, name).toBe("planned");
      expect(planned.data.install, name).toBe(false);
      expect(planned.data.detection.databaseEnv, name).toBe("DATABASE_URL");
      expect(planned.data.nextSteps, name).toHaveLength(3);
      expect(planned.command, name).toBe("init");
      expectSnap(`${name}-dry.json`, normalize(dry.stdout));
      const apply = run(["init", "--json", "--yes", "--plan-hash", planned.data.planHash], cwd);
      expect(apply.code, name).toBe(0);
      const applied = envelope(apply.stdout);
      expect(applied.data.status, name).toBe("applied");
      expect(schemaProblems(schemaFor("init"), applied.data), name).toEqual([]);
      expect(
        applied.data.files.map((file) => `${file.action} ${file.path}`),
        name,
      ).toEqual(planned.data.files.map((file) => `${file.action} ${file.path}`));
      expectSnap(`${name}-tree.json`, normalize(treeJson(cwd)));
      assertPackage(cwd, name);
      assertRecord(cwd, applied.data.detection.driver, "none");
      const before = treeBytes(cwd);
      const again = run(["init", "--yes"], cwd);
      expect(again.code, name).toBe(0);
      expect(again.stdout, name).toContain("nothing to do");
      assertSteps(again.stdout, applied.data.detection.pm);
      expect(again.stdout.split("\n").slice(0, 3), name).toEqual([
        `pm: ${applied.data.detection.pm}`,
        `driver: ${applied.data.detection.driver}`,
        `runtime: ${applied.data.detection.runtime}`,
      ]);
      expect(treeBytes(cwd), name).toEqual(before);
      expect(again.stdout, name).not.toContain("describe");
      expect(again.stdout, name).not.toContain("doctor");
      expect(readFileSync(join(cwd, "db/client.ts"), "utf8"), name).toContain(
        "limits: { find: 100, include: 20, page: 50, groupBy: 500, max: 1000 },",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("limits are scaffolded, hinted on a later run, and applied only to an unmodified client", () => {
  const cwd = copyFixture("bun");
  const client = join(cwd, "db/client.ts");
  const recordPath = join(cwd, ".okm/init.json");
  const snippet = "limits: { find: 100, include: 20, page: 50, groupBy: 500, max: 1000 },";
  try {
    const apply = run(["init", "--yes"], cwd);
    expect(apply.code).toBe(0);
    const schema = readFileSync(join(cwd, "db/schema.ts"));
    const written = readFileSync(client, "utf8");
    expect(written).toContain(snippet);
    expect(written).toContain(".all(reason) reads past them.");
    const again = run(["init"], cwd);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("nothing to do");
    expect(again.stdout).not.toContain("has no limits");
    expect(readFileSync(client, "utf8")).toBe(written);

    const stripped = written.replace(`\n  ${snippet}`, "");
    expect(stripped).not.toContain("limits:");
    writeFileSync(client, stripped);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      files: Record<string, string>;
    };
    record.files["db/client.ts"] = contentHash(stripped);
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

    const hinted = run(["init"], cwd);
    expect(hinted.code).toBe(0);
    expect(hinted.stdout).toContain("db/client.ts has no limits.");
    expect(hinted.stdout).toContain(snippet);
    expect(hinted.stdout).toContain("okm init --limits");
    expect(readFileSync(client, "utf8")).toBe(stripped);
    expect(readFileSync(join(cwd, "db/schema.ts"))).toEqual(schema);

    const dry = run(["init", "--limits", "--dry-run", "--json"], cwd);
    expect(dry.code).toBe(0);
    expect(readFileSync(client, "utf8")).toBe(stripped);
    const planned = envelope(dry.stdout);
    expect(schemaProblems(schemaFor("init"), planned.data)).toEqual([]);
    expect(planned.data.status).toBe("planned");

    const applied = run(["init", "--limits", "--json"], cwd);
    expect(applied.code).toBe(0);
    const body = envelope(applied.stdout);
    expect(schemaProblems(schemaFor("init"), body.data)).toEqual([]);
    expect(body.data.status).toBe("applied");
    const restored = readFileSync(client, "utf8");
    expect(restored).toBe(written);
    expect(readFileSync(join(cwd, "db/schema.ts"))).toEqual(schema);
    const after = JSON.parse(readFileSync(recordPath, "utf8")) as {
      files: Record<string, string>;
    };
    expect(after.files["db/client.ts"]).toBe(contentHash(restored));

    writeFileSync(client, stripped);
    after.files["db/client.ts"] = contentHash(stripped);
    writeFileSync(recordPath, `${JSON.stringify(after, null, 2)}\n`);
    const edited = `${stripped}// local\n`;
    writeFileSync(client, edited);
    const left = run(["init", "--limits"], cwd);
    expect(left.code).toBe(0);
    expect(left.stdout).toContain("db/client.ts has no limits.");
    expect(left.stdout).toContain("okm init --limits");
    expect(left.stdout).toContain("nothing to do");
    expect(readFileSync(client, "utf8")).toBe(edited);
    expect(readFileSync(join(cwd, "db/schema.ts"))).toEqual(schema);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a user-modified config is left unchanged until force-file names it", () => {
  const cwd = copyFixture("npm");
  const config = join(cwd, "okmodel.config.ts");
  const original = "export const kept = true;\n";
  writeFileSync(config, original);
  try {
    const dry = run(["init", "--json", "--dry-run", "--yes"], cwd);
    expect(dry.code).toBe(4);
    const body = envelope(dry.stdout);
    expect(body.errors[0]?.code).toBe("OKM1864");
    expect(body.errors[0]?.fix).not.toContain("--force");
    expect(schemaProblems(schemaFor("init"), body.data)).toEqual([]);
    expect(readFileSync(config, "utf8")).toBe(original);
    expect(existsSync(join(cwd, "db/schema.ts"))).toBe(false);
    const replaced = run(["init", "--yes", "--force-file", "okmodel.config.ts"], cwd);
    expect(replaced.code).toBe(0);
    expect(readFileSync(config, "utf8")).not.toBe(original);
    expect(readFileSync(config, "utf8")).toContain("defineConfig");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a Windows force-file path replaces one schema file", () => {
  const cwd = copyFixture("bun");
  try {
    expect(run(["init", "--yes"], cwd).code).toBe(0);
    const schema = join(cwd, "db/schema.ts");
    writeFileSync(schema, "export const edited = 1;\n");
    const kept = readFileSync(join(cwd, "db/client.ts"));
    const refused = run(["init", "--yes"], cwd);
    expect(refused.code).toBe(4);
    expect(readFileSync(schema, "utf8")).toBe("export const edited = 1;\n");
    expect(readFileSync(join(cwd, "db/client.ts"))).toEqual(kept);
    const replaced = run(["init", "--yes", "--force-file", "db\\schema.ts"], cwd);
    expect(replaced.code).toBe(0);
    expect(readFileSync(schema, "utf8")).toContain('table("users"');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("CRLF bytes stay put on a second init", () => {
  const cwd = copyFixture("crlf");
  toCrlf(cwd);
  try {
    expect(run(["init", "--yes"], cwd).code).toBe(0);
    toCrlf(cwd);
    const before = treeBytes(cwd);
    const again = run(["init", "--yes"], cwd);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("nothing to do");
    expect(treeBytes(cwd)).toEqual(before);
    expect(readFileSync(join(cwd, "package.json"), "utf8")).toContain("\r\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a differing driver, tenancy mode, or plan hash writes nothing", () => {
  const cwd = copyFixture("npm");
  const before = readFileSync(join(cwd, "package.json"), "utf8");
  try {
    const driver = run(["init", "--yes", "--driver", "pg", "--json"], cwd);
    expect(driver.code).toBe(4);
    expect(envelope(driver.stdout).errors[0]?.code).toBe("OKM1862");
    const tenancy = run(["init", "--yes", "--tenancy", "database", "--json"], cwd);
    expect(tenancy.code).toBe(3);
    expect(envelope(tenancy.stdout).errors[0]?.code).toBe("OKM1867");
    const hash = run(["init", "--yes", "--plan-hash", "deadbeef", "--json"], cwd);
    expect(hash.code).toBe(4);
    expect(envelope(hash.stdout).errors[0]?.code).toBe("OKM1866");
    expect(readFileSync(join(cwd, "package.json"), "utf8")).toBe(before);
    expect(existsSync(join(cwd, "db"))).toBe(false);
    writeFileSync(
      join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "npm-app",
          private: true,
          dependencies: { pg: "^8.16.0", postgres: "^3.4.9" },
        },
        null,
        2,
      )}\n`,
    );
    const choice = run(["init", "--json", "--yes"], cwd);
    expect(choice.code).toBe(3);
    expect(envelope(choice.stdout).errors[0]?.code).toBe("OKM1863");
    expect(envelope(choice.stdout).errors[0]?.summary).toContain("--driver");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("secrets, env files, and symlink escapes stay outside the write", () => {
  const cwd = copyFixture("npm");
  const outside = mkdtempSync(join(tmpdir(), "okm-init-out-"));
  const leaked = "postgres://user:LEAKEDTOKEN@127.0.0.1:1/db";
  try {
    writeFileSync(join(outside, "secret.env"), `DATABASE_URL=${leaked}\n`);
    symlinkSync(join(outside, "secret.env"), join(cwd, ".env"));
    writeFileSync(join(cwd, ".env.example"), "OTHERSECRET=1\n");
    writeFileSync(join(cwd, ".env.local"), `LOCAL=${leaked}\n`);
    const result = run(["init", "--yes"], cwd, { DATABASE_URL: leaked });
    expect(result.code).toBe(0);
    const spoken = `${result.stdout}\n${result.stderr}`;
    expect(spoken).not.toContain("LEAKEDTOKEN");
    expect(spoken).not.toContain("OTHERSECRET");
    for (const path of walk(cwd)) {
      if (path === ".env" || path === ".env.local") continue;
      expect(readFileSync(join(cwd, path), "utf8"), path).not.toContain("LEAKEDTOKEN");
    }
    expect(readFileSync(join(outside, "secret.env"), "utf8")).toContain("LEAKEDTOKEN");
    expect(lstatSync(join(cwd, ".env")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(cwd, ".env.local"))).toBe(true);
    expect(readFileSync(join(cwd, ".env.example"), "utf8")).toBe("OTHERSECRET=1\nDATABASE_URL=\n");
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toContain(".env\n");
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).not.toContain(".okm");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlinked directory is not followed out of the project", () => {
  const cwd = copyFixture("bun");
  const outside = mkdtempSync(join(tmpdir(), "okm-init-link-"));
  const parent = mkdtempSync(join(tmpdir(), "okm-init-parent-"));
  try {
    symlinkSync(outside, join(cwd, "db"));
    const escaped = run(["init", "--yes"], cwd);
    expect(escaped.code).toBe(5);
    expect(escaped.stderr).toContain("OKM1865");
    expect(readdirSync(outside)).toEqual([]);
    const app = join(parent, "app");
    cpSync(join(fixtures, "bun"), app, { recursive: true });
    const placed = run(["init", "--yes", app], parent);
    expect(placed.code).toBe(0);
    expect(readdirSync(parent).sort()).toEqual(["app"]);
    expect(existsSync(join(app, "okmodel.config.ts"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("column tenancy typechecks and okm check stays offline", async () => {
  const cwd = copyFixture("npm");
  const hits = { n: 0 };
  const connect = net.connect;
  const create = net.createConnection;
  const boom = (() => {
    hits.n += 1;
    throw new Error("socket");
  }) as typeof net.connect;
  net.connect = boom;
  net.createConnection = boom as typeof net.createConnection;
  try {
    const parsed = parseCli(["init", "--yes", "--json", "--tenancy", "column"]);
    const produced = await initCommand(parsed, cwd, () => {});
    expect(hits.n).toBe(0);
    expect(produced.data.detection.driver).toBe("postgresjs");
    const schema = readFileSync(join(cwd, "db/schema.ts"), "utf8");
    expect(schema).toContain('columnTenancy({ key: "tenantId", type: "uuid" })');
    expect(schema).not.toContain("tenantId:");
    expect(schema).toContain("minPostgres: 15");
    expect(schema).toContain('declare module "okmodel"');
    typecheck(cwd);
    pointAtSource(cwd);
    const loaded = await loadConfig(cwd);
    expect(loaded.schema).toBe("./db/schema.ts");
    expect(loaded.database).toBeUndefined();
    const checked = await checkProject(cwd);
    expect(hits.n).toBe(0);
    expect(checked.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  } finally {
    net.connect = connect;
    net.createConnection = create;
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("a managed diff updates only with --yes, and a broken init.json blocks", () => {
  const cwd = copyFixture("bun");
  try {
    expect(run(["init", "--yes"], cwd).code).toBe(0);
    const schema = join(cwd, "db/schema.ts");
    const edited = "export const edited = 1;\n";
    writeFileSync(schema, edited);
    const recordPath = join(cwd, ".okm/init.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      files: Record<string, string>;
    };
    record.files["db/schema.ts"] = contentHash(edited);
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    const skipped = run(["init", "--json"], cwd);
    expect(skipped.code).toBe(0);
    expect(readFileSync(schema, "utf8")).toBe(edited);
    const file = envelope(skipped.stdout).data.files.find((item) => item.path === "db/schema.ts");
    expect(file?.state).toBe("managed-diff");
    expect(file?.action).toBe("skip");
    expect(run(["init", "--yes"], cwd).code).toBe(0);
    expect(readFileSync(schema, "utf8")).toContain('table("users"');
    writeFileSync(recordPath, "{");
    const blocked = run(["init", "--yes"], cwd);
    expect(blocked.code).toBe(4);
    expect(blocked.stderr).toContain("OKM1864");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an existing gitattributes file is left unchanged and a write failure names the rest", () => {
  const cwd = copyFixture("pnpm");
  writeFileSync(join(cwd, ".gitattributes"), "custom text\n");
  try {
    expect(run(["init", "--yes"], cwd).code).toBe(0);
    expect(readFileSync(join(cwd, ".gitattributes"), "utf8")).toBe("custom text\n");
    const fresh = copyFixture("pnpm");
    try {
      let caught: unknown;
      try {
        applyWrites(fresh, "db", [
          { path: "db/schema.ts", text: "export const partial = 1;\n" },
          { path: "nope.ts", text: "x\n" },
        ]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OkmError);
      expect((caught as OkmError).message).toContain("Still to write: nope.ts");
      expect(readFileSync(join(fresh, "db/schema.ts"), "utf8")).toContain("partial");
      expect(existsSync(join(fresh, "okmodel.config.ts"))).toBe(false);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("detection reports git, an ancestor config, and moduleResolution", () => {
  const parent = mkdtempSync(join(tmpdir(), "okm-init-ancestor-"));
  const cwd = join(parent, "app");
  cpSync(join(fixtures, "npm"), cwd, { recursive: true });
  writeFileSync(join(parent, "okmodel.config.ts"), "export default {};\n");
  mkdirSync(join(cwd, ".git"));
  writeFileSync(
    join(cwd, "tsconfig.json"),
    '{ "compilerOptions": { "moduleResolution": "node" } }\n',
  );
  try {
    const result = run(["init", "--json", "--dry-run", "--yes"], cwd);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body.data.detection.git).toBe(true);
    expect(body.data.detection.ancestorConfig).toBe(true);
    expect(body.data.detection.typescript).toBe("warn");
    expect(body.data.detection.packageName?.origin).toBe("package.json");
    expect(body.data.detection.packageName?.untrusted).toBe(true);
    expect(body.warnings[0]?.summary).toContain("moduleResolution");
    expect(result.stdout).not.toContain(parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("--dir accepts a backslash and bun can add postgres.js", () => {
  const cwd = copyFixture("bun");
  try {
    const result = run(
      ["init", "--yes", "--json", "--dir", "db\\extra", "--driver", "postgresjs"],
      cwd,
    );
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body.data.detection.driver).toBe("postgresjs");
    expect(existsSync(join(cwd, "db/extra/schema.ts"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.postgres).toBe(peerBare("postgres"));
    expect(pkg.dependencies.okmodel).toBe(readPackageVersion());
    const outside = new Set(walk(cwd));
    for (const path of outside) {
      if (path === "bun.lock" || path === "package.json") continue;
      expect(initAllowlist("db/extra")).toContain(path);
    }
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
  env?: Readonly<Record<string, string>>,
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const proc = spawnSync("bun", [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 20_000,
  });
  return { code: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr };
}

function envelope(stdout: string): Envelope {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an envelope");
  return parsed as Envelope;
}

function assertSteps(text: string, pm: string): void {
  const lines = text.trimEnd().split("\n");
  const prefix = scriptPrefix(pm as "bun" | "npm" | "pnpm" | "yarn");
  expect(lines.slice(-3)).toEqual([
    `${prefix} check`,
    `${prefix} migrate plan init`,
    `${prefix} migrate apply`,
  ]);
}

function assertPackage(cwd: string, name: "bun" | "npm" | "pnpm" | "drizzle"): void {
  const text = readFileSync(join(cwd, "package.json"), "utf8");
  const parsed = JSON.parse(text) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    workspaces?: unknown;
    private?: boolean;
  };
  const caret = name === "npm" || name === "drizzle";
  const version = readPackageVersion();
  expect(parsed.dependencies?.okmodel).toBe(caret ? `^${version}` : version);
  const pm = name === "bun" ? "bun" : name === "pnpm" ? "pnpm" : "npm";
  const prefix = scriptPrefix(pm);
  expect(parsed.scripts?.["db:check"]).toBe(`${prefix} check`);
  expect(parsed.scripts?.["db:plan"]).toBe(`${prefix} migrate plan`);
  expect(parsed.scripts?.["db:apply"]).toBe(`${prefix} migrate apply`);
  expect(parsed.scripts?.["db:status"]).toBe(`${prefix} migrate status`);
  expect(parsed.scripts?.["db:describe"]).toBeUndefined();
  expect(parsed.scripts?.preinstall).toBe(name === "npm" ? "echo leave-me" : undefined);
  expect(parsed.scripts?.postinstall).toBeUndefined();
  if (name === "npm") {
    expect(parsed.dependencies?.postgres).toBe("^3.4.9");
    expect(parsed.workspaces).toEqual(["packages/*"]);
  }
  if (name === "bun") expect(parsed.dependencies?.postgres).toBeUndefined();
  if (name === "pnpm") expect(parsed.dependencies?.postgres).toBe(peerBare("postgres"));
  if (name === "drizzle") {
    expect(parsed.dependencies?.["drizzle-orm"]).toBe("^0.36.0");
    expect(parsed.dependencies?.postgres).toBe("^3.4.9");
  }
  expect(text).not.toContain("devDependencies");
}

function assertRecord(cwd: string, driver: string, tenancy: string): void {
  const record = JSON.parse(readFileSync(join(cwd, ".okm/init.json"), "utf8")) as {
    version: number;
    choices: { dialect: string; driver: string; dir: string; tenancy: string };
    files: Record<string, string>;
  };
  expect(record.version).toBe(1);
  expect(record.choices).toEqual({ dialect: "postgres", driver, dir: "db", tenancy });
  expect(record.files[".okm/init.json"]).toBeUndefined();
  for (const [path, hash] of Object.entries(record.files)) {
    expect(hash).toBe(contentHash(readFileSync(join(cwd, path), "utf8")));
  }
}

function peerBare(name: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    peerDependencies: Record<string, string>;
  };
  return (pkg.peerDependencies[name] ?? "").replace(/^[\^~]/, "");
}

function treeJson(cwd: string): string {
  const files: Record<string, string> = {};
  for (const path of walk(cwd)) files[path] = readFileSync(join(cwd, path), "utf8");
  return `${JSON.stringify(files, null, 2)}\n`;
}

function treeBytes(cwd: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of walk(cwd)) files[path] = readFileSync(join(cwd, path), "utf8");
  return files;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(base, abs).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      out.push(rel);
      continue;
    }
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else out.push(rel);
  }
  return out.sort();
}

function toCrlf(dir: string): void {
  for (const path of walk(dir)) {
    if (path.endsWith(".lock") || path.endsWith(".yaml")) continue;
    const abs = join(dir, path);
    if (lstatSync(abs).isSymbolicLink()) continue;
    const text = readFileSync(abs, "utf8");
    writeFileSync(abs, lf(text).replaceAll("\n", "\r\n"));
  }
}

function normalize(text: string): string {
  const version = readPackageVersion();
  let out = text.split(version).join("OKMODEL_VERSION");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    peerDependencies: Record<string, string>;
  };
  for (const spec of Object.values(pkg.peerDependencies)) {
    const bare = spec.replace(/^[\^~]/, "");
    if (bare.length > 0) out = out.split(bare).join("PEER");
  }
  return out.replace(/[0-9a-f]{64}/g, "HASH");
}

function expectSnap(name: string, text: string): void {
  const path = join(snaps, name);
  if (!existsSync(path) || process.env.UPDATE_INIT_SNAP === "1") {
    mkdirSync(snaps, { recursive: true });
    writeFileSync(path, text);
  }
  expect(readFileSync(path, "utf8")).toBe(text);
}

function pointAtSource(cwd: string): void {
  const schemaPath = join(root, "src/dialects/pg/index.ts");
  const tenancyPath = join(root, "src/runtime/tenancy/index.ts");
  const migratePath = join(root, "src/tooling/migrate/index.ts");
  const schemaFile = join(cwd, "db/schema.ts");
  writeFileSync(
    schemaFile,
    readFileSync(schemaFile, "utf8")
      .replaceAll('from "okmodel/pg"', `from ${JSON.stringify(schemaPath)}`)
      .replaceAll('from "okmodel/tenancy"', `from ${JSON.stringify(tenancyPath)}`),
  );
  const configFile = join(cwd, "okmodel.config.ts");
  writeFileSync(
    configFile,
    readFileSync(configFile, "utf8").replaceAll(
      'from "okmodel/migrate"',
      `from ${JSON.stringify(migratePath)}`,
    ),
  );
}

function typecheck(cwd: string): void {
  const pkgPath = join(cwd, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  if (pkg.type !== "module") {
    pkg.type = "module";
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  const config = {
    compilerOptions: {
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      allowImportingTsExtensions: true,
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "es2023",
      types: ["bun"],
      skipLibCheck: true,
      noEmit: true,
      paths: {
        okmodel: ["./src/contracts/index.ts"],
        "okmodel/pg": ["./src/dialects/pg/index.ts"],
        "okmodel/tenancy": ["./src/runtime/tenancy/index.ts"],
        "okmodel/migrate": ["./src/tooling/migrate/index.ts"],
        "okmodel/pg/postgresjs": ["./src/runtime/pg/postgresjs.ts"],
      },
    },
    files: [join(cwd, "db/schema.ts"), join(cwd, "db/client.ts"), join(cwd, "okmodel.config.ts")],
  };
  const file = join(root, "tsconfig.init-fixture.json");
  const schemaFile = join(cwd, "db/schema.ts");
  const original = readFileSync(schemaFile, "utf8");
  writeFileSync(file, JSON.stringify(config));
  // Path mapping does not satisfy module augmentation until the file imports the module.
  writeFileSync(schemaFile, `import type {} from "okmodel";\n${original}`);
  try {
    const proc = spawnSync(
      join(root, "node_modules/.bin/tsc"),
      ["--project", file, "--pretty", "false"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 50_000,
      },
    );
    expect(proc.stderr + proc.stdout).toBe("");
    expect(proc.status).toBe(0);
  } finally {
    writeFileSync(schemaFile, original);
    rmSync(file, { force: true });
  }
}
