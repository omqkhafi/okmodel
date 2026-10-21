/**
 * The AGENTS.md block names only real commands and stays under 8 KB.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { repoRoot } from "../scripts/root.js";
import { AGENTS_BLOCK_CAP, renderAgentsBlock } from "../src/tooling/agents/block.js";
import { okmMentions } from "../src/tooling/agents/mentions.js";
import { COMMAND_IDS } from "../src/tooling/cli/spec.js";

const input = { version: "0.10.0-next.47", tenancy: "row", protectedConfigured: true } as const;

test("the block matches the snapshot and stays near 2 KB", () => {
  const text = renderAgentsBlock(input);
  expect(text).toBe(readFileSync(join(repoRoot(), "tests/fixtures/agents-block.txt"), "utf8"));
  expect(renderAgentsBlock(input)).toBe(text);
  const bytes = Buffer.byteLength(text, "utf8");
  expect(bytes).toBeLessThanOrEqual(AGENTS_BLOCK_CAP);
  expect(bytes).toBeGreaterThan(1500);
  expect(bytes).toBeLessThan(2500);
  expect(text.startsWith("<!-- BEGIN OKMODEL v0.10.0-next.47 -->\n")).toBe(true);
  expect(text).toContain("<!-- END OKMODEL -->\n");
  expect(text.split("\n")[1]).toBe(
    "OKModel 0.10.0-next.47. Tenancy mode: row. Protected targets configured: yes.",
  );
  expect(text).not.toMatch(/https?:\/\//);
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
});

test("protection and tenancy are facts, and a huge block is refused", () => {
  const off = renderAgentsBlock({ ...input, tenancy: "schema", protectedConfigured: false });
  expect(off).toContain("Tenancy mode: schema.");
  expect(off).toContain("Protected targets configured: no.");
  expect(off).not.toContain("postgres://");
  expect(() => renderAgentsBlock({ ...input, tenancy: "x".repeat(9000) })).toThrow(/8/);
});

test("every okm token is a real command, and missing commands are refused", () => {
  const mentions = okmMentions(renderAgentsBlock(input));
  expect(mentions.bad).toEqual([]);
  for (const id of mentions.ids) expect(COMMAND_IDS).toContain(id);
  expect(mentions.ids).toContain("check");
  expect(mentions.ids).toContain("migrate plan");
  expect(mentions.ids).toContain("migrate check");
  expect(mentions.ids).toContain("migrate apply");
  expect(okmMentions("okm describe").bad).toEqual(["describe"]);
  expect(okmMentions("okm init").bad).toEqual([]);
  expect(okmMentions("okm init").ids).toEqual(["init"]);
  expect(COMMAND_IDS).toContain("init");
  expect(okmMentions("okm raw sync").ids).toEqual(["raw sync"]);
  expect(okmMentions("okm agents").bad).toEqual(["agents"]);
  expect(okmMentions("leave .okm files alone").bad).toEqual([]);
  expect(okmMentions("okm migrate plan then stop").ids).toEqual(["migrate plan"]);
});
