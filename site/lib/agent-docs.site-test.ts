/**
 * The agent files and the markdown twins share one generator.
 */

import { expect, test } from "bun:test";

import { GET as agentFile } from "../app/api/agent-files/[name]/route";
import { GET as llmsTxt } from "../app/llms.txt/route";
import { GET as pageMarkdown } from "../app/llms.mdx/docs/[[...slug]]/route";
import {
  AGENT_FILE_CHAR_LIMIT,
  agentFile as fileByName,
  agentFiles,
  approximateTokens,
  buildLlmsTxt,
  renderPageMarkdown,
} from "./agent-docs";
import { FEATURE_RULES } from "./generated/feature-rules";
import { source } from "./source";

test("llms.txt matches the spec and the route body", async () => {
  const text = buildLlmsTxt();
  expect(text.startsWith("# OKModel\n")).toBe(true);
  expect(text).toContain("\n> ");
  expect(text).toContain("\n## Optional\n");
  expect(text).not.toContain("llms-full");
  const lines = text.split("\n");
  const links = lines.filter((line) => line.startsWith("- ["));
  expect(links.length).toBeGreaterThan(100);
  for (const line of links) {
    expect(line, line).toMatch(/^- \[[^\]]+\]\([^)]+\): .+$/);
    expect(line).not.toContain("\n");
  }
  const response = await llmsTxt();
  expect(await response.text()).toBe(text);
  expect(response.headers.get("content-type")).toContain("text/markdown");
}, 60_000);

test("every agent file is listed, complete, and under the character rule", async () => {
  const index = buildLlmsTxt();
  const files = agentFiles();
  expect(files.some((file) => file.name.startsWith("llms-core"))).toBe(true);
  expect(files.some((file) => file.name === "llms-full.txt")).toBe(false);
  expect(fileByName("full")).toBeUndefined();
  for (const file of files) {
    expect(file.characters, file.name).toBe(file.body.length);
    expect(file.characters, file.name).toBeLessThanOrEqual(AGENT_FILE_CHAR_LIMIT);
    expect(file.body.length, file.name).toBeGreaterThan(0);
    expect(index, file.name).toContain(`/${file.name}`);
    expect(file.tokens).toBe(approximateTokens(file.characters));
    expect(approximateTokens(file.characters)).toBe(Math.round(file.characters / 4));
    const response = await agentFile(new Request(`http://localhost/api/agent-files/${file.name}`), {
      params: Promise.resolve({ name: file.name.replace(/^llms-/, "").replace(/\.txt$/, "") }),
    });
    expect(response.status, file.name).toBe(200);
    expect(await response.text()).toBe(file.body);
    console.log(`${file.name} chars ${String(file.characters)} tokens ${String(file.tokens)}`);
  }
  const missing = await agentFile(new Request("http://localhost/api/agent-files/full"), {
    params: Promise.resolve({ name: "full" }),
  });
  expect(missing.status).toBe(404);
}, 60_000);

test("a page markdown twin equals the generator", async () => {
  const page = source.getPage(["schema", "extensions"]);
  if (page === undefined) throw new Error("missing extensions page");
  const body = renderPageMarkdown(page.url);
  const response = await pageMarkdown(new Request("http://localhost/llms.mdx/docs/schema/extensions.md"), {
    params: Promise.resolve({ slug: ["schema", "extensions.md"] }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/markdown");
  expect(response.headers.get("vary")).toContain("Accept");
  expect(response.headers.get("link")).toContain('rel="alternate"');
  expect(await response.text()).toBe(body);
  expect(body.startsWith("Source: https://okm.omqkhafi.dev/docs/schema/extensions")).toBe(true);
  expect(body).toContain(`# ${page.data.title}`);
  const summarySource =
    typeof page.data.summary === "string" && page.data.summary.trim().length > 0
      ? page.data.summary
      : page.data.description;
  if (summarySource === undefined) throw new Error("extensions page has no summary");
  expect(body).toContain(`> ${summarySource.replace(/\s+/g, " ").trim()}`);
  const feature = page.data.feature;
  if (feature === undefined) throw new Error("extensions page has no feature");
  const rule = FEATURE_RULES[feature];
  expect(rule).toBeDefined();
  expect(body).toContain(rule?.line ?? "");
  expect(body).not.toContain("Skip to content");
  expect(body).toContain("```ts");
  expect(body).toContain("](https://okm.omqkhafi.dev/llms.mdx/docs/");
}, 60_000);

test("the errors page markdown is an index of per-code twins", () => {
  const body = renderPageMarkdown("/docs/reference/errors");
  expect(body).not.toContain("## Registry fixes");
  expect(body).toContain("[`OKM1101`](https://okm.omqkhafi.dev/docs/reference/errors/OKM1101.md)");
  expect(body.length).toBeLessThan(100_000);
  console.log(`errors index chars ${String(body.length)}`);
});

test("core names the task index and the query essentials", () => {
  const core = agentFiles().filter((file) => file.name.startsWith("llms-core"));
  const first = core[0];
  if (first === undefined) throw new Error("missing llms-core");
  expect(first.body).toContain("I want to");
  expect(first.body).toContain("/docs/start/installation");
  expect(core.some((file) => file.body.includes("Source: https://okm.omqkhafi.dev/docs/queries/transactions"))).toBe(true);
  expect(core.some((file) => file.body.includes("Source: https://okm.omqkhafi.dev/docs/reference/errors"))).toBe(false);
});
