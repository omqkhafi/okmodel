/**
 * `okm driver test` command shape and report plumbing.
 *
 * The conformance rows themselves run on PGlite, postgres.js, node-postgres,
 * and Bun.sql in `driver-suite`, `error-suite`, and `tx-suite` (`r3.`, `r6.`).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { bunAtLeast, MIN_BUN } from "../packages/harness/src/driver-run.js";
import { run } from "../src/tooling/migrate/commands.js";

test("okm driver test is a command", async () => {
  const help: string[] = [];
  await run([], { stdout: (text) => help.push(text) });
  expect(help.join("")).toContain("driver test <driver>");
  const command: string[] = [];
  await run(["driver", "test", "--help"], { stdout: (text) => command.push(text) });
  expect(command.join("")).toContain("Run conformance against one driver.");
  await expectFailure(["driver"], /Unknown command driver/);
  await expectFailure(["driver", "test"], /needs a driver/);
  await expectFailure(["driver", "test", "nope"], /Unknown driver nope/);
});

test("okm driver test prints the runner report", async () => {
  // The runner imports this module, which prints a report and exits 0 before
  // its import settles, so the CLI path runs without the conformance suites.
  const dir = mkdtempSync(join(tmpdir(), "okm-driver-test-"));
  const report = "driver stub\ndialect postgres\nr6.commit\tcommit\tpass\t\n";
  const driver = join(dir, "stub.ts");
  writeFileSync(
    driver,
    `await new Promise(() => process.stdout.write(${JSON.stringify(report)}, () => process.exit(0)));\n`,
  );
  try {
    const lines: string[] = [];
    await run(["driver", "test", driver], { stdout: (text) => lines.push(text) });
    expect(lines.join("")).toBe(report);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function expectFailure(argv: readonly string[], pattern: RegExp): Promise<void> {
  try {
    await run([...argv]);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof Error) expect(error.message).toMatch(pattern);
    return;
  }
  throw new Error(`${argv.join(" ")} did not fail`);
}

test("bunAtLeast matches engines.bun and refuses older majors", () => {
  expect(MIN_BUN).toBe("1.4.0");
  expect(bunAtLeast("1.4.0", MIN_BUN)).toBe(true);
  expect(bunAtLeast("1.4.2", MIN_BUN)).toBe(true);
  expect(bunAtLeast("1.3.13", MIN_BUN)).toBe(false);
  expect(bunAtLeast("1.3.99", MIN_BUN)).toBe(false);
  expect(bunAtLeast("", MIN_BUN)).toBe(false);
});
