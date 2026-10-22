/**
 * Decides whether `gate / check` passes.
 *
 * Format, lint, typecheck, build, changed tests, the title lint, and the
 * runtime-entry size check must be `success`. The Postgres 18 suite must be
 * `success` when the diff touches dialects, migrate, or runtime. Otherwise a
 * skipped suite is a pass. A failure is not.
 *
 *   bun ./scripts/ci-gate.ts --postgres 0 lint=success suite=skipped
 */

/** One job result the gate reads from `needs.<job>.result`. */
export type GateSlice = {
  /** Job id in the workflow `needs` list. */
  readonly name: string;
  /** GitHub's result: `success`, `failure`, `cancelled`, or `skipped`. */
  readonly result: string;
};

/**
 * Slices whose result is not allowed.
 *
 * `suite` may be `skipped` when Postgres 18 was not requested. `paths` may
 * be `skipped` on a fork, where the token cannot write labels. Any other
 * skip, and every failure or cancellation, fails the gate.
 *
 * @param slices - Every job the gate needs
 * @param postgresRequested - True when the diff touches dialects, migrate, or runtime
 * @returns The slices that fail the gate
 */
export function gateFailures(
  slices: readonly GateSlice[],
  postgresRequested: boolean,
): readonly GateSlice[] {
  const failed: GateSlice[] = [];
  for (const slice of slices) {
    if (slice.result === "success") continue;
    if (slice.result === "skipped" && skipAllowed(slice.name, postgresRequested)) continue;
    failed.push(slice);
  }
  return failed;
}

function skipAllowed(name: string, postgresRequested: boolean): boolean {
  if (name === "paths") return true;
  return name === "suite" && !postgresRequested;
}

/**
 * Parses `name=result` arguments into slices.
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
      throw new Error("usage: bun ./scripts/ci-gate.ts --postgres <0|1> <name=result>...");
    }
    slices.push({ name, result });
  }
  return slices;
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const postgres = flagValue("postgres");
  if (postgres !== "0" && postgres !== "1") {
    console.error("usage: bun ./scripts/ci-gate.ts --postgres <0|1> <name=result>...");
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
  const failed = gateFailures(slices, postgres === "1");
  if (failed.length > 0) process.exit(1);
}
