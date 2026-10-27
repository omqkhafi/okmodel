/**
 * parseArgs cases for Node and Bun.
 *
 * `tests/cli-contract.test.ts` runs this file with `bun` and, after
 * `bun build --target node`, with `node`.
 */

import { parseCli } from "../src/tooling/cli/parse.js";
import { OkmError } from "../src/contracts/error.js";

const failures: string[] = [];

function check(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

check("unknown flag names a suggestion", () => {
  const error = capture(() => parseCli(["build", "--jsn"]));
  expect(error.code === "OKM1895", error.code);
  expect(error.message.includes("Unknown flag --jsn"), error.message);
  expect(
    error.message.includes("Did you mean --json") ||
      error.fix.summary.includes("Did you mean --json"),
    error.fix.summary,
  );
});

check("unknown command names a suggestion", () => {
  const error = capture(() => parseCli(["chek"]));
  expect(error.message.includes("Unknown command chek"), error.message);
  expect(error.fix.summary.includes("Did you mean check"), error.fix.summary);
});

check("strict rejects an unknown flag", () => {
  const error = capture(() => parseCli(["build", "--nope"]));
  expect(error.message.includes("Unknown flag --nope"), error.message);
});

check("-f is not a flag", () => {
  const error = capture(() => parseCli(["build", "-f"]));
  expect(error.message.includes("Unknown flag -f"), error.message);
  expect(!error.fix.summary.includes("Did you mean -f"), error.fix.summary);
});

check("boolean shorts combine", () => {
  const parsed = parseCli(["migrate", "baseline", "-vn"]);
  expect(parsed.verbose === true, "verbose");
  expect(parsed.dryRun === true, "dry-run");
  expect(parsed.json === false, "json");
});

check("a value short does not cluster", () => {
  const parsed = parseCli(["build", "-cpath"]);
  expect(parsed.config === "path", String(parsed.config));
});

check("short target and out", () => {
  const parsed = parseCli(["push", "-t", "prod", "--json", "-oout.json"]);
  expect(parsed.target === "prod", String(parsed.target));
  expect(parsed.out === "out.json", String(parsed.out));
  expect(parsed.json === true, "json");
});

check("dry-run short is baseline only", () => {
  const parsed = parseCli(["migrate", "baseline", "-n"]);
  expect(parsed.dryRun === true, "dry-run");
  const error = capture(() => parseCli(["build", "-n"]));
  expect(error.message.includes("Unknown flag"), error.message);
});

check("help and version shorts", () => {
  expect(parseCli(["-h"]).help === true, "help");
  expect(parseCli(["-V"]).version === true, "version");
  expect(parseCli(["build", "-hv"]).help === true, "cluster help");
  expect(parseCli(["build", "-hv"]).verbose === true, "cluster verbose");
});

check("--json=false is rejected", () => {
  const error = capture(() => parseCli(["build", "--json=false"]));
  expect(error.message.length > 0, "message");
});

check("missing target is OKM1853", () => {
  const error = capture(() => parseCli(["push", "-t"]));
  expect(error.code === "OKM1853", error.code);
});

check("differing --config is refused", () => {
  const error = capture(() => parseCli(["build", "--config", "a.ts", "--config", "b.ts"]));
  expect(error.message.includes("more than once"), error.message);
});

check("guard flags ignore the environment", () => {
  process.env.OKM_ALLOW_PROTECTED = "1";
  process.env.OKM_ALLOW_POOLER = "1";
  process.env.OKM_ALLOW_DATA_LOSS = "1";
  process.env.OKM_REPLACE = "a.b.c=d";
  const parsed = parseCli(["push"]);
  expect(parsed.allowProtected === false, "allow-protected");
  expect(parsed.allowPooler === false, "allow-pooler");
  expect(parsed.allowDataLoss === false, "allow-data-loss");
  expect(parsed.replace.length === 0, "replace");
  delete process.env.OKM_ALLOW_PROTECTED;
  delete process.env.OKM_ALLOW_POOLER;
  delete process.env.OKM_ALLOW_DATA_LOSS;
  delete process.env.OKM_REPLACE;
});

check("--out without --json is usage", () => {
  const error = capture(() => parseCli(["build", "--out", "out.json"]));
  expect(error.message.includes("--out needs --json"), error.message);
});

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("ok\n");
}

function capture(run: () => unknown): OkmError {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}
