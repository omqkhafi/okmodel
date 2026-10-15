/**
 * Discovery headers, content signals, the skills index, and the WebMCP guard.
 */

import { expect, test } from "bun:test";

import { agentSkillDescription, agentSkillDigest, buildAgentSkillsIndex, readAgentSkillBytes } from "./agent-skills";
import { DISCOVERY_LINK, markdownAlternateLink } from "./discovery-links";
import { WEBMCP_GUARD } from "./webmcp-guard";
import { WEBMCP_SCRIPT } from "./webmcp-script";

test("discovery links name the index, the sitemap, and the skills index", () => {
  expect(DISCOVERY_LINK).toContain('</llms.txt>; rel="describedby"; type="text/markdown"');
  expect(DISCOVERY_LINK).toContain('</sitemap.xml>; rel="sitemap"; type="application/xml"');
  expect(DISCOVERY_LINK).toContain(
    '</.well-known/agent-skills/index.json>; rel="agent-skills"; type="application/json"',
  );
  expect(markdownAlternateLink("/")).toBe('</llms.mdx/home>; rel="alternate"; type="text/markdown"');
  expect(markdownAlternateLink("/docs/reference/cli")).toBe(
    '</llms.mdx/docs/reference/cli.md>; rel="alternate"; type="text/markdown"',
  );
  expect(markdownAlternateLink("/api/search")).toBeUndefined();
});

test("the skills index pins the served bytes", () => {
  const bytes = readAgentSkillBytes();
  const index = buildAgentSkillsIndex();
  expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
  expect(index.skills).toHaveLength(1);
  const skill = index.skills[0];
  expect(skill?.name).toBe("okmodel");
  expect(skill?.type).toBe("skill-md");
  expect(skill?.url).toBe("/.well-known/agent-skills/okmodel/SKILL.md");
  expect(skill?.description).toBe(agentSkillDescription(bytes));
  expect(skill?.digest).toBe(agentSkillDigest(bytes));
  expect(skill?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(new TextDecoder().decode(bytes)).toContain(`description: ${skill?.description}`);
});

test("webmcp tools load only when the browser can register them", () => {
  expect(WEBMCP_GUARD).toContain("modelContext");
  expect(WEBMCP_GUARD).toContain('script.src="/webmcp.js"');
  expect(WEBMCP_GUARD).not.toContain("search_docs");
  for (const name of ["search_docs", "get_page", "list_pages"]) {
    expect(WEBMCP_SCRIPT).toContain(name);
  }
  expect(WEBMCP_SCRIPT).toContain("readOnlyHint: true");
});
