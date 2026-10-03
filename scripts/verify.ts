/**
 * Runs the CI Postgres suite on this machine.
 *
 * CI is the authority for a release. This command is for a developer.
 * One major by default (`POSTGRES_VERSION`, or 17). `--all` runs every
 * supported major.
 *
 *   bun ./scripts/verify.ts
 *   bun ./scripts/verify.ts --all
 */

import {
  POSTGRES_VERSIONS,
  postgresVersionFromEnv,
  type PostgresVersion,
} from "../packages/harness/src/version.js";
import { repoRoot } from "./root.js";

/**
 * Majors `bun run verify` will start.
 *
 * `--all` is every supported major. Any other argument is a usage error.
 * Without `--all`, the major is `POSTGRES_VERSION` or 17.
 *
 * @param args - Arguments after the script name
 * @param env - Environment to read `POSTGRES_VERSION` from
 * @returns The majors to run, in order
 */
export function verifyVersions(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly PostgresVersion[] {
  const extra = args.filter((arg) => arg !== "--all" && arg !== "--");
  if (extra.length > 0) {
    throw new Error("Usage: bun run verify [--all]");
  }
  if (args.includes("--all")) return [...POSTGRES_VERSIONS];
  return [postgresVersionFromEnv(env)];
}

async function run(
  root: string,
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const proc = Bun.spawn([...command], {
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code === null) throw new Error(`${command.join(" ")} did not exit`);
  return code;
}

async function withTopology(
  root: string,
  version: PostgresVersion,
  body: () => Promise<number>,
): Promise<number> {
  const env = { ...process.env, POSTGRES_VERSION: version };
  const up = await run(root, ["bun", "./packages/harness/src/docker-cli.ts", "up"], env);
  if (up !== 0) {
    await run(root, ["bun", "./packages/harness/src/docker-cli.ts", "down"], env);
    return up;
  }
  let code = 1;
  try {
    code = await body();
  } finally {
    const down = await run(root, ["bun", "./packages/harness/src/docker-cli.ts", "down"], env);
    if (code === 0) code = down;
  }
  return code;
}

async function main(): Promise<void> {
  const versions = verifyVersions(process.argv.slice(2));
  const root = repoRoot();
  console.error(`[verify] Postgres ${versions.join(", ")}`);
  const build = await run(root, ["bun", "run", "build"], process.env);
  if (build !== 0) process.exit(build);
  for (const version of versions) {
    console.error(`[verify] starting Postgres ${version}`);
    const code = await withTopology(root, version, () =>
      run(root, ["bun", "./scripts/postgres-suite.ts"], {
        ...process.env,
        POSTGRES_VERSION: version,
        REQUIRE_DOCKER: "1",
      }),
    );
    if (code !== 0) {
      console.error(`[verify] Postgres ${version} failed`);
      process.exit(code);
    }
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("[verify]", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
