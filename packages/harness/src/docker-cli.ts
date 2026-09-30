/**
 * Starts and stops the Postgres topology.
 *
 * Usage:
 *   bun ./packages/harness/src/docker-cli.ts up
 *   bun ./packages/harness/src/docker-cli.ts down
 */

import { join } from "node:path";

import { postgresVersionFromEnv } from "./version.js";

const composeFile = join(import.meta.dir, "..", "docker", "compose.yml");

/**
 * Runs `docker compose` for the topology.
 */
async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "up" && command !== "down") {
    console.error("[db] Usage: bun ./packages/harness/src/docker-cli.ts up|down");
    process.exit(2);
  }
  const version = postgresVersionFromEnv();
  const composeArgs =
    command === "up"
      ? ["up", "-d", "--wait", "--wait-timeout", "180"]
      : ["down", "-v", "--remove-orphans"];
  const proc = Bun.spawn(
    ["docker", "compose", "-f", composeFile, "-p", "okmodel", ...composeArgs],
    {
      cwd: join(import.meta.dir, "..", "..", ".."),
      env: { ...process.env, POSTGRES_VERSION: version },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`docker compose ${command} exited ${String(code)}`);
  }
  if (command === "up") {
    console.error(
      `[db] Postgres ${version} topology is up (primary 55432, replicas 55433 and 55434).`,
    );
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("[db]", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
