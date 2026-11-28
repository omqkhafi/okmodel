/**
 * Mapped unique, foreign-key, and check errors across bundlers.
 *
 * Runs on a real Postgres. Not part of `gate / check`: Next.js webpack,
 * Turbopack, Vite, and workerd are too slow for that job. After merge can
 * call `bun run proof:bundlers`. PR CI does not.
 *
 *   DATABASE_URL=postgres://… bun run proof:bundlers
 *
 * Deletes NEON_* and SUPABASE_* from this process before any child starts.
 * It does not print those values.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";

const SECRET = /^(NEON_|SUPABASE_)/;

for (const key of Object.keys(process.env)) {
  if (SECRET.test(key)) delete process.env[key];
}

const root = repoRoot();
const cache = join(root, ".cache", "proof-bundlers");
const url = process.env.DATABASE_URL ?? "postgres://okm:okm@127.0.0.1:55432/okm";
const schemaName = `okm_proof_${Math.random().toString(36).slice(2, 10)}`;

type Row = { readonly bundler: string; readonly result: string; readonly seconds: string };

const rows: Row[] = [];

const appSource = (arm: boolean, fromPackage = false): string => {
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
const schemaName = process.env.OKM_SCHEMA ?? "public";
const users = table("users", { id: t.integer().primaryKey(), email: t.text().unique() });
const notes = table("notes", {
  id: t.integer().primaryKey(),
  userId: t.integer().references("users"),
  title: t.text(),
}, { checks: { title_len: (columns) => sql\`\${columns.title} <> ''\` } });
const app = schema({ casing: "snake", tables: [users, notes] });
${armRead}
function shape(error: unknown): { code?: string; kind?: string; constraint?: string; field?: string; message?: string } {
  if (typeof error !== "object" || error === null) return { message: String(error) };
  const item = error as { code?: string; kind?: string; constraint?: string; fieldReason?: string; message?: string };
  return { code: item.code, kind: item.kind, constraint: item.constraint, field: item.fieldReason, message: item.message };
}
export async function prove() {
  const admin = postgres(url, { max: 1 });
  const ident = schemaName.replaceAll('"', '""');
  await admin.unsafe(\`create schema if not exists "\${ident}"\`);
  await admin.unsafe(\`drop table if exists "\${ident}".notes\`);
  await admin.unsafe(\`drop table if exists "\${ident}".users\`);
  await admin.unsafe(\`create table "\${ident}".users (id integer primary key, email text not null, constraint users_email_key unique (email))\`);
  await admin.unsafe(\`create table "\${ident}".notes (id integer primary key, user_id integer not null, title text not null, constraint notes_user_id_fkey foreign key (user_id) references "\${ident}".users (id), constraint notes_title_len_check check (title <> ''))\`);
  await admin.end({ timeout: 5 });
  const db = connect(url, { schema: app, searchPath: schemaName, max: 1 });
  const out: Record<string, unknown> = { catalogObjects };
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
};

const nodeSource = `
import postgres from "postgres";
import { connect } from ${JSON.stringify(join(root, "dist/runtime/pg/postgresjs.js"))};
import { schema, sql, table, t } from ${JSON.stringify(join(root, "dist/dialects/pg/index.js"))};
const url = process.env.DATABASE_URL ?? "";
const schemaName = process.env.OKM_SCHEMA ?? "public";
const users = table("users", { id: t.integer().primaryKey(), email: t.text().unique() });
const notes = table("notes", {
  id: t.integer().primaryKey(),
  userId: t.integer().references("users"),
  title: t.text(),
}, { checks: { title_len: (columns) => sql\`\${columns.title} <> ''\` } });
const app = schema({ casing: "snake", tables: [users, notes] });
function shape(error: unknown): { code?: string; kind?: string; constraint?: string; field?: string; message?: string } {
  if (typeof error !== "object" || error === null) return { message: String(error) };
  const item = error as { code?: string; kind?: string; constraint?: string; fieldReason?: string; message?: string };
  return { code: item.code, kind: item.kind, constraint: item.constraint, field: item.fieldReason, message: item.message };
}
const admin = postgres(url, { max: 1 });
const ident = schemaName.replaceAll('"', '""');
await admin.unsafe(\`create schema if not exists "\${ident}"\`);
await admin.unsafe(\`drop table if exists "\${ident}".notes\`);
await admin.unsafe(\`drop table if exists "\${ident}".users\`);
await admin.unsafe(\`create table "\${ident}".users (id integer primary key, email text not null, constraint users_email_key unique (email))\`);
await admin.unsafe(\`create table "\${ident}".notes (id integer primary key, user_id integer not null, title text not null, constraint notes_user_id_fkey foreign key (user_id) references "\${ident}".users (id), constraint notes_title_len_check check (title <> ''))\`);
await admin.end({ timeout: 5 });
const db = connect(url, { schema: app, searchPath: schemaName, max: 1 });
const out = {};
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

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, OKM_SCHEMA: schemaName };
  for (const key of Object.keys(env)) {
    if (SECRET.test(key)) delete env[key];
  }
  return env;
}

async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(cmd, { cwd, env: childEnv(), stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  const out = `${await new Response(child.stdout).text()}\n${await new Response(child.stderr).text()}`;
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

async function record(bundler: string, work: () => Promise<string>): Promise<void> {
  const started = Date.now();
  let result = "failed";
  try {
    result = await work();
  } catch (error) {
    result = error instanceof Error ? error.message : String(error);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  rows.push({ bundler, result, seconds });
  process.stdout.write(`${bundler}\t${result}\t${seconds}s\n`);
}

async function bundleAndRun(
  dir: string,
  arm: boolean,
  bundle: (file: string, out: string) => string[],
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "app.ts");
  const out = join(dir, "app.js");
  const cli = join(dir, "cli.ts");
  writeFileSync(file, appSource(arm));
  writeFileSync(
    cli,
    `import { prove } from "./app.ts";\nconsole.log(JSON.stringify(await prove()));\n`,
  );
  const built = await run(bundle(cli, out), dir);
  if (built.code !== 0) return `${built.out.trim().slice(0, 500)}\n${built.out.trim().slice(-400)}`;
  const ran = await run(["node", out], dir);
  if (ran.code !== 0) return ran.out.trim().slice(-500);
  return judge(ran.out, arm);
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
      next: "15.5.4",
      react: "19.1.1",
      "react-dom": "19.1.1",
      postgres: "3.4.9",
      miniflare: "5.20261103.0-beta",
    },
  }),
);
const installed = await run(["bun", "install"], cache);
if (installed.code !== 0) {
  process.stderr.write(installed.out);
  process.exit(1);
}

const packageBuild = await run(["bun", "run", "build"], root);
if (packageBuild.code !== 0) {
  process.stderr.write(packageBuild.out);
  process.exit(1);
}

await record("node unbundled", async () => {
  const dir = join(cache, "node");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.mts"), nodeSource);
  const ran = await run(["node", "--experimental-strip-types", join(dir, "app.mts")], dir);
  if (ran.code !== 0) return ran.out.trim().slice(-500);
  return judge(ran.out, false);
});

await record("esbuild without armCatalog", () =>
  bundleAndRun(join(cache, "esbuild"), false, (_file, out) => [
    join(cache, "node_modules/.bin/esbuild"),
    join(cache, "esbuild", "cli.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${out}`,
    "--external:postgres",
  ]),
);

await record("esbuild with armCatalog", () =>
  bundleAndRun(join(cache, "esbuild-arm"), true, (_file, out) => [
    join(cache, "node_modules/.bin/esbuild"),
    join(cache, "esbuild-arm", "cli.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${out}`,
    "--external:postgres",
  ]),
);

await record("bun build", () =>
  bundleAndRun(join(cache, "bun"), false, (_file, out) => [
    "bun",
    "build",
    join(cache, "bun", "cli.ts"),
    "--target=node",
    `--outfile=${out}`,
    "--external",
    "postgres",
  ]),
);

await record("vite ssr", async () => {
  const dir = join(cache, "vite");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.ts"), appSource(false));
  writeFileSync(
    join(dir, "cli.ts"),
    `import { prove } from "./app.ts";\nconsole.log(JSON.stringify(await prove()));\n`,
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
  if (built.code !== 0) return `${built.out.trim().slice(0, 500)}\n${built.out.trim().slice(-400)}`;
  const ran = await run(["node", join(dir, "dist", "cli.js")], dir);
  if (ran.code !== 0) return ran.out.trim().slice(-500);
  return judge(ran.out, false);
});

async function nextBuild(name: string, turbopack: boolean): Promise<string> {
  const dir = join(cache, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "prove.ts"), appSource(false, true));
  writeFileSync(
    join(dir, "app/route.ts"),
    `import { prove } from "../prove";\nexport const runtime = "nodejs";\nexport async function GET() { return Response.json(await prove()); }\n`,
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
  const linked = await run(["bun", "install"], dir);
  if (linked.code !== 0) return linked.out.trim().slice(-400);
  const args = [join(dir, "node_modules/.bin/next"), "build"];
  if (turbopack) args.push("--turbopack");
  const built = await run(args, dir);
  if (built.code !== 0) return `${built.out.trim().slice(0, 500)}\n${built.out.trim().slice(-400)}`;
  const port = turbopack ? "3456" : "3455";
  const server = Bun.spawn([join(dir, "node_modules/.bin/next"), "start", "-p", port], {
    cwd: dir,
    env: childEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 60_000;
    let body = "";
    while (Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
      if (response !== undefined) {
        body = await response.text();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (body.length === 0) return "next start produced no response";
    return judge(body, false);
  } finally {
    server.kill();
  }
}

await record("next 15 webpack", () => nextBuild("next-webpack", false));
await record("next 15 turbopack", () => nextBuild("next-turbo", true));

await record("workerd", async () => {
  const dir = join(cache, "workerd");
  mkdirSync(dir, { recursive: true });
  const worker = `
import postgres from "postgres";
import { connect } from ${JSON.stringify(join(root, "src/runtime/pg/postgresjs.ts"))};
import { schema, sql, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.workerd.ts"))};
const users = table("users", { id: t.integer().primaryKey(), email: t.text().unique() });
const notes = table("notes", {
  id: t.integer().primaryKey(),
  userId: t.integer().references("users"),
  title: t.text(),
}, { checks: { title_len: (columns) => sql\`\${columns.title} <> ''\` } });
const app = schema({ casing: "snake", tables: [users, notes] });
function shape(error: unknown): { code?: string; kind?: string; constraint?: string; field?: string; message?: string } {
  if (typeof error !== "object" || error === null) return { message: String(error) };
  const item = error as { code?: string; kind?: string; constraint?: string; fieldReason?: string; message?: string };
  return { code: item.code, kind: item.kind, constraint: item.constraint, field: item.fieldReason, message: item.message };
}
export default {
  async fetch() {
    const url = ${JSON.stringify(url)};
    const schemaName = ${JSON.stringify(schemaName)};
    const admin = postgres(url, { max: 1 });
    const ident = schemaName.replaceAll('"', '""');
    await admin.unsafe(\`create schema if not exists "\${ident}"\`);
    await admin.unsafe(\`drop table if exists "\${ident}".notes\`);
    await admin.unsafe(\`drop table if exists "\${ident}".users\`);
    await admin.unsafe(\`create table "\${ident}".users (id integer primary key, email text not null, constraint users_email_key unique (email))\`);
    await admin.unsafe(\`create table "\${ident}".notes (id integer primary key, user_id integer not null, title text not null, constraint notes_user_id_fkey foreign key (user_id) references "\${ident}".users (id), constraint notes_title_len_check check (title <> ''))\`);
    await admin.end({ timeout: 5 });
    const db = connect(url, { schema: app, searchPath: schemaName, max: 1 });
    const out: Record<string, unknown> = {};
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
  if (built.code !== 0) return `${built.out.trim().slice(0, 500)}\n${built.out.trim().slice(-400)}`;
  const host = join(dir, "host.mjs");
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
const response = await fetch(new URL("/", await mf.ready));
const text = await response.text();
console.log(text);
await mf.dispose();
`,
  );
  const ran = await run(["node", host], cache);
  if (ran.code !== 0) return `not proven: ${ran.out.trim().slice(-500)}`;
  return judge(ran.out, false);
});

process.stdout.write("\nbundler\tresult\tseconds\n");
for (const row of rows) process.stdout.write(`${row.bundler}\t${row.result}\t${row.seconds}\n`);

const failed = rows.some((row) => row.result !== "mapped");
if (failed) process.exit(1);
