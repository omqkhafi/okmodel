/**
 * Boots the Express example and calls read/write routes on real Postgres.
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

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch() { return new Response("ok"); } });
  const port = server.port;
  server.stop(true);
  return port;
}

const exampleDir = join(import.meta.dir);
let child: Subprocess | undefined;

afterAll(async () => {
  if (child !== undefined) {
    await stopChild(child);
  }
});

postgresTest(gate, "express reads and writes notes", async () => {
  await withExampleApp(exampleDir, async (url) => {
    const port = await freePort();
    child = spawn({
      cmd: ["bun", "./src/server.ts"],
      cwd: exampleDir,
      env: { ...process.env, DATABASE_URL: url, PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForServer(`http://127.0.0.1:${port}/health`);
    const written = await fetch(`http://127.0.0.1:${port}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "express-note" }),
    });
    expect(written.status).toBe(201);
    const row = (await written.json()) as { title: string };
    expect(row.title).toBe("express-note");
    const listed = await fetch(`http://127.0.0.1:${port}/notes`);
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as Array<{ title: string }>;
    expect(rows.some((item) => item.title === "express-note")).toBe(true);
    await stopChild(child);
    child = undefined;
  });
}, 60_000);
