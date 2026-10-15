/**
 * `robots.txt` for the public handbook. Every crawler may fetch the site.
 * Content-Signal states the same permission for search, live AI input, and
 * training, because a more specific user-agent group does not inherit the
 * `*` group.
 */

import { SITE_ORIGIN } from "./site-identity";

/** Crawlers called out by name. `*` is written first, separately. */
const NAMED_AGENTS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Google-Extended",
  "Applebot-Extended",
] as const;

/** Permission for search indexes, live model input, and training. */
const CONTENT_SIGNAL = "Content-Signal: search=yes, ai-input=yes, ai-train=yes";

/**
 * Full robots.txt body, including the content-signal comments.
 */
export function buildRobotsTxt(): string {
  const groups = ["*", ...NAMED_AGENTS].map(
    (agent) => `User-Agent: ${agent}\n${CONTENT_SIGNAL}\nAllow: /\n`,
  );
  return [
    "# search: building a search index and providing search results. Search does not include AI-generated summaries.",
    "# ai-input: inputting content into an AI model at query time, including retrieval and grounding.",
    "# ai-train: training or fine-tuning AI models.",
    "",
    ...groups,
    `Host: ${SITE_ORIGIN}`,
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}
