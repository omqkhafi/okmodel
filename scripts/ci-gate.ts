/**
 * Decides whether `gate / check` passes.
 *
 * Every always-on slice must be `success`. A Postgres slice (`suite`,
 * `tarball`) must be `success` when the pull request carries
 * `needs: postgres`. The full tier (`full-ci`, or a push to `main`) also
 * requires `suite` and the tier-2 slices. Without that request a skip is
 * allowed. `tarball` stays on the Postgres label only. A docs-only or
 * site-only change may also skip the runtime test jobs and Postgres; that
 * skip is a pass only when `--runtime 0` says the filter marked them
 * irrelevant. A failure is not. D213, D230.
 *
 *   bun ./scripts/ci-gate.ts --postgres 0 --runtime 1 --full 0 lint=success suite=skipped
 */

/** One job result the gate reads from `needs.<job>.result`. */
export type GateSlice = {
  /** Job id in the workflow `needs` list. */
  readonly name: string;
  /** GitHub's result: `success`, `failure`, `cancelled`, or `skipped`. */
  readonly result: string;
  /** True when the job runs with `needs: postgres`. */
  readonly postgres: boolean;
  /**
   * True when the job runs on the full tier (`full-ci`, or a push to `main`).
   * A slice that is both `postgres` and `full` runs when either is requested.
   */
  readonly full: boolean;
  /**
   * True when a docs-only or site-only path filter may skip this slice.
   * A skip is then a pass. A skip while the filter says the slice is
   * relevant is a failure.
   */
  readonly filtered: boolean;
};

const POSTGRES_SLICES: ReadonlySet<string> = new Set(["suite", "tarball"]);

/** Slices the full tier requires. `suite` is also a Postgres slice. */
const FULL_SLICES: ReadonlySet<string> = new Set([
  "runtimes",
  "temporal",
  "package",
  "attest",
  "types-full",
  "windows",
  "suite",
  "drivers-conformance",
]);

/** Slices the path filter may skip: the runtime tests, and Postgres. */
const FILTERED_SLICES: ReadonlySet<string> = new Set([
  "test",
  "test-dist",
  "runtimes",
  "temporal",
  "suite",
  "tarball",
  "attest",
  "types-full",
  "windows",
  "drivers-conformance",
]);

/**
 * Slices whose result is not allowed.
 *
 * A Postgres slice may be `skipped` when the pull request has no
 * `needs: postgres` label. A filtered slice may be `skipped` when the path
 * filter says the runtime matrix is irrelevant. Any other skip, and every
 * failure or cancellation, fails the gate.
 *
 * @param slices - Every job the gate needs, in workflow order
 * @param postgresRequested - True when the event is a pull request with `needs: postgres`
 * @param runtimeRelevant - False when every changed file is under `docs/` or `site/`
 * @param fullRequested - True when the pull request has `full-ci`, or the push is to `main`
 * @returns The slices that fail the gate
 */
export function gateFailures(
  slices: readonly GateSlice[],
  postgresRequested: boolean,
  runtimeRelevant = true,
  fullRequested = false,
): readonly GateSlice[] {
  const failed: GateSlice[] = [];
  for (const slice of slices) {
    if (slice.result === "success") continue;
    if (
      slice.result === "skipped" &&
      skipAllowed(slice, postgresRequested, runtimeRelevant, fullRequested)
    ) {
      continue;
    }
    failed.push(slice);
  }
  return failed;
}

function skipAllowed(
  slice: GateSlice,
  postgresRequested: boolean,
  runtimeRelevant: boolean,
  fullRequested: boolean,
): boolean {
  if (!runtimeRelevant && slice.filtered) return true;
  if (slice.postgres || slice.full) {
    const wanted = (slice.postgres && postgresRequested) || (slice.full && fullRequested);
    return !wanted;
  }
  return false;
}

/**
 * Parses `name=result` arguments into slices.
 *
 * `suite` and `tarball` are the Postgres slices. `suite` also runs on the
 * full tier. `runtimes`, `temporal`, `package`, `attest`, `types-full`,
 * `windows`, and `drivers-conformance` are full-tier slices. `test`,
 * `test-dist`, `runtimes`, `temporal`, `suite`, `tarball`, `attest`,
 * `types-full`, `windows`, and `drivers-conformance` are filtered slices.
 * Anything else is always on.
 *
 * @param args - `name=result` arguments. Flags are ignored
 * @returns The slices, in argument order
 */
export function parseGateSlices(args: readonly string[]): readonly GateSlice[] {
  const slices: GateSlice[] = [];
  for (const arg of args) {
    if (!arg.includes("=")) continue;
    const eq = arg.indexOf("=");
    const name = arg.slice(0, eq);
    const result = arg.slice(eq + 1);
    if (name.length === 0 || result.length === 0) {
      throw new Error(
        "usage: bun ./scripts/ci-gate.ts --postgres <0|1> --runtime <0|1> --full <0|1> <name=result>...",
      );
    }
    slices.push({
      name,
      result,
      postgres: POSTGRES_SLICES.has(name),
      filtered: FILTERED_SLICES.has(name),
      full: FULL_SLICES.has(name),
    });
  }
  return slices;
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const postgres = flagValue("postgres");
  const runtime = flagValue("runtime") ?? "1";
  const full = flagValue("full") ?? "0";
  if (
    (postgres !== "0" && postgres !== "1") ||
    (runtime !== "0" && runtime !== "1") ||
    (full !== "0" && full !== "1")
  ) {
    console.error(
      "usage: bun ./scripts/ci-gate.ts --postgres <0|1> --runtime <0|1> --full <0|1> <name=result>...",
    );
    process.exit(1);
  }
  let slices: readonly GateSlice[];
  try {
    slices = parseGateSlices(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (slices.length === 0) {
    console.error("gate: no slices");
    process.exit(1);
  }
  for (const slice of slices) {
    console.log(`${slice.name} ${slice.result}`);
  }
  const failed = gateFailures(slices, postgres === "1", runtime === "1", full === "1");
  if (failed.length > 0) process.exit(1);
}
