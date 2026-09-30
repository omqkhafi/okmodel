import { postgresReachable } from "./postgres.js";
import { primaryUrl } from "./topology.js";

/** Whether Postgres tests should run, skip, or fail. */
export type DockerDecision =
  | { readonly run: true }
  | { readonly run: false; readonly fail: boolean; readonly message: string };

/**
 * Decides how a Postgres test treats a missing daemon or a closed port.
 *
 * `REQUIRE_DOCKER=1` fails the test. Otherwise the test skips with `message`.
 *
 * @param input - What the probe saw
 * @returns The decision
 */
export function decideDocker(input: {
  readonly daemon: boolean;
  readonly reachable: boolean;
  readonly required: boolean;
}): DockerDecision {
  if (input.reachable) return { run: true };
  if (!input.daemon) {
    const message = input.required
      ? "REQUIRE_DOCKER=1 but Docker is not running."
      : "Skipping Postgres tests: Docker is not running.";
    return { run: false, fail: input.required, message };
  }
  const message = input.required
    ? "REQUIRE_DOCKER=1 but Postgres is not accepting connections. Run `bun run db:up`."
    : "Skipping Postgres tests: Docker is running but Postgres is not up. Run `bun run db:up`.";
  return { run: false, fail: input.required, message };
}

/**
 * Probes Docker and the primary, then applies {@link decideDocker}.
 *
 * @param url - Primary URL to probe. Defaults to the topology primary
 * @returns The decision for this process
 */
export async function postgresDecision(url: string = primaryUrl()): Promise<DockerDecision> {
  const reachable = await postgresReachable(url);
  const daemon = reachable ? true : await dockerDaemonRunning();
  return decideDocker({
    daemon,
    reachable,
    required: process.env.REQUIRE_DOCKER === "1",
  });
}

/**
 * Returns whether the Docker daemon answers `docker info`.
 *
 * @returns False when the command is missing, fails, or does not finish within 4 seconds
 */
export async function dockerDaemonRunning(): Promise<boolean> {
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
  } catch {
    return false;
  }
  const exited = proc.exited.then((code) => code === 0);
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 4000);
  });
  return Promise.race([exited, timeout]);
}
