/**
 * Markdown twin of the homepage. The same path the HTML offers, not the README install block.
 */

import { HERO_HEADLINE_LINES, HERO_SUBHEAD } from "./hero-copy";
import { readRootPackage } from "./package-meta";
import { markdownResponse } from "./markdown-response";
import { SITE_NAME } from "./site-identity";

/**
 * Markdown body for `/` when Accept prefers markdown.
 */
export function homepageMarkdownBody(): string {
  const install = `bun add ${readRootPackage().name}`;
  return `# ${SITE_NAME}

${HERO_HEADLINE_LINES.join(" ")}

${HERO_SUBHEAD}

\`\`\`sh
${install}
\`\`\`

- [Let's start](/docs/start)
- [Basic Usage](/docs/start/basic-usage)
- [Documentation](/docs)
- [llms.txt](/llms.txt)
- [Changelog](/changelog)
`;
}

/**
 * 200 markdown response for the homepage twin.
 */
export function homepageMarkdownResponse(): Response {
  return markdownResponse(homepageMarkdownBody());
}
