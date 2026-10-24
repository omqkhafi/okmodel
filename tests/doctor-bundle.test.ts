/**
 * `okm doctor --bundle`: the shape, the redaction scan, determinism, and the
 * flags. No database and no network: the config points at a closed port, and
 * the in-process run blocks every socket.
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { repoRoot } from "../scripts/root.js";
import { parseCli } from "../src/tooling/cli/parse.js";
import { schemaFor, schemaProblems } from "../src/tooling/cli/schema.js";
import { readPackageVersion } from "../src/tooling/cli/version.js";
import { BUNDLE_FORMAT, DEFAULT_BUNDLE_PATH } from "../src/tooling/migrate/doctor-bundle.js";
import { run } from "../src/tooling/migrate/commands.js";

const root = repoRoot();

const SECRETS = [
  "zq_user_8841",
  "zq_pass_9f3a7c",
  "zq-host-5521.internal.example",
  "zq_db_name_3307",
  "zq_ledger_table",
  "zq_ssn_column",
  "4111-1111-1111-1111",
  "zq_env_token_7b2e",
  "zq_dotenv_secret_c19d",
  "postgres://",
  ":5432",
  "SELECT",
  "insert into",
];

const SECRET_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL:
    "postgres://zq_user_8841:zq_pass_9f3a7c@zq-host-5521.internal.example:5432/zq_db_name_3307",
  API_TOKEN: "zq_env_token_7b2e",
};

type Fixture = { readonly dir: string; readonly out: string };

function fixture(options?: { readonly broken?: boolean; readonly bare?: boolean }): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "okm-bundle-")));
  if (options?.bare === true) return { dir, out: join(dir, DEFAULT_BUNDLE_PATH) };
  const schema =
    options?.broken === true
      ? 'throw new Error("zq_ledger_table SELECT 4111-1111-1111-1111");\n'
      : [
          `import { identity, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
          "export const app = schema({",
          "  tables: [",
          '    table("zq_ledger_table", { id: identity(), zq_ssn_column: text() }),',
          '    table("zq_loose_rows", { note: text() }),',
          "  ],",
          "});",
          "// SELECT 4111-1111-1111-1111 from zq_ledger_table",
          "",
        ].join("\n");
  writeFileSync(join(dir, "schema.ts"), schema);
  writeFileSync(
    join(dir, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: { url: ${JSON.stringify(SECRET_ENV.DATABASE_URL?.replace(":5432", ":1"))} },`,
      "});",
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "migrations"));
  if (options?.broken !== true) {
    expect(okm(["generate", "init"], dir).code).toBe(0);
    const sql = readdirSync(join(dir, "migrations")).find((file) => file.endsWith(".sql")) ?? "";
    expect(sql).not.toBe("");
    appendFileSync(join(dir, "migrations", sql), "-- 4111-1111-1111-1111 zq_ledger_table\n");
  }
  writeFileSync(join(dir, ".env"), "SECRET=zq_dotenv_secret_c19d\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "zq-ledger-app", dependencies: { postgres: "^3.4.0" } }),
  );
  writeFileSync(join(dir, "bun.lock"), "");
  mkdirSync(join(dir, "node_modules", "postgres"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "postgres", "package.json"),
    JSON.stringify({ name: "postgres", version: "3.4.5" }),
  );
  mkdirSync(join(dir, ".okm"), { recursive: true });
  writeFileSync(join(dir, ".okm", "catalog.hash"), "abc\n");
  writeFileSync(join(dir, ".okm", "zq_ledger_table.json"), "{}");
  return { dir, out: join(dir, DEFAULT_BUNDLE_PATH) };
}

function okm(args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>) {
  const proc = spawnSync("bun", [join(root, "src/tooling/cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...SECRET_ENV, ...env },
  });
  return { code: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr };
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function keysSorted(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((item) => keysSorted(item));
  if (typeof value !== "object" || value === null) return true;
  const keys = Object.keys(value);
  return (
    keys.every((key, index) => index === 0 || (keys[index - 1] ?? "") < key) &&
    Object.values(value).every((item) => keysSorted(item))
  );
}

function scan(text: string, dir: string): readonly string[] {
  const needles = [...SECRETS, dir, tmpdir(), homedir(), "okm-bundle-", "zq-ledger-app"];
  return needles.filter((needle) => needle.length > 1 && text.includes(needle));
}

test("the bundle has the documented top-level keys and matches its schema", () => {
  const fx = fixture();
  try {
    const result = okm(["doctor", "--bundle"], fx.dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`wrote ${DEFAULT_BUNDLE_PATH}`);
    expect(result.stderr).toBe("");
    const bundle: unknown = JSON.parse(read(fx.out));
    expect(Object.keys(bundle as object)).toEqual([
      "adapters",
      "artifacts",
      "bundleFormat",
      "capabilities",
      "checks",
      "config",
      "dialect",
      "layout",
      "okmodel",
      "packageManager",
      "runtime",
    ]);
    const doctor = schemaFor("doctor");
    const branch = doctor.oneOf?.find((item) => item.required?.includes("bundle"));
    const bundleSchema = branch?.properties?.bundle;
    expect(bundleSchema).toBeDefined();
    expect(schemaProblems(bundleSchema ?? {}, bundle)).toEqual([]);
    expect(bundleSchema?.properties?.bundleFormat?.const).toBe(BUNDLE_FORMAT);
    expect(bundle).toMatchObject({
      bundleFormat: 1,
      okmodel: { version: readPackageVersion() },
      dialect: { name: "postgres", package: "okmodel", version: readPackageVersion() },
      adapters: [{ name: "postgresjs", package: "postgres", version: "3.4.5" }],
      packageManager: "bun",
      config: { file: "okmodel.config.ts", found: true, loaded: true, targets: 1, ambiguous: 0 },
      layout: { monorepo: false, workspacePackages: 0, migrations: 1 },
      runtime: { node: process.versions.node, os: process.platform, arch: process.arch },
    });
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("the bundle holds no secret, name, SQL, or path outside the project", () => {
  const fx = fixture();
  try {
    const result = okm(["doctor", "--bundle"], fx.dir);
    expect(result.code).toBe(0);
    const text = read(fx.out);
    expect(scan(text, fx.dir)).toEqual([]);
    expect(scan(`${result.stdout}${result.stderr}`, fx.dir)).toEqual([]);
    const json = okm(["doctor", "--bundle", "--json", "--out", "-"], fx.dir);
    expect(json.code).toBe(0);
    expect(scan(json.stdout, fx.dir)).toEqual([]);
    for (const value of Object.values(SECRET_ENV)) expect(text).not.toContain(value);
    const bundle = JSON.parse(text) as {
      readonly artifacts: readonly { readonly name: string }[];
      readonly checks: { readonly codes: readonly string[] };
    };
    expect(bundle.artifacts.map((item) => item.name)).toEqual([
      "catalog.hash",
      "catalog.json",
      "types.d.ts",
    ]);
    expect(bundle.checks.codes.every((code) => /^(OKM\d{4}|coupling|unknown)$/.test(code))).toBe(
      true,
    );
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("the same project writes the same bytes, with sorted keys", () => {
  const fx = fixture();
  try {
    expect(okm(["doctor", "--bundle"], fx.dir).code).toBe(0);
    const first = read(fx.out);
    expect(okm(["doctor", "--bundle", "--force-file"], fx.dir).code).toBe(0);
    expect(read(fx.out)).toBe(first);
    expect(keysSorted(JSON.parse(first))).toBe(true);
    expect(first.endsWith("\n")).toBe(true);
    expect(read(fx.out)).toBe(read(fx.out));
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("check results list every rule, and the loose table fails OKM2102", () => {
  const fx = fixture();
  try {
    expect(okm(["doctor", "--bundle"], fx.dir).code).toBe(0);
    const bundle = JSON.parse(read(fx.out)) as {
      readonly checks: {
        readonly codes: readonly string[];
        readonly result: string;
        readonly rules: Readonly<Record<string, { result: string; severity: string }>>;
        readonly scope: string;
      };
    };
    expect(bundle.checks.scope).toBe("offline");
    expect(bundle.checks.codes).toContain("OKM2102");
    expect(bundle.checks.rules.OKM2102).toEqual({ result: "fail", severity: "warning" });
    expect(bundle.checks.rules.OKM1511).toEqual({ result: "pass", severity: "error" });
    expect(bundle.checks.rules.OKM2101?.result).toBe("pass");
    expect(bundle.checks.result).toBe("pass");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a schema that does not load still writes a bundle with a closed code", () => {
  const fx = fixture({ broken: true });
  try {
    const result = okm(["doctor", "--bundle"], fx.dir);
    expect(result.code).toBe(0);
    const text = read(fx.out);
    expect(scan(text, fx.dir)).toEqual([]);
    const bundle = JSON.parse(text) as {
      readonly checks: { readonly failures: readonly string[]; readonly result: string };
      readonly config: { readonly loaded: boolean };
    };
    expect(bundle.config.loaded).toBe(true);
    expect(bundle.checks.failures).toEqual(["unknown"]);
    expect(bundle.checks.result).toBe("fail");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a directory with no project still writes a bundle", () => {
  const fx = fixture({ bare: true });
  try {
    const result = okm(["doctor", "--bundle"], fx.dir);
    expect(result.code).toBe(0);
    const bundle = JSON.parse(read(fx.out)) as {
      readonly config: { readonly found: boolean; readonly file: string | null };
      readonly packageManager: string;
      readonly adapters: readonly unknown[];
    };
    expect(bundle.config).toMatchObject({ found: false, file: null, loaded: false });
    expect(bundle.packageManager).toBe("unknown");
    expect(bundle.adapters).toEqual([]);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a package inside a workspace reports the monorepo layout", () => {
  const fx = fixture({ bare: true });
  try {
    writeFileSync(join(fx.dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    writeFileSync(join(fx.dir, "pnpm-lock.yaml"), "");
    const app = join(fx.dir, "packages", "zq-app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "zq-app" }));
    writeFileSync(join(app, "okmodel.config.ts"), "export default {};\n");
    const result = okm(["doctor", "--bundle"], app);
    expect(result.code).toBe(0);
    const text = read(join(app, DEFAULT_BUNDLE_PATH));
    expect(scan(text, fx.dir)).toEqual([]);
    expect(text).not.toContain("zq-app");
    expect(JSON.parse(text)).toMatchObject({
      layout: { monorepo: true, workspacePackages: 1, configInWorkspaceRoot: false },
      packageManager: "pnpm",
    });
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("an existing file is refused without --force-file", () => {
  const fx = fixture();
  try {
    expect(okm(["doctor", "--bundle"], fx.dir).code).toBe(0);
    writeFileSync(fx.out, "kept\n");
    const refused = okm(["doctor", "--bundle"], fx.dir);
    expect(refused.code).toBe(4);
    expect(refused.stderr).toContain("OKM1855");
    expect(refused.stderr).toContain("already exists");
    expect(refused.stderr).toContain("--force-file");
    expect(read(fx.out)).toBe("kept\n");
    const json = okm(["doctor", "--bundle", "--json"], fx.dir);
    expect(json.code).toBe(4);
    expect(JSON.parse(json.stdout).errors[0].code).toBe("OKM1855");
    expect(read(fx.out)).toBe("kept\n");
    expect(okm(["doctor", "--bundle", "--force-file"], fx.dir).code).toBe(0);
    expect(read(fx.out)).not.toBe("kept\n");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a symlink at the bundle path that leaves the project is not followed", () => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), "okm-bundle-out-"));
  const target = join(outside, "escaped.json");
  writeFileSync(target, "secret\n");
  try {
    symlinkSync(target, fx.out);
    const escaped = okm(["doctor", "--bundle", "--force-file"], fx.dir);
    expect(escaped.code).not.toBe(0);
    expect(escaped.stderr).toContain("symlink");
    expect(read(target)).toBe("secret\n");

    rmSync(fx.out);
    const inside = join(fx.dir, ".okm", "inside.json");
    writeFileSync(inside, "old\n");
    symlinkSync(inside, fx.out);
    expect(okm(["doctor", "--bundle", "--force-file"], fx.dir).code).toBe(0);
    expect(read(inside)).toContain("bundleFormat");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("--out sets the path, and --json keeps the envelope free of a target", () => {
  const fx = fixture();
  try {
    const custom = okm(["doctor", "--bundle", "--out", "sent/bundle.json"], fx.dir);
    expect(custom.code).toBe(0);
    expect(existsSync(join(fx.dir, "sent/bundle.json"))).toBe(true);
    expect(existsSync(fx.out)).toBe(false);
    const json = okm(["doctor", "--bundle", "--json", "--out", "second.json"], fx.dir);
    expect(json.code).toBe(0);
    const envelope = JSON.parse(json.stdout) as {
      readonly command: string;
      readonly data: { readonly bundle: unknown };
      readonly outFile: { readonly path: string; readonly bytes: number };
      readonly target?: unknown;
    };
    expect(envelope.command).toBe("doctor");
    expect("target" in envelope).toBe(false);
    expect(envelope.outFile.path).toBe("second.json");
    expect(envelope.outFile.bytes).toBe(Buffer.byteLength(read(join(fx.dir, "second.json"))));
    expect(JSON.parse(read(join(fx.dir, "second.json")))).toEqual(envelope.data.bundle);
    expect(schemaProblems(schemaFor("doctor"), envelope.data)).toEqual([]);
    expect(scan(json.stdout, fx.dir)).toEqual([]);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("the bundle runs with every socket blocked", async () => {
  const fx = fixture();
  const connect = net.connect;
  const create = net.createConnection;
  const fetched = globalThis.fetch;
  const blocked: string[] = [];
  const boom = ((): never => {
    blocked.push("socket");
    throw new Error("network is not allowed");
  }) as typeof net.connect;
  net.connect = boom;
  net.createConnection = boom as typeof net.createConnection;
  globalThis.fetch = (() => {
    blocked.push("fetch");
    throw new Error("network is not allowed");
  }) as unknown as typeof fetch;
  try {
    let text = "";
    await run(["doctor", "--bundle"], { cwd: fx.dir, stdout: (chunk) => (text += chunk) });
    expect(text).toContain("wrote");
    expect(blocked).toEqual([]);
    expect(existsSync(fx.out)).toBe(true);
  } finally {
    net.connect = connect;
    net.createConnection = create;
    globalThis.fetch = fetched;
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("the bundle module imports no adapter, driver, or network module", () => {
  const source = readFileSync(join(root, "src/tooling/migrate/doctor-bundle.ts"), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? "");
  for (const name of imports) {
    expect(name).not.toMatch(
      /adapters\/|^node:(net|http|https|http2|dns|tls|dgram|child_process)$|^postgres$|^pg$/,
    );
  }
});

test("flags that do not fit --bundle are usage errors, and plain doctor is unchanged", () => {
  const fx = fixture();
  try {
    const code = okm(["doctor", "--bundle", "OKM1020"], fx.dir);
    expect(code.code).toBe(2);
    expect(code.stderr).toContain("--bundle does not take an error code");
    const target = okm(["doctor", "--bundle", "--target", "default"], fx.dir);
    expect(target.code).toBe(2);
    expect(target.stderr).toContain("--bundle does not connect");
    const force = okm(["doctor", "--force-file"], fx.dir);
    expect(force.code).toBe(2);
    expect(force.stderr).toContain("--force-file needs --bundle");
    const out = okm(["doctor", "--out", "x.json"], fx.dir);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("--out needs --json");
    expect(existsSync(fx.out)).toBe(false);
    const explained = okm(["doctor", "OKM1020"], fx.dir);
    expect(explained.code).toBe(0);
    expect(explained.stdout).toContain("OKM1020");
    const parsed = parseCli(["doctor", "--bundle", "--force-file", "--out", "b.json"]);
    expect(parsed).toMatchObject({ bundle: true, overwrite: true, out: "b.json", forceFile: [] });
    expect(parseCli(["init", "--force-file", "a.ts"])).toMatchObject({
      overwrite: false,
      forceFile: ["a.ts"],
    });
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
