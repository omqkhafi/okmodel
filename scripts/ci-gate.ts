/**
 * Decides whether `gate / check` passes.
 *
 * Format, lint, typecheck, build, changed tests, the title lint, and the
 * runtime-entry size check must be `success`. The Postgres 18 suite must be
 * `success` when the diff touches dialects, migrate, or runtime. The lifecycle
 * property must be `success` when the diff touches dialects, migrate, or
 * `tests/lifecycle`. The composition cases must be `success` when the diff
 * touches dialects, runtime, or `tests/composition`. The site tests must be
 * `success` when the diff touches `src/tooling` or `src/dialects`. The pack
 * contract must be `success` when the diff touches a packed path, `src/`,
 * `scripts/`, or `package.json`. Otherwise a skipped suite, lifecycle, composition, site, or
 * pack job is a pass. A failure is not.
 *
 *   bun ./scripts/ci-gate.ts --postgres 0 --lifecycle 0 --composition 0 --site 0 --pack 0 lint=success suite=skipped lifecycle=skipped composition=skipped site=skipped pack=skipped
 */

/** One job result the gate reads from `needs.<job>.result`. */
export type GateSlice = {
  /** Job id in the workflow `needs` list. */
  readonly name: string;
  /** GitHub's result: `success`, `failure`, `cancelled`, or `skipped`. */
  readonly result: string;
};

/** Which optional jobs the path filter requested. */
export type GateRequest = {
  readonly postgres: boolean;
  readonly lifecycle: boolean;
  readonly site: boolean;
  /** Set when the path filter asked for the composition job. */
  readonly composition?: boolean;
  /** Set when the path filter asked for the pack contract. */
  readonly pack?: boolean;
};

/**
 * Slices whose result is not allowed.
 *
 * `suite` may be `skipped` when Postgres 18 was not requested. `lifecycle` may
 * be `skipped` when the lifecycle property was not requested. `composition`
 * may be `skipped` when those cases were not requested. `site` may be
 * `skipped` when the site tests were not requested. `pack` may be `skipped`
 * when the pack contract was not requested. `paths` may be `skipped`
 * on a fork, where the token cannot write labels. Any other skip, and every
 * failure or cancellation, fails the gate.
 *
 * @param slices - Every job the gate needs
 * @param request - Which optional jobs the path filter asked for
 * @returns The slices that fail the gate
 */
export function gateFailures(
  slices: readonly GateSlice[],
  request: boolean | GateRequest,
): readonly GateSlice[] {
  const wanted: GateRequest =
    typeof request === "boolean" ? { postgres: request, lifecycle: false, site: false } : request;
  const failed: GateSlice[] = [];
  for (const slice of slices) {
    if (slice.result === "success") continue;
    if (slice.result === "skipped" && skipAllowed(slice.name, wanted)) continue;
    failed.push(slice);
  }
  return failed;
}

function skipAllowed(name: string, request: GateRequest): boolean {
  if (name === "paths") return true;
  if (name === "suite") return !request.postgres;
  if (name === "lifecycle") return !request.lifecycle;
  if (name === "composition") return request.composition !== true;
  if (name === "site") return !request.site;
  if (name === "pack") return request.pack !== true;
  return false;
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
      throw new Error(
        "usage: bun ./scripts/ci-gate.ts --postgres <0|1> [--lifecycle <0|1>] [--composition <0|1>] [--site <0|1>] [--pack <0|1>] <name=result>...",
      );
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
    console.error(
      "usage: bun ./scripts/ci-gate.ts --postgres <0|1> [--lifecycle <0|1>] [--composition <0|1>] [--site <0|1>] [--pack <0|1>] <name=result>...",
    );
    process.exit(1);
  }
  const lifecycleFlag = flagValue("lifecycle");
  const lifecycle =
    lifecycleFlag === undefined
      ? "0"
      : lifecycleFlag === "0" || lifecycleFlag === "1"
        ? lifecycleFlag
        : "";
  const compositionFlag = flagValue("composition");
  const composition =
    compositionFlag === undefined
      ? "0"
      : compositionFlag === "0" || compositionFlag === "1"
        ? compositionFlag
        : "";
  const siteFlag = flagValue("site");
  const site = siteFlag === undefined ? "0" : siteFlag === "0" || siteFlag === "1" ? siteFlag : "";
  const packFlag = flagValue("pack");
  const pack = packFlag === undefined ? "0" : packFlag === "0" || packFlag === "1" ? packFlag : "";
  if (lifecycle === "" || composition === "" || site === "" || pack === "") {
    console.error(
      "usage: bun ./scripts/ci-gate.ts --postgres <0|1> [--lifecycle <0|1>] [--composition <0|1>] [--site <0|1>] [--pack <0|1>] <name=result>...",
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
  const failed = gateFailures(slices, {
    postgres: postgres === "1",
    lifecycle: lifecycle === "1",
    composition: composition === "1",
    site: site === "1",
    pack: pack === "1",
  });
  if (failed.length > 0) process.exit(1);
}
