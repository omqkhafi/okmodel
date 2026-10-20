import { OkmError } from "../contracts/error.js";
import { envelope, errorBody, serializeEnvelope, terseStderr } from "./cli/envelope.js";
import { argvHasJson } from "./cli/parse.js";
import { CommandFinished, exitCodeFor, tagOutcome } from "./cli/outcome.js";
import { readPackageVersion } from "./cli/version.js";
import { formatFailure, run } from "./migrate/commands.js";
import { nodeStartupMessage } from "./node-version.js";

const nodeProblem = nodeStartupMessage(process.version, process.versions.bun !== undefined);
if (process.stdin.isTTY !== true) {
  process.stdin.pause();
  const stdin = process.stdin as { unref?: () => void };
  if (typeof stdin.unref === "function") stdin.unref();
}
if (nodeProblem !== undefined) {
  const error = tagOutcome(new OkmError("invalid", nodeProblem.trimEnd()), "usage");
  const json = argvHasJson(process.argv.slice(2));
  if (json) {
    process.stdout.write(
      serializeEnvelope(
        envelope({
          command: null,
          okmVersion: safeVersion(),
          exit: 2,
          data: {},
          errors: [errorBody(error)],
        }),
      ),
    );
    const line = terseStderr(error, process.stderr.isTTY === true);
    if (line.length > 0) process.stderr.write(line);
  } else {
    process.stderr.write(nodeProblem);
  }
  process.exitCode = 2;
} else {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CommandFinished) {
      if (error.stderr.length > 0) process.stderr.write(error.stderr);
      process.exitCode = error.exitCode;
    } else {
      const verbose = wantsVerbose(process.argv) || process.env.OKM_DEBUG === "1";
      process.stderr.write(formatFailure(error, verbose));
      process.exitCode = exitCodeFor(error);
    }
  }
}

function wantsVerbose(argv: readonly string[]): boolean {
  return argv.some(
    (arg) => arg === "--verbose" || arg === "-v" || (/^-[hVvn]+$/.test(arg) && arg.includes("v")),
  );
}

function safeVersion(): string {
  try {
    return readPackageVersion();
  } catch {
    return "";
  }
}
