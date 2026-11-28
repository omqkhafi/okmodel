/**
 * Starts a Postgres container that already includes pgvector.
 *
 * Official `postgres` images do not ship it (D281). Installing the PGDG
 * package into the suite containers upgrades the server minor and breaks
 * libraries still mapped by the running process, so these proofs use
 * `pgvector/pgvector:pg<major>` on their own port. A missing tag is a skip.
 */

import { spawnSync } from "node:child_process";

import { postgresVersionFromEnv } from "./version.js";

const CONTAINER = "okmodel-pgvector";

/**
 * Ensures the pgvector container is accepting connections.
 *
 * @returns The database URL, or why this major has no image
 */
export function ensurePgvector():
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string } {
  const major = postgresVersionFromEnv();
  const image = `pgvector/pgvector:pg${major}`;
  const port = process.env.OKM_PGVECTOR_PORT ?? "55435";
  const url = `postgres://okm:okm@127.0.0.1:${port}/okm`;
  if (runningImage() === image && vectorReady(url)) return { ok: true, url };
  spawnSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" });
  const started = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-e",
      "POSTGRES_USER=okm",
      "-e",
      "POSTGRES_PASSWORD=okm",
      "-e",
      "POSTGRES_DB=okm",
      "-p",
      `${port}:5432`,
      image,
    ],
    { encoding: "utf8" },
  );
  if (started.status !== 0) {
    const detail = `${started.stdout ?? ""}${started.stderr ?? ""}`;
    const missing = detail.includes("manifest unknown") || detail.includes("not found");
    return {
      ok: false,
      reason: missing ? `${image} has no build for this major` : `${image} did not start`,
    };
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (vectorReady(url)) return { ok: true, url };
    spawnSync("sleep", ["0.5"]);
  }
  return { ok: false, reason: `${image} did not accept connections` };
}

/**
 * Reports whether `vector` can be created on `url`.
 *
 * @param url - Database URL
 * @returns `true` when the extension is listed
 */
/**
 * The image of the running proof container, when one exists.
 *
 * @returns The image name, or `undefined` when the container is absent
 */
function runningImage(): string | undefined {
  const inspect = spawnSync("docker", ["inspect", "-f", "{{.Config.Image}}", CONTAINER], {
    encoding: "utf8",
  });
  if (inspect.status !== 0) return undefined;
  const image = inspect.stdout.trim();
  return image.length > 0 ? image : undefined;
}

function vectorReady(url: string): boolean {
  const probe = spawnSync(
    "docker",
    [
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "okm",
      "-d",
      "okm",
      "-tAc",
      "select 1 from pg_available_extensions where name = 'vector'",
    ],
    { encoding: "utf8" },
  );
  if (probe.status !== 0 || probe.stdout.trim() !== "1") return false;
  const parsed = new URL(url);
  return parsed.protocol === "postgres:";
}
