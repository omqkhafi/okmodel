/**
 * Mapped unique, foreign-key, and check errors across bundlers.
 *
 * Runs on a real Postgres. Not part of `gate / check`: Next.js webpack,
 * Turbopack, Vite, and workerd are too slow for that job. After merge can
 * call `bun run proof:bundlers`. PR CI does not.
 *
 * One extra row builds `okmodel/pg/pglite` for the browser with webpack
 * `target: "web"` and Vite. That row does not open a database. Its result
 * is `built`.
 *
 *   DATABASE_URL=postgres://… bun run proof:bundlers
 *
 * Before the mapped-error checks, `okm generate` and `okm migrate apply`
 * record a catalog hash in `okm_meta` on a scratch database. Each bundler
 * then connects three ways: no artifact (the compiler path), `.okm` files
 * from `okm build`, and the `catalog` option. Workerd runs only the ways
 * that need no filesystem.
 *
 * Deletes NEON_* and SUPABASE_* from this process before any child starts.
 * It does not print those values, or connection URLs.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { startupHash } from "../src/contracts/catalog/document.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { apply } from "../src/tooling/migrate/api.js";
import { generateProject } from "../src/tooling/migrate/project.js";
import { repoRoot } from "./root.js";

const SECRET = /^(NEON_|SUPABASE_)/;

for (const key of Object.keys(process.env)) {
  if (SECRET.test(key)) delete process.env[key];
}

/** Bun that is running this process. Children must not resolve `bun` from PATH. */
function bunBin(): string {
  return process.execPath;
}

const root = repoRoot();
const cache = join(root, ".cache", "proof-bundlers");
const adminUrl = process.env.DATABASE_URL ?? "postgres://okm:okm@127.0.0.1:55432/okm";
const databaseName = `okm_proof_${Math.random().toString(36).slice(2, 10)}`;

type Variant = "compile" | "files" | "option";

const VARIANTS: readonly Variant[] = ["compile", "files", "option"];

/** Workerd has no project directory, so the file artifact is not a row. */
const WORKERD_VARIANTS: readonly Variant[] = ["compile", "option"];

type Row = {
  readonly bundler: string;
  readonly variant: string;
  readonly result: string;
  readonly seconds: string;
};

const rows: Row[] = [];

let appUrl = adminUrl;
let artifactDir = "";
let databaseCreated = false;
let catalogArtifact: { readonly hash: string; readonly text: string } = { hash: "", text: "" };

const SCHEMA_TABLES = `
const users = table("users", { id: t.integer().primaryKey(), email: t.text().unique() });
const notes = table("notes", {
  id: t.integer().primaryKey(),
  userId: t.integer().references("users"),
  title: t.text(),
}, { checks: { title_len: (columns) => sql\`\${columns.title} <> ''\` } });
const app = schema({ casing: "snake", tables: [users, notes] });
`;

function redact(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s'")]+/gi, "postgres://…");
}

function schemaModule(from: string, exportApp: boolean): string {
  const declaration = exportApp ? "export const app" : "const app";
  return `import { schema, sql, table, t } from ${JSON.stringify(from)};
${SCHEMA_TABLES.replace("const app", declaration)}
`;
}

function appSource(arm: boolean, fromPackage = false): string {
  const schemaFrom = fromPackage ? "okmodel/pg" : join(root, "src/dialects/pg/index.ts");
  const connectFrom = fromPackage
    ? "okmodel/pg/postgresjs"
    : join(root, "src/runtime/pg/postgresjs.ts");
  const armFrom = fromPackage ? "okmodel/pg/catalog" : join(root, "src/dialects/pg/catalog-arm.ts");
  const armImport = arm
    ? `import { armCatalog } from ${JSON.stringify(armFrom)};\narmCatalog();\n`
    : "";
  const armRead = arm
    ? "const catalogObjects = app.catalog.objects.length;\n"
    : "const catalogObjects = 0;\n";
  return `
import postgres from "postgres";
import { connect } from ${JSON.stringify(connectFrom)};
import { schema, sql, table, t } from ${JSON.stringify(schemaFrom)};
${armImport}
const url = process.env.DATABASE_URL ?? "";
${SCHEMA_TABLES}
${armRead}
const catalogArtifact = ${JSON.stringify(catalogArtifact)};
function shape(error: unknown): { code?: string; kind?: string; constraint?: string; field?: string; message?: string } {
  if (typeof error !== "object" || error === null) return { message: String(error) };
  const item = error as { code?: string; kind?: string; constraint?: string; fieldReason?: string; message?: string };
  return { code: item.code, kind: item.kind, constraint: item.constraint, field: item.fieldReason, message: item.message };
}
function openClient(variant: string) {
  const base = { schema: app, max: 1 };
  if (variant === "option") return connect(url, { ...base, catalog: catalogArtifact });
  if (variant === "files") return connect(url, { ...base, catalogDir: process.env.OKM_CATALOG_DIR });
  return connect(url, base);
}
export async function prove(variant: string) {
  const admin = postgres(url, { max: 1 });
  await admin.unsafe("truncate table notes, users");
  await admin.end({ timeout: 5 });
  const db = openClient(variant);
  const out: Record<string, unknown> = { catalogObjects, variant };
  try {
    await db.users.insert({ id: 1, email: "a@b.c" });
    try { await db.users.insert({ id: 2, email: "a@b.c" }); out.unique = { ok: false }; }
    catch (error) { out.unique = shape(error); }
    try { await db.notes.insert({ id: 1, userId: 9, title: "x" }); out.foreignKey = { ok: false }; }
    catch (error) { out.foreignKey = shape(error); }
    try { await db.notes.insert({ id: 2, userId: 1, title: "" }); out.check = { ok: false }; }
    catch (error) { out.check = shape(error); }
  } finally {
    await db.close();
  }
  return out;
}
`;
}

function nodeSource(): string {
  return `
import postgres from "postgres";
import { connect } from ${JSON.stringify(join(root, "dist/runtime/pg/postgresjs.js"))};
import { schema, sql, table, t } from ${JSON.stringify(join(root, "dist/dialects/pg/index.js"))};
const url = process.env.DATABASE_URL ?? "";
${SCHEMA_TABLES}
const catalogArtifact = ${JSON.stringify(catalogArtifact)};
function shape(error: unknown): { code?: string; kind?: string; constraint?: string; field?: string; message?: string } {
  if (typeof error !== "object" || error === null) return { message: String(error) };
  const item = error as { code?: string; kind?: string; constraint?: string; fieldReason?: string; message?: string };
  return { code: item.code, kind: item.kind, constraint: item.constraint, field: item.fieldReason, message: item.message };
}
function openClient(variant: string) {
  const base = { schema: app, max: 1 };
  if (variant === "option") return connect(url, { ...base, catalog: catalogArtifact });
  if (variant === "files") return connect(url, { ...base, catalogDir: process.env.OKM_CATALOG_DIR });
  return connect(url, base);
}
const variant = process.argv[2] ?? "compile";
const admin = postgres(url, { max: 1 });
await admin.unsafe("truncate table notes, users");
await admin.end({ timeout: 5 });
const db = openClient(variant);
const out: Record<string, unknown> = { variant };
try {
  await db.users.insert({ id: 1, email: "a@b.c" });
  try { await db.users.insert({ id: 2, email: "a@b.c" }); out.unique = { ok: false }; }
  catch (error) { out.unique = shape(error); }
  try { await db.notes.insert({ id: 1, userId: 9, title: "x" }); out.foreignKey = { ok: false }; }
  catch (error) { out.foreignKey = shape(error); }
  try { await db.notes.insert({ id: 2, userId: 1, title: "" }); out.check = { ok: false }; }
  catch (error) { out.check = shape(error); }
} finally {
  await db.close();
}
console.log(JSON.stringify(out));
`;
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: appUrl,
    OKM_CATALOG_DIR: artifactDir,
  };
  for (const key of Object.keys(env)) {
    if (SECRET.test(key)) delete env[key];
  }
  return env;
}

async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(cmd, { cwd, env: childEnv(), stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  const out = redact(
    `${await new Response(child.stdout).text()}\n${await new Response(child.stderr).text()}`,
  );
  return { code, out };
}

function judge(text: string, arm: boolean): string {
  const line = text
    .trim()
    .split("\n")
    .findLast((item) => item.startsWith("{"));
  if (line === undefined) return text.trim().slice(-400) || "no json";
  let body: {
    unique?: { kind?: string; constraint?: string; field?: string };
    foreignKey?: { kind?: string; constraint?: string; field?: string };
    check?: { kind?: string; constraint?: string; field?: string };
    catalogObjects?: number;
  };
  try {
    body = JSON.parse(line) as typeof body;
  } catch {
    return line.slice(0, 400);
  }
  const want = [
    ["unique", "unique", "users_email_key", "email"],
    ["foreignKey", "foreign_key", "notes_user_id_fkey", "user_id"],
    ["check", "check", "notes_title_len_check", "title_len"],
  ] as const;
  const bad: string[] = [];
  for (const [key, kind, constraint, field] of want) {
    const row = body[key];
    if (row?.kind !== kind || row.constraint !== constraint || row.field !== field) {
      bad.push(`${key}=${JSON.stringify(row)}`);
    }
  }
  if (arm && (body.catalogObjects ?? 0) < 1) bad.push("catalog read failed");
  return bad.length === 0 ? "mapped" : bad.join("; ");
}

async function record(
  bundler: string,
  variant: string,
  work: () => Promise<string>,
): Promise<void> {
  const started = Date.now();
  let result = "failed";
  try {
    result = await work();
  } catch (error) {
    result = error instanceof Error ? error.message : String(error);
  }
  result = redact(result).replaceAll("\n", " ").slice(0, 500);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  rows.push({ bundler, variant, result, seconds });
  process.stdout.write(`${bundler}\t${variant}\t${result}\t${seconds}s\n`);
}

function failVariants(bundler: string, variants: readonly Variant[], message: string): void {
  const result = redact(message).replaceAll("\n", " ").slice(0, 500);
  for (const variant of variants) {
    rows.push({ bundler, variant, result, seconds: "0.0" });
    process.stdout.write(`${bundler}\t${variant}\t${result}\t0.0s\n`);
  }
}

function databaseUrl(base: string, name: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${name}`;
  return parsed.href;
}

/**
 * One browser-target row: webpack `target: "web"` and a Vite library build
 * of an app that imports `okmodel/pg/pglite`. Neither build opens a database.
 * Success is `built`. The row is not part of `gate / check`.
 */
async function browserWebTarget(): Promise<void> {
  await record("browser web", "pglite", async () => {
    const dir = join(cache, "browser");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ private: true, type: "module", dependencies: { okmodel: `file:${root}` } }),
    );
    writeFileSync(
      join(dir, "app.mjs"),
      `import { connect } from "okmodel/pg/pglite";\nexport { connect };\n`,
    );
    writeFileSync(
      join(dir, "webpack.config.mjs"),
      `import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
export default {
  mode: "production",
  target: "web",
  context: dir,
  entry: "./app.mjs",
  output: { path: path.join(dir, "webpack-dist"), filename: "app.js" },
  externals: ({ request }, callback) => {
    if (typeof request === "string" && (request === "@electric-sql/pglite" || request.startsWith("@electric-sql/pglite/"))) {
      callback(null, "pglite");
      return;
    }
    callback();
  },
};
`,
    );
    writeFileSync(
      join(dir, "vite.config.mjs"),
      `import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL("./app.mjs", import.meta.url)),
      formats: ["es"],
      fileName: "app",
    },
    target: "es2022",
    outDir: "vite-dist",
    emptyOutDir: true,
    rollupOptions: {
      external: (id) => id === "@electric-sql/pglite" || id.startsWith("@electric-sql/pglite/"),
    },
  },
});
`,
    );
    const linked = await run([bunBin(), "install"], dir);
    if (linked.code !== 0) return linked.out.trim().slice(-400);
    const webpack = await run(
      [join(cache, "node_modules/.bin/webpack"), "--config", join(dir, "webpack.config.mjs")],
      dir,
    );
    if (webpack.code !== 0) return `webpack: ${webpack.out.trim().slice(-400)}`;
    const vite = await run(
      [join(cache, "node_modules/.bin/vite"), "build", "--config", join(dir, "vite.config.mjs")],
      dir,
    );
    if (vite.code !== 0) return `vite: ${vite.out.trim().slice(-400)}`;
    return "built";
  });
}

async function prepareDatabase(): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error("refusing an unexpected database name");
  }
  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin.unsafe(`create database "${databaseName}"`);
    databaseCreated = true;
  } finally {
    await admin.end({ timeout: 5 });
  }
  appUrl = databaseUrl(adminUrl, databaseName);
  const project = join(cache, "project");
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  const schemaFrom = join(root, "src/dialects/pg/index.ts");
  const configFrom = join(root, "src/tooling/migrate/index.ts");
  writeFileSync(
    join(project, "okmodel.config.ts"),
    `import { defineConfig } from ${JSON.stringify(configFrom)};
export default defineConfig({
  schema: "./schema.ts",
  migrations: "./migrations",
  out: "./.okm",
  database: ${JSON.stringify(appUrl)},
});
`,
  );
  writeFileSync(join(project, "schema.ts"), schemaModule(schemaFrom, true));
  const generated = await generateProject(project, "init", []);
  if (generated === undefined) throw new Error("okm generate wrote no migration");
  const errors = generated.findings.filter((finding) => finding.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((finding) => finding.reason).join("; "));
  }
  await apply({ cwd: project });
  artifactDir = join(project, ".okm");
  const hash = readFileSync(join(artifactDir, "catalog.hash"), "utf8").trim();
  const text = readFileSync(join(artifactDir, "catalog.json"), "utf8");
  catalogArtifact = { hash, text };
  const loaded = (await import(`${pathToFileURL(join(project, "schema.ts")).href}?okm=proof`)) as {
    app?: { readonly catalog: Catalog };
  };
  if (loaded.app === undefined) throw new Error("project schema did not export app");
  const compiled = startupHash(loaded.app.catalog);
  const check = postgres(appUrl, { max: 1 });
  try {
    const recorded = await check<{ catalog_hash: string }[]>`
      select catalog_hash from okm_meta where id = 'head'
    `;
    const stored = recorded[0]?.catalog_hash;
    if (stored === undefined || stored.length === 0) {
      throw new Error("apply did not record a catalog hash");
    }
    if (stored !== hash || stored !== compiled) {
      throw new Error("catalog hash from apply, okm build, and schema() did not match");
    }
  } finally {
    await check.end({ timeout: 5 });
  }
}

async function dropDatabase(): Promise<void> {
  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function bundleAndRun(
  bundler: string,
  dir: string,
  arm: boolean,
  bundle: (file: string, out: string) => string[],
): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "app.ts");
  const out = join(dir, "app.js");
  const cli = join(dir, "cli.ts");
  writeFileSync(file, appSource(arm));
  writeFileSync(
    cli,
    `import { prove } from "./app.ts";\nconst variant = process.argv[2] ?? "compile";\nconsole.log(JSON.stringify(await prove(variant)));\n`,
  );
  const built = await run(bundle(cli, out), dir);
  if (built.code !== 0) {
    failVariants(bundler, VARIANTS, built.out.trim().slice(-500));
    return;
  }
  for (const variant of VARIANTS) {
    await record(bundler, variant, async () => {
      const ran = await run(["node", out, variant], dir);
      if (ran.code !== 0) return ran.out.trim().slice(-500);
      return judge(ran.out, arm);
    });
  }
}

mkdirSync(cache, { recursive: true });
writeFileSync(
  join(cache, "package.json"),
  JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      esbuild: "0.25.5",
      vite: "6.3.5",
      webpack: "5.97.1",
      "webpack-cli": "6.0.1",
      next: "15.5.4",
      react: "19.1.1",
      "react-dom": "19.1.1",
      postgres: "3.4.9",
      miniflare: "5.20261103.0-beta",
    },
  }),
);
const installed = await run([bunBin(), "install"], cache);
if (installed.code !== 0) {
  process.stderr.write(installed.out);
  process.exit(1);
}

const packageBuild = await run([bunBin(), "run", "build"], root);
if (packageBuild.code !== 0) {
  process.stderr.write(packageBuild.out);
  process.exit(1);
}

try {
  await browserWebTarget();
  await prepareDatabase();

  await (async () => {
    const dir = join(cache, "node");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.mts"), nodeSource());
    for (const variant of VARIANTS) {
      await record("node unbundled", variant, async () => {
        const ran = await run(
          ["node", "--experimental-strip-types", join(dir, "app.mts"), variant],
          dir,
        );
        if (ran.code !== 0) return ran.out.trim().slice(-500);
        return judge(ran.out, false);
      });
    }
  })();

  await bundleAndRun("esbuild", join(cache, "esbuild"), false, (_file, out) => [
    join(cache, "node_modules/.bin/esbuild"),
    join(cache, "esbuild", "cli.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${out}`,
    "--external:postgres",
  ]);

  await bundleAndRun("esbuild armCatalog", join(cache, "esbuild-arm"), true, (_file, out) => [
    join(cache, "node_modules/.bin/esbuild"),
    join(cache, "esbuild-arm", "cli.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${out}`,
    "--external:postgres",
  ]);

  await bundleAndRun("bun build", join(cache, "bun"), false, (_file, out) => [
    bunBin(),
    "build",
    join(cache, "bun", "cli.ts"),
    "--target=node",
    `--outfile=${out}`,
    "--external",
    "postgres",
  ]);

  await (async () => {
    const dir = join(cache, "vite");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.ts"), appSource(false));
    // No top-level await. Vite's SSR chunks import catalog predicates from this
    // entry. Node 22 exits 13 if the entry is still awaiting when that import runs.
    writeFileSync(
      join(dir, "cli.ts"),
      `import { prove } from "./app.ts";
const variant = process.argv[2] ?? "compile";
prove(variant).then(
  (out) => {
    console.log(JSON.stringify(out));
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
`,
    );
    writeFileSync(
      join(dir, "vite.config.mjs"),
      `export default { server: { fs: { allow: [${JSON.stringify(root)}] } }, build: { target: "node22", rollupOptions: { external: ["postgres"] } } };\n`,
    );
    const built = await run(
      [
        join(cache, "node_modules/.bin/vite"),
        "build",
        "--ssr",
        join(dir, "cli.ts"),
        "--outDir",
        join(dir, "dist"),
      ],
      dir,
    );
    if (built.code !== 0) {
      failVariants("vite ssr", VARIANTS, built.out.trim().slice(-500));
      return;
    }
    for (const variant of VARIANTS) {
      await record("vite ssr", variant, async () => {
        const ran = await run(["node", join(dir, "dist", "cli.js"), variant], dir);
        if (ran.code !== 0) return ran.out.trim().slice(-500);
        return judge(ran.out, false);
      });
    }
  })();

  async function nextBuild(name: string, turbopack: boolean): Promise<void> {
    const bundler = `next 15 ${name}`;
    const dir = join(cache, `next-${name}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "prove.ts"), appSource(false, true));
    writeFileSync(
      join(dir, "app/route.ts"),
      `import { prove } from "../prove";\nexport const runtime = "nodejs";\nexport async function GET(request: Request) {\n  const variant = new URL(request.url).searchParams.get("variant") ?? "compile";\n  return Response.json(await prove(variant));\n}\n`,
    );
    writeFileSync(
      join(dir, "next.config.mjs"),
      `const config = { serverExternalPackages: ["postgres"], outputFileTracingRoot: import.meta.dirname, turbopack: { root: import.meta.dirname }, typescript: { ignoreBuildErrors: true }, eslint: { ignoreDuringBuilds: true } };\nexport default config;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          jsx: "preserve",
          skipLibCheck: true,
          noEmit: true,
        },
      })}\n`,
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          next: "15.5.4",
          react: "19.1.1",
          "react-dom": "19.1.1",
          postgres: "3.4.9",
          typescript: "5.8.3",
          "@types/react": "19.1.1",
          "@types/node": "22.15.3",
          okmodel: `file:${root}`,
        },
      }),
    );
    const linked = await run([bunBin(), "install"], dir);
    if (linked.code !== 0) {
      failVariants(bundler, VARIANTS, linked.out.trim().slice(-400));
      return;
    }
    const args = [join(dir, "node_modules/.bin/next"), "build"];
    if (turbopack) args.push("--turbopack");
    const built = await run(args, dir);
    if (built.code !== 0) {
      failVariants(bundler, VARIANTS, built.out.trim().slice(-500));
      return;
    }
    const port = turbopack ? "3456" : "3455";
    const server = Bun.spawn([join(dir, "node_modules/.bin/next"), "start", "-p", port], {
      cwd: dir,
      env: childEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      for (const variant of VARIANTS) {
        await record(bundler, variant, async () => {
          const deadline = Date.now() + 60_000;
          let body = "";
          while (Date.now() < deadline) {
            const response = await fetch(`http://127.0.0.1:${port}/?variant=${variant}`).catch(
              () => undefined,
            );
            if (response !== undefined) {
              body = await response.text();
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          if (body.length === 0) return "next start produced no response";
          return judge(body, false);
        });
      }
    } finally {
      server.kill();
    }
  }

  await nextBuild("webpack", false);
  await nextBuild("turbopack", true);

  await (async () => {
    const dir = join(cache, "workerd");
    mkdirSync(dir, { recursive: true });
    const worker = `
import postgres from "postgres";
import { connect } from ${JSON.stringify(join(root, "src/runtime/pg/postgresjs.ts"))};
import { schema, sql, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.workerd.ts"))};
${SCHEMA_TABLES}
const catalogArtifact = ${JSON.stringify(catalogArtifact)};
function shape(error: unknown): { code?: string; kind?: string; constraint?: string; field?: string; message?: string } {
  if (typeof error !== "object" || error === null) return { message: String(error) };
  const item = error as { code?: string; kind?: string; constraint?: string; fieldReason?: string; message?: string };
  return { code: item.code, kind: item.kind, constraint: item.constraint, field: item.fieldReason, message: item.message };
}
function openClient(variant: string) {
  const url = ${JSON.stringify(appUrl)};
  const base = { schema: app, max: 1 };
  if (variant === "option") return connect(url, { ...base, catalog: catalogArtifact });
  return connect(url, base);
}
export default {
  async fetch(request: Request) {
    const variant = new URL(request.url).searchParams.get("variant") ?? "compile";
    const url = ${JSON.stringify(appUrl)};
    const admin = postgres(url, { max: 1 });
    await admin.unsafe("truncate table notes, users");
    await admin.end({ timeout: 5 });
    const db = openClient(variant);
    const out: Record<string, unknown> = { variant };
    try {
      await db.users.insert({ id: 1, email: "a@b.c" });
      try { await db.users.insert({ id: 2, email: "a@b.c" }); out.unique = { ok: false }; }
      catch (error) { out.unique = shape(error); }
      try { await db.notes.insert({ id: 1, userId: 9, title: "x" }); out.foreignKey = { ok: false }; }
      catch (error) { out.foreignKey = shape(error); }
      try { await db.notes.insert({ id: 2, userId: 1, title: "" }); out.check = { ok: false }; }
      catch (error) { out.check = shape(error); }
    } finally {
      await db.close();
    }
    return Response.json(out);
  },
};
`;
    writeFileSync(join(dir, "worker.ts"), worker);
    const out = join(dir, "worker.js");
    const built = await run(
      [
        join(cache, "node_modules/.bin/esbuild"),
        join(dir, "worker.ts"),
        "--bundle",
        "--format=esm",
        "--platform=node",
        `--outfile=${out}`,
      ],
      dir,
    );
    if (built.code !== 0) {
      failVariants("workerd", WORKERD_VARIANTS, built.out.trim().slice(-500));
      return;
    }
    for (const variant of WORKERD_VARIANTS) {
      await record("workerd", variant, async () => {
        const host = join(dir, `host-${variant}.mjs`);
        writeFileSync(
          host,
          `
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: readFileSync(${JSON.stringify(out)}, "utf8"),
  compatibilityDate: "2026-11-03",
  compatibilityFlags: ["nodejs_compat"],
}));
const response = await fetch(new URL(${JSON.stringify(`/?variant=${variant}`)}, await mf.ready));
const text = await response.text();
console.log(text);
await mf.dispose();
`,
        );
        const ran = await run(["node", host], cache);
        if (ran.code !== 0) return `not proven: ${ran.out.trim().slice(-500)}`;
        return judge(ran.out, false);
      });
    }
  })();
} finally {
  if (databaseCreated) {
    await dropDatabase().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`drop database failed: ${redact(message)}\n`);
    });
  }
}

process.stdout.write("\nbundler\tvariant\tresult\tseconds\n");
for (const row of rows) {
  process.stdout.write(`${row.bundler}\t${row.variant}\t${row.result}\t${row.seconds}\n`);
}

const failed = rows.some((row) => row.result !== "mapped" && row.result !== "built");
if (failed) process.exit(1);
