/**
 * Measures a trivial type with `@ark/attest` on the TypeScript 6 compiler.
 *
 * Attest loads `typescript` by Node resolution from `@ark/attest`.
 * `findAttestTypeScriptVersions` scans each package's `node_modules` for a
 * directory named `typescript` and keeps the closest one. This package
 * installs TypeScript 6 there. Check time comes from the `tsc6` binary in
 * `@typescript/typescript6`. That package does not ship `lib.*.d.ts`, so the
 * instantiation bench uses the full TypeScript 6 compiler.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bench, findAttestTypeScriptVersions, getPrimaryTsVersionUnderTest } from "@ark/attest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(packageRoot);
process.env.ATTEST_shouldFormat = "0";
process.env.ATTEST_updateSnapshots = "0";

const require = createRequire(import.meta.url);
const typescriptFromAttest = require.resolve("typescript/package.json");
const typescriptFromArk = createRequire(require.resolve("@ark/attest")).resolve(
  "typescript/package.json",
);
const typescript6Package = require.resolve("@typescript/typescript6/package.json");
const tsc6 = join(dirname(typescript6Package), "bin", "tsc6");

const primary = getPrimaryTsVersionUnderTest();
const resolved = JSON.parse(readFileSync(typescriptFromArk, "utf8")) as {
  name?: string;
  version?: string;
};
if (resolved.name !== "typescript" || !resolved.version?.startsWith("6.")) {
  throw new Error(
    `attest resolved ${String(resolved.name)}@${String(resolved.version)} at ${typescriptFromArk}; expected typescript@6`,
  );
}
if (!primary.startsWith("6.")) {
  throw new Error(`attest imported TypeScript ${primary}; expected 6.x at ${typescriptFromArk}`);
}
if (!tsc6.includes(`${join("@typescript", "typescript6")}`)) {
  throw new Error(`tsc6 is not the @typescript/typescript6 binary: ${tsc6}`);
}

const versions = findAttestTypeScriptVersions();
const found = versions.find((version) => version.alias === "default");
if (found === undefined || !found.version.startsWith("6.")) {
  throw new Error(`attest did not find TypeScript 6: ${JSON.stringify(versions)}`);
}
const diagnostics = extendedDiagnostics();
/** Instantiations `@ark/attest` counts for the expression in {@link measureTrivialType}. */
const benchInstantiations = 3;
const report = {
  primary,
  typescriptFromAttest,
  typescriptFromArk,
  tsc6,
  versions,
  checkTimeSeconds: diagnostics.checkTimeSeconds,
  instantiations: diagnostics.instantiations,
  benchInstantiations,
};
console.log(JSON.stringify(report, null, 2));

measureTrivialType();

/**
 * Bun omits the bare module frame from the stack `@ark/attest` reads, so the
 * bench call has to sit in a function the runtime does not inline.
 */
function measureTrivialType(): void {
  let failed: unknown;
  try {
    bench("trivial", () => {
      type Id<T> = T extends unknown ? T : never;
      return { value: 1 } as Id<{ readonly value: number }>;
    }).types([benchInstantiations, "instantiations"]);
  } catch (error) {
    failed = error;
  }
  if (failed !== undefined) {
    throw failed;
  }
}

function extendedDiagnostics(): {
  readonly checkTimeSeconds: number;
  readonly instantiations: number;
} {
  const proc = spawnSync(
    "bun",
    [
      tsc6,
      "--noEmit",
      "--extendedDiagnostics",
      "--incremental",
      "false",
      "--pretty",
      "false",
      "-p",
      "tsconfig.json",
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  if (proc.status !== 0) {
    throw new Error(`tsc6 exited ${String(proc.status)}\n${output}`);
  }
  const checkTime = output.match(/^Check time:\s+([0-9.]+)s/m);
  const instantiations = output.match(/^Instantiations:\s+(\d+)/m);
  if (checkTime?.[1] === undefined || instantiations?.[1] === undefined) {
    throw new Error(`tsc6 did not report check time and instantiations\n${output}`);
  }
  return {
    checkTimeSeconds: Number(checkTime[1]),
    instantiations: Number(instantiations[1]),
  };
}
