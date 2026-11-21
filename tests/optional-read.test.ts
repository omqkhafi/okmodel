/**
 * The optional reads `okm generate` and `okm migrate plan` make of a target
 * (D194, D329): a 3 second connect bound, one stderr note, nothing else moves.
 *
 * The blackhole is a local TCP server that accepts and never answers. The
 * closed port is a port nothing listens on. No real network is used.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "bun:test";

import { repoRoot } from "../scripts/root.js";
import { collectNotices } from "../src/tooling/cli/notices.js";
import { skippableRead } from "../src/tooling/migrate/optional-read.js";
import { generateProject, planProject } from "../src/tooling/migrate/project.js";

const root = repoRoot();
const NOTE = "note: target unreachable, so this plan has no row estimates and no live comparison";

let blackhole: net.Server;
let blackholeUrl = "";
let closedUrl = "";
const sockets = new Set<net.Socket>();
let accepted = 0;
const dirs: string[] = [];

beforeAll(async () => {
  blackhole = net.createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
  blackholeUrl = `postgres://okm:okm@127.0.0.1:${String((blackhole.address() as net.AddressInfo).port)}/okm`;
  const spare = net.createServer();
  await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
  const port = (spare.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => spare.close(() => resolve()));
  closedUrl = `postgres://okm:okm@127.0.0.1:${String(port)}/okm`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => blackhole.close(() => resolve()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function configText(url: string | undefined): string {
  return [
    `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
    "export default defineConfig({",
    '  schema: "./schema.ts", migrations: "./migrations",',
    ...(url === undefined ? [] : [`  database: ${JSON.stringify(url)},`]),
    "});",
    "",
  ].join("\n");
}

function schemaText(columns: string): string {
  return [
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    `export const app = schema({ tables: [table("notes", { id: t.integer().primaryKey()${columns} })] });`,
    "",
  ].join("\n");
}

function scratch(): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-optional-read-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "migrations"));
  return cwd;
}

/**
 * A project whose first migration exists and whose schema has moved on.
 *
 * The schema module is loaded once per path, so the first migration is made
 * in one directory and copied to a second that holds the new schema.
 */
async function project(url: string | undefined): Promise<string> {
  const first = scratch();
  writeFileSync(join(first, "okmodel.config.ts"), configText(url));
  writeFileSync(join(first, "schema.ts"), schemaText(""));
  expect((await generateProject(first, "init", []))?.path).toContain("0001_init.sql");
  const cwd = scratch();
  cpSync(join(first, "migrations"), join(cwd, "migrations"), { recursive: true });
  writeFileSync(join(cwd, "okmodel.config.ts"), configText(url));
  writeFileSync(join(cwd, "schema.ts"), schemaText(", title: t.text().nullable()"));
  return cwd;
}

async function captured<T>(
  run: () => Promise<T>,
): Promise<{ readonly value: T; readonly stderr: string; readonly ms: number }> {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  const started = performance.now();
  try {
    const value = await run();
    return { value, stderr, ms: performance.now() - started };
  } finally {
    process.stderr.write = write;
  }
}

test("a target that accepts and never answers is skipped after 3 seconds, with one note", async () => {
  const cwd = await project(blackholeUrl);
  const { value, stderr, ms } = await captured(() => planProject(cwd, "next", []));
  expect(ms).toBeGreaterThan(2_500);
  expect(ms).toBeLessThan(3_900);
  expect(stderr).toBe(`${NOTE}\n`);
  expect(value.plan.steps.length).toBe(1);
  expect(value.text).toContain('add column "title"');
}, 4_000);

test("a closed port is skipped at once, in plan and in generate", async () => {
  const cwd = await project(closedUrl);
  const planned = await captured(() => planProject(cwd, "next", []));
  expect(planned.ms).toBeLessThan(500);
  expect(planned.stderr).toBe(`${NOTE}\n`);
  const generated = await captured(() => generateProject(cwd, "next", []));
  expect(generated.ms).toBeLessThan(500);
  expect(generated.stderr).toBe(`${NOTE}\n`);
  expect(generated.value?.path).toContain("0002_next.sql");
});

test("the plan text is what a project with no target prints", async () => {
  const dark = await captured(
    async () => (await planProject(await project(closedUrl), "x", [])).text,
  );
  const none = await captured(
    async () => (await planProject(await project(undefined), "x", [])).text,
  );
  expect(dark.value).toBe(none.value);
  expect(none.stderr).toBe("");
});

test("under --json the note is dropped, so stderr and the envelope stay as they were", async () => {
  const cwd = await project(closedUrl);
  const { value, stderr } = await captured(() =>
    collectNotices(() => planProject(cwd, "next", [])),
  );
  expect(stderr).toBe("");
  expect(value.notices).toEqual([]);
});

test("a first migration has nothing to compare with and never connects", async () => {
  const cwd = scratch();
  writeFileSync(join(cwd, "okmodel.config.ts"), configText(blackholeUrl));
  writeFileSync(join(cwd, "schema.ts"), schemaText(""));
  const before = accepted;
  const { value, stderr, ms } = await captured(() => generateProject(cwd, "init", []));
  expect(value?.path).toContain("0001_init.sql");
  expect(stderr).toBe("");
  expect(ms).toBeLessThan(1_000);
  expect(accepted).toBe(before);
});

test("a missing postgres package and a connection failure are skipped, a server refusal is not", () => {
  const missing = Object.assign(new Error("Cannot find package 'postgres' imported from x"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
  expect(skippableRead(missing)).toBe(true);
  expect(skippableRead(Object.assign(new Error("slow"), { code: "CONNECT_TIMEOUT" }))).toBe(true);
  expect(skippableRead(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBe(true);
  expect(skippableRead(Object.assign(new Error("password"), { code: "28P01" }))).toBe(false);
  expect(skippableRead(new Error("boom"))).toBe(false);
});
