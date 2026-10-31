/**
 * Boots the Hono example on Bun and on Node, then calls the routes.
 */

import { afterAll, expect } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { gate, postgresTest, waitForServer, withExampleApp } from "../shared/support.js";


async function stopChild(child: Subprocess): Promise<void> {
  try {
    child.kill();
  } catch {
    // already gone
  }
  await Promise.race([child.exited, Bun.sleep(2_000)]);
}

function testPort(offset: number): number {
  return 20_000 + (process.pid % 10_000) + offset;
}

const exampleDir = join(import.meta.dir);
const children: Subprocess[] = [];

afterAll(async () => {
  for (const child of children) {
    try {
      await stopChild(child);
    } catch {
      // already gone
    }
  }
});

async function bootAndExercise(cmd: string[], port: number, label: string): Promise<void> {
  await withExampleApp(exampleDir, async (url) => {
    const child = spawn({
      cmd,
      cwd: exampleDir,
      env: { ...process.env, DATABASE_URL: url, PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    const ready = waitForServer(`http://127.0.0.1:${port}/health`, 20_000);
    try {
      await ready;
    } catch (error) {
      const stderr = await new Response(child.stderr).text();
      const stdout = await new Response(child.stdout).text();
      child.kill();
      throw new Error(`${String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const written = await fetch(`http://127.0.0.1:${port}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `${label}-note` }),
    });
    if (written.status !== 201) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(`POST status ${written.status}: ${await written.text()}\nstderr:\n${stderr}`);
    }
    expect(written.status).toBe(201);
    const listed = await fetch(`http://127.0.0.1:${port}/notes`);
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as Array<{ title: string }>;
    expect(rows.some((item) => item.title === `${label}-note`)).toBe(true);
    await stopChild(child);
  });
}

postgresTest(gate, "hono on Bun reads and writes notes", async () => {
  await bootAndExercise(["bun", "./src/server.ts"], testPort(1), "bun");
}, 60_000);

postgresTest(gate, "hono on Node reads and writes notes", async () => {
  mkdirSync(join(exampleDir, ".run"), { recursive: true });
  const built = await Bun.build({
    entrypoints: [join(exampleDir, "src/server-node.ts")],
    outdir: join(exampleDir, ".run"),
    target: "node",
    packages: "external",
  });
  if (!built.success) {
    throw new Error(built.logs.map(String).join("\n"));
  }
  const outfile = join(exampleDir, ".run/server-node.js");
  await bootAndExercise(["node", outfile], testPort(2), "node");
}, 60_000);
