/**
 * `okm driver test` report shape.
 *
 * PGlite runs here. The same rows on postgres.js, node-postgres, and Bun.sql
 * are the `r3.` and `r6.` cases in `tests/tx-suite.test.ts`.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
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

test("pglite conformance reports pass, fail, and unsupported", async () => {
  const lines: string[] = [];
  try {
    await run(["driver", "test", "pglite"], { stdout: (text) => lines.push(text) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${lines.join("")}`);
  }
  const report = lines.join("");
  expect(report).toContain("driver pglite\n");
  expect(report).toContain("dialect postgres\n");
  const commit = cell(report, "r6.commit");
  expect(commit[2]).toBe("pass");
  expect(commit[3]).toBe("");
  expect(commit[1]?.length).toBeGreaterThan(0);
  expect(cell(report, "r6.rollback")[2]).toBe("pass");
  expect(cell(report, "r6.savepoint")[2]).toBe("pass");
  expect(cell(report, "r3.repeat-insert")[2]).toBe("pass");
  expect(cell(report, "r3.on-conflict-ignore")[2]).toBe("pass");
  expect(cell(report, "r3.on-conflict-update")[2]).toBe("pass");
  expect(cell(report, "r3.on-conflict-return")[2]).toBe("pass");
  expect(cell(report, "r3.supply-id")[2]).toBe("pass");
  expect(cell(report, "r3.retry-id").slice(2)).toEqual(["unsupported", "one connection"]);
  expect(cell(report, "r2.commit-loss").slice(2)).toEqual(["unsupported", "no socket to cut"]);
  expect(cell(report, "r2.batch-commit-loss").slice(2)).toEqual([
    "unsupported",
    "no socket to cut",
  ]);
  expect(report).not.toContain("\tfail\t");
}, 180_000);

function cell(report: string, id: string): readonly string[] {
  const line = report.split("\n").find((item) => item.startsWith(`${id}\t`));
  if (line === undefined) throw new Error(`missing ${id}\n${report}`);
  return line.split("\t");
}
