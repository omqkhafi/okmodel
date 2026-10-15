/**
 * HTTP `Link` headers that advertise the handbook to an agent that never
 * parses HTML. Relations follow the IANA link registry, plus `agent-skills`
 * from the Agent Skills discovery draft.
 */

import { markdownTwinPath } from "./markdown-negotiate";

/** Site-wide links. One RFC 8288 field value, comma-separated. */
export const DISCOVERY_LINK = [
  '</llms.txt>; rel="describedby"; type="text/markdown"; title="Site index for LLMs"',
  '</sitemap.xml>; rel="sitemap"; type="application/xml"',
  '</.well-known/agent-skills/index.json>; rel="agent-skills"; type="application/json"',
].join(", ");

/**
 * Alternate markdown representation of one HTML path.
 *
 * @param pathname - Request pathname, no query
 */
export function markdownAlternateLink(pathname: string): string | undefined {
  const twin = markdownTwinPath(pathname);
  if (twin === undefined) return undefined;
  return `<${twin}>; rel="alternate"; type="text/markdown"`;
}
