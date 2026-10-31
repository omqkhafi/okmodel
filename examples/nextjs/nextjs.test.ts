/**
 * Builds and boots the Next.js example, then calls the API routes.
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
  return 22_000 + (process.pid % 1_000);
}

const exampleDir = join(import.meta.dir);
let child: Subprocess | undefined;

afterAll(async () => {
  if (child !== undefined) {
    await stopChild(child);
  }
});

postgresTest(gate, "nextjs reads and writes notes", async () => {
  await withExampleApp(exampleDir, async (url) => {
    const port = testPort();
    const build = spawn({
      cmd: ["bunx", "next", "build"],
      cwd: exampleDir,
      env: { ...process.env, DATABASE_URL: url, NEXT_TELEMETRY_DISABLED: "1", PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const buildCode = await build.exited;
    if (buildCode !== 0) {
      throw new Error(`next build failed: ${await new Response(build.stderr).text()}`);
    }
    child = spawn({
      cmd: ["bunx", "next", "start", "--port", String(port)],
      cwd: exampleDir,
      env: { ...process.env, DATABASE_URL: url, NEXT_TELEMETRY_DISABLED: "1", PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForServer(`http://127.0.0.1:${port}/api/health`, 60_000);
    const written = await fetch(`http://127.0.0.1:${port}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "next-note" }),
    });
    expect(written.status).toBe(201);
    const listed = await fetch(`http://127.0.0.1:${port}/api/notes`);
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as Array<{ title: string }>;
    expect(rows.some((item) => item.title === "next-note")).toBe(true);
    await stopChild(child);
    child = undefined;
  });
}, 180_000);
