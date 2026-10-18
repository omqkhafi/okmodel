/**
 * `okm driver test` report shape.
 *
 * PGlite runs here. The same rows on postgres.js, node-postgres, and Bun.sql
 * are the `r3.` and `r6.` cases in `tests/tx-suite.test.ts`.
 */

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
