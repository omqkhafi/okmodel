/**
 * Markdown twin of the placeholder homepage.
 */

import { readTagline, readmeInstallSnippet } from "./package-meta";
import { markdownResponse } from "./markdown-response";
import { SITE_NAME } from "./site-identity";

/**
 * Markdown body for `/` when Accept prefers markdown.
 */
export function homepageMarkdownBody(): string {
  return `# ${SITE_NAME}

${readTagline()}

\`\`\`sh
${readmeInstallSnippet()}
\`\`\`

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
