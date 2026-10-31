/**
 * Every flag in the CLI definition appears in the handbook CLI pages.
 * Flag tables stay hand-written; this test catches a missing row.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { COMMANDS, GLOBAL_FLAGS } from "../../src/tooling/cli/spec.js";
import { siteRoot } from "./repo";

function cliPagesText(): string {
  const dir = join(siteRoot(), "content/docs/reference/cli");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".mdx"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

function flagSpellings(name: string, short?: string): string[] {
  const long = `--${name}`;
  if (short === undefined) return [long];
  return [long, `-${short}`];
}

test("every CLI flag from the definition appears in the CLI handbook pages", () => {
  const text = cliPagesText();
  const missing: string[] = [];

  for (const flag of GLOBAL_FLAGS) {
    const seen = flagSpellings(flag.name, flag.short).some((spelling) => text.includes(spelling));
    if (!seen) missing.push(`global --${flag.name}`);
  }

  for (const command of COMMANDS) {
    for (const flag of command.flags) {
      const seen = flagSpellings(flag.name, flag.short).some((spelling) => text.includes(spelling));
      if (!seen) missing.push(`${command.id} --${flag.name}`);
    }
  }

  expect(missing).toEqual([]);
});

test("every CLI command id is named in the CLI handbook pages", () => {
  const text = cliPagesText();
  const missing = COMMANDS.filter((command) => {
    const words = command.words.join(" ");
    return !text.includes(words) && !text.includes(command.id);
  }).map((command) => command.id);
  expect(missing).toEqual([]);
});
