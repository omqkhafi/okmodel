/**
 * Markdown twin of the homepage. The same path the HTML offers, not the README install block.
 */

import { readRootPackage, readTagline } from "./package-meta";
import { markdownResponse } from "./markdown-response";
import { SITE_NAME } from "./site-identity";

/**
 * Markdown body for `/` when Accept prefers markdown.
 */
export function homepageMarkdownBody(): string {
  const install = `bun add ${readRootPackage().name}`;
  return `# ${SITE_NAME}

The schema is the source.

${readTagline()}

\`\`\`sh
${install}
\`\`\`

- [Install](/docs/start/install)
- [First query](/docs/start/query)
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
