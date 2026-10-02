/**
 * Short-lived Postgres containers for versions 15 through 18.
 *
 * The harness topology runs one major at a time. Extension inventory needs
 * each official image, so this module starts `postgres:15` … `postgres:18`
 * itself and removes them afterwards.
 */

import { POSTGRES_VERSIONS, postgresReachable, type PostgresVersion } from "@okmodel/harness";

const USER = "okm";
const PASSWORD = "okm";
const DATABASE = "okm";

/**
 * Connection URL for a version container started by {@link withPostgresImages}.
 *
 * @param version - Postgres major
 * @returns A `postgres://` URL on the loopback port for that major
 */
export function versionContainerUrl(version: PostgresVersion): string {
  return `postgres://${USER}:${PASSWORD}@127.0.0.1:${String(versionPort(version))}/${DATABASE}`;
}

/**
 * Starts one container per major, runs `fn` for each, and removes the containers.
 *
 * @param fn - Receives the major and a URL that is accepting connections
 * @returns One result per major, in version order
 */
export async function withPostgresImages<T>(
  fn: (version: PostgresVersion, url: string) => Promise<T>,
): Promise<readonly T[]> {
  const started: PostgresVersion[] = [];
  try {
    for (const version of POSTGRES_VERSIONS) {
      await startImage(version);
      started.push(version);
    }
    const results: T[] = [];
    for (const version of POSTGRES_VERSIONS) {
      results.push(await fn(version, versionContainerUrl(version)));
    }
    return results;
  } finally {
    for (const version of started) {
      await stopImage(version);
    }
  }
}

function versionPort(version: PostgresVersion): number {
  return 55445 + Number(version) - 15;
}

function containerName(version: PostgresVersion): string {
  return `okm-p08-pg${version}`;
}

async function startImage(version: PostgresVersion): Promise<void> {
  await stopImage(version);
  const code = await spawn("docker", [
    "run",
    "-d",
    "--name",
    containerName(version),
    "-e",
    `POSTGRES_USER=${USER}`,
    "-e",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    "-e",
    `POSTGRES_DB=${DATABASE}`,
    "-p",
    `${String(versionPort(version))}:5432`,
    `postgres:${version}`,
  ]);
  if (code !== 0) {
    throw new Error(`docker run postgres:${version} exited ${String(code)}.`);
  }
  const url = versionContainerUrl(version);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await postgresReachable(url)) return;
    await delay(500);
  }
  throw new Error(
    `postgres:${version} did not accept connections on port ${String(versionPort(version))}.`,
  );
}

async function stopImage(version: PostgresVersion): Promise<void> {
  await spawn("docker", ["rm", "-f", containerName(version)]);
}

async function spawn(command: string, args: readonly string[]): Promise<number> {
  const proc = Bun.spawn([command, ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    if (stderr.trim().length > 0) console.warn(stderr.trim());
  }
  return code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
