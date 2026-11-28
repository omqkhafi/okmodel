/**
 * Markdown twin of the homepage. The same path the HTML offers, not the README install block.
 */

import { HERO_HEADLINE_LINES, HERO_SUBHEAD } from "./hero-copy";
import { absoluteDocsUrl, markdownPathForHref } from "./markdown-url";
import { readRootPackage } from "./package-meta";
import { markdownResponse } from "./markdown-response";
import { SITE_NAME, SITE_ORIGIN } from "./site-identity";

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

- [Introduction](${absoluteDocsUrl(markdownPathForHref("/docs/start"))})
- [Installation](${absoluteDocsUrl(markdownPathForHref("/docs/start/installation"))})
- [First schema](${absoluteDocsUrl(markdownPathForHref("/docs/start/first-schema"))})
- [Project structure](${absoluteDocsUrl(markdownPathForHref("/docs/start/project-structure"))})
- [Documentation](${absoluteDocsUrl(markdownPathForHref("/docs"))})
- [llms.txt](${SITE_ORIGIN}/llms.txt)
- [Changelog](${SITE_ORIGIN}/changelog)
`;
}

/**
 * 200 markdown response for the homepage twin.
 */
export function homepageMarkdownResponse(): Response {
  return markdownResponse(homepageMarkdownBody());
}
