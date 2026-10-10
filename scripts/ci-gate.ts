/**
 * Decides whether `gate / check` passes.
 *
 * Every always-on slice must be `success`. A Postgres slice (`suite`,
 * `tarball`) must be `success` when the pull request carries
 * `needs: postgres`. Without that label the slice is skipped, and a skip is
 * allowed. A failure is not. D213, D230.
 *
 *   bun ./scripts/ci-gate.ts --postgres 0 lint=success suite=skipped
 */

/** One job result the gate reads from `needs.<job>.result`. */
export type GateSlice = {
  /** Job id in the workflow `needs` list. */
  readonly name: string;
  /** GitHub's result: `success`, `failure`, `cancelled`, or `skipped`. */
  readonly result: string;
  /** True when the job runs only with the `needs: postgres` label. */
  readonly postgres: boolean;
};

const POSTGRES_SLICES: ReadonlySet<string> = new Set(["suite", "tarball"]);

/**
 * Slices whose result is not allowed.
 *
 * @param slices - Every job the gate needs, in workflow order
 * @param postgresRequested - True when the event is a pull request with `needs: postgres`
 * @returns The slices that fail the gate
 */
export function gateFailures(
  slices: readonly GateSlice[],
  postgresRequested: boolean,
): readonly GateSlice[] {
  const failed: GateSlice[] = [];
  for (const slice of slices) {
    if (slice.postgres && !postgresRequested) {
      if (slice.result !== "success" && slice.result !== "skipped") failed.push(slice);
      continue;
    }
    if (slice.result !== "success") failed.push(slice);
  }
  return failed;
}

/**
 * Parses `name=result` arguments into slices.
 *
 * `suite` and `tarball` are the Postgres slices. Anything else is always on.
 *
 * @param args - Arguments after `--postgres`
 * @returns The slices, in argument order
 */
export function parseGateSlices(args: readonly string[]): readonly GateSlice[] {
  const slices: GateSlice[] = [];
  for (const arg of args) {
    const eq = arg.indexOf("=");
    const name = eq === -1 ? "" : arg.slice(0, eq);
    const result = eq === -1 ? "" : arg.slice(eq + 1);
    if (name.length === 0 || result.length === 0) {
      throw new Error(`usage: bun ./scripts/ci-gate.ts --postgres <0|1> <name=result>...`);
    }
    slices.push({ name, result, postgres: POSTGRES_SLICES.has(name) });
  }
  return slices;
}

if (import.meta.main) {
  const postgresFlag = process.argv.indexOf("--postgres");
  const flag = postgresFlag === -1 ? undefined : process.argv[postgresFlag + 1];
  if (flag !== "0" && flag !== "1") {
    console.error("usage: bun ./scripts/ci-gate.ts --postgres <0|1> <name=result>...");
    process.exit(1);
  }
  let slices: readonly GateSlice[];
  try {
    slices = parseGateSlices(process.argv.slice(postgresFlag + 2));
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
  const failed = gateFailures(slices, flag === "1");
  if (failed.length > 0) process.exit(1);
}
