/**
 * Boots the TanStack Start example (`vite dev`) and calls the API routes.
 */

import { afterAll, expect } from "bun:test";
import { spawn, type Subprocess } from "bun";
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

function testPort(): number {
  return 21_000 + (process.pid % 1_000);
}

const exampleDir = join(import.meta.dir);
let child: Subprocess | undefined;

afterAll(async () => {
  if (child !== undefined) {
    await stopChild(child);
  }
});

postgresTest(gate, "tanstack-start reads and writes notes", async () => {
  await withExampleApp(exampleDir, async (url) => {
    const port = testPort();
    child = spawn({
      cmd: [
        "bunx",
        "vite",
        "dev",
        "--port",
        String(port),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      cwd: exampleDir,
      env: { ...process.env, DATABASE_URL: url, PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await waitForServer(`http://127.0.0.1:${port}/api/health`, 60_000);
    } catch (error) {
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      await stopChild(child);
      child = undefined;
      throw new Error(`${String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const written = await fetch(`http://127.0.0.1:${port}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "tanstack-note" }),
    });
    expect(written.status).toBe(201);
    const listed = await fetch(`http://127.0.0.1:${port}/api/notes`);
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as Array<{ title: string }>;
    expect(rows.some((item) => item.title === "tanstack-note")).toBe(true);
    await stopChild(child);
    child = undefined;
  });
}, 180_000);
