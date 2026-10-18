/**
 * `ci:fail` maps a failed step to one local command and keeps its log tail.
 */

import { expect, test } from "bun:test";

import { reproduceCommand, tailStep } from "./ci-fail.js";
import { repoRoot } from "./root.js";

const root = repoRoot();

test("a failed step maps to the one command that reruns it", () => {
  expect(reproduceCommand("lint / static", "Format", root)).toBe("bun run format:check");
  expect(reproduceCommand("lint / static", "Docs", root)).toBe("bun run docs:check");
  expect(reproduceCommand("types / compiler", "Typecheck", root)).toBe("bun run typecheck");
  expect(reproduceCommand("package / checks", "Size", root)).toBe("bun run size");
  expect(reproduceCommand("suite / 18 / tx", "Postgres suite", root)).toBe(
    "REQUIRE_DOCKER=1 POSTGRES_VERSION=18 bun ./scripts/postgres-suite.ts --shard tx",
  );
  const testCommand = reproduceCommand("test / scripts", "Test", root);
  expect(testCommand.startsWith("bun test ")).toBe(true);
  expect(testCommand).toContain("scripts/ci-fail.test.ts");
});

test("the log tail is the failing step, capped at 60 lines", () => {
  const body = Array.from({ length: 80 }, (_, index) => `line ${String(index)}`).join("\n");
  const log = `2026-01-01T00:00:00.0000000Z ##[group]Format\nkeep format\n2026-01-01T00:00:01.0000000Z ##[endgroup]\n2026-01-01T00:00:02.0000000Z ##[group]Lint\n${body}\n2026-01-01T00:00:03.0000000Z ##[endgroup]\n`;
  const tail = tailStep(log, "Lint");
  expect(tail.startsWith("line 20")).toBe(true);
  expect(tail.endsWith("line 79")).toBe(true);
  expect(tail.split("\n")).toHaveLength(60);
  expect(tail).not.toContain("keep format");
});
